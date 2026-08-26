import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyAgentEnv } from "./agent-env-whitelist.js";
import { asClaudeStreamEvent, type ClaudeStreamEvent, isPlainObject } from "./claude-stream.js";
import { getClaudePermissionArgs } from "./command-presets.js";

function findClaudeCmd(): string {
  const appData = process.env.APPDATA || join("C:/Users", process.env.USERNAME || "Default", "AppData/Roaming");
  const candidates = [join(appData, "npm", "claude.cmd"), "C:/Program Files/Claude Code/claude.cmd", "claude.cmd"];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "claude.cmd";
}

export interface ClaudePrintResult {
  reply: string | null;
  sessionId?: string;
}

// 路径/参数含空格时加引号（shell 模式下需要）
function q(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

export function claudePrint(
  prompt: string,
  sessionId?: string,
  systemPromptFile?: string,
  extraEnv?: Record<string, string>,
  cwd?: string,
  onStreamEvent?: (ev: ClaudeStreamEvent) => void,
): Promise<ClaudePrintResult> {
  return new Promise((resolve) => {
    const cmd = findClaudeCmd();
    // O12：显式工具白名单替代 --dangerously-skip-permissions（见 command-presets.ts）
    const args = ["--print", "--output-format", "stream-json", "--verbose", ...getClaudePermissionArgs()];
    if (sessionId) args.push("--resume", sessionId);

    const promptFile = systemPromptFile || join(process.cwd(), ".slock", "system-prompt.md");
    if (existsSync(promptFile)) {
      args.push("--append-system-prompt-file", promptFile);
    }
    // prompt 不作为参数（避免 Windows .cmd 转义 / EINVAL），改用 stdin

    console.log("[ClaudePrint] Calling Claude...");

    // Windows 下 .cmd 必须经 shell 启动，否则 spawn EINVAL；用引号包裹含空格的命令/路径
    const fullCmd = [q(cmd), ...args.map(q)].join(" ");
    const child = spawn(fullCmd, {
      cwd: cwd || process.cwd(),
      shell: true,
      windowsHide: true,
      // A2 / P0.4：默认 whitelist；SLOCK_ENV_INHERIT=1 才全量继承。
      env: applyAgentEnv(extraEnv || {}, "ClaudePrint"),
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 120000);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.error("[ClaudePrint] spawn error:", err.message);
      resolve({ reply: null, sessionId: undefined });
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (stderr) console.error("[ClaudePrint] stderr:", stderr.slice(0, 200));
      let reply = "";
      let newSid: string | undefined;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = asClaudeStreamEvent(JSON.parse(line.trim()));
          if (!ev) continue;
          try {
            onStreamEvent?.(ev);
          } catch {
            /* callback 不阻断 print */
          }
          if (ev.type === "system" && ev.session_id) newSid = ev.session_id;
          if (ev.type === "result" && typeof ev.result === "string") reply = ev.result;
          if (ev.type === "assistant") {
            const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
            for (const b of blocks) {
              if (isPlainObject(b) && b.type === "text" && typeof b.text === "string") reply += b.text;
            }
          }
        } catch {}
      }
      resolve({ reply: reply || null, sessionId: newSid });
    });

    // 通过 stdin 传入 prompt
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
}

export function isClaudeAvailable(): boolean {
  return findClaudeCmd() !== "claude.cmd" || existsSync("claude.cmd");
}
