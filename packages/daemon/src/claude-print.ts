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
    const { execFile } = require("child_process") as typeof import("child_process");
    const cmd = findClaudeCmd();
    const args = [
      "--print", "--output-format", "stream-json",
      "--verbose", "--dangerously-skip-permissions",
    ];
    if (sessionId) args.push("--resume", sessionId);

    const promptFile = join(process.cwd(), ".slock", "system-prompt.md");
    if (existsSync(promptFile)) {
      args.push("--append-system-prompt-file", promptFile);
    }
    args.push(prompt);

    console.log("[ClaudePrint] Calling Claude...");

    execFile(cmd, args, {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000,
    }, (err: Error | null, stdout: string, stderr: string) => {
      if (stderr) console.error("[ClaudePrint] stderr:", stderr.slice(0, 200));
      if (err) { console.error("[ClaudePrint] error:", err.message); }

      let reply = "";
      let newSid: string | undefined;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line.trim());
          if (ev.type === "system" && ev.session_id) newSid = ev.session_id as string;
          if (ev.type === "result" && ev.result) reply = ev.result as string;
        } catch {}
      }
      resolve({ reply: reply || null as any, sessionId: newSid });
    });
  });
}

export function isClaudeAvailable(): boolean {
  return findClaudeCmd() !== "claude.cmd" || existsSync("claude.cmd");
}
