import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

function findClaudeCmd(): string {
  const appData = process.env.APPDATA || join("C:/Users", process.env.USERNAME || "Default", "AppData/Roaming");
  const candidates = [
    join(appData, "npm", "claude.cmd"),
    "C:/Program Files/Claude Code/claude.cmd",
    "claude.cmd",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "claude.cmd";
}

export interface ClaudePrintResult {
  reply: string;
  sessionId?: string;
}

export function claudePrint(prompt: string, sessionId?: string): Promise<ClaudePrintResult> {
  return new Promise((resolve) => {
    const cmd = findClaudeCmd();
    const args = [
      "--print", "--output-format", "stream-json",
      "--verbose", "--dangerously-skip-permissions",
      "--model", "sonnet",
    ];
    if (sessionId) args.push("--resume", sessionId);

    const promptFile = join(process.cwd(), ".slock", "system-prompt.md");
    if (existsSync(promptFile)) {
      args.push("--append-system-prompt-file", promptFile);
    }
    args.push(prompt);

    console.log("[ClaudePrint] Starting:", cmd, args.slice(0, -1).join(" "), '"<prompt>"');

    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code: number | null) => {
      if (stderr) console.error("[ClaudePrint] stderr:", stderr.slice(0, 200));

      let reply = "";
      let newSid: string | undefined;
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
            newSid = ev.session_id as string;
          }
          if (ev.type === "result" && ev.result) {
            reply = ev.result as string;
          }
        } catch {}
      }

      if (!reply && code !== 0) {
        reply = "(no response)";
      }
      resolve({ reply, sessionId: newSid });
    });
  });
}

export function isClaudeAvailable(): boolean {
  return findClaudeCmd() !== "claude.cmd" || existsSync("claude.cmd");
}
