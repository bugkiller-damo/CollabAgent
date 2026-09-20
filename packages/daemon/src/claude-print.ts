import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyAgentEnv } from "./agent-env-whitelist.js";
import { asClaudeStreamEvent, type ClaudeStreamEvent, isPlainObject } from "./claude-stream.js";
import { getClaudePermissionArgs } from "./command-presets.js";
import { resolveClaudeBinary } from "./command-resolver.js";
import { slockDir } from "./private-dir.js";

export interface ClaudePrintResult {
  reply: string | null;
  sessionId?: string;
}

// 路径/参数含空格时加引号（shell 模式下需要）
function q(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

// A1.2：Windows 的 .cmd/.bat shim 与裸命令名必须经 shell 启动；已解析到真实
// 可执行文件（或非 Windows）时直接 spawn，避开 cmd.exe 引号转义层。
const needsShell = (cmd: string): boolean =>
  process.platform === "win32" && (cmd === "claude" || /\.(cmd|bat)$/i.test(cmd));

export function claudePrint(
  prompt: string,
  sessionId?: string,
  systemPromptFile?: string,
  extraEnv?: Record<string, string>,
  cwd?: string,
  onStreamEvent?: (ev: ClaudeStreamEvent) => void,
  model?: string,
): Promise<ClaudePrintResult> {
  return new Promise((resolve) => {
    const cmd = resolveClaudeBinary();
    // O12：显式工具白名单替代 --dangerously-skip-permissions（见 command-presets.ts）
    const args = ["--print", "--output-format", "stream-json", "--verbose", ...getClaudePermissionArgs()];
    if (sessionId) args.push("--resume", sessionId);
    // A1.1：与 persistent 路径同一校验，防注入/坏值。
    if (model && /^[a-z0-9._-]+$/i.test(model)) {
      args.push("--model", model);
      console.log(`[ClaudePrint] spawning with --model ${model}`);
    } else if (model) {
      console.warn(`[ClaudePrint] ignoring invalid --model value: ${model}`);
    }

    const promptFile = systemPromptFile || join(slockDir(), "system-prompt.md");
    if (existsSync(promptFile)) {
      args.push("--append-system-prompt-file", promptFile);
    }
    // prompt 不作为参数（避免 Windows .cmd 转义 / EINVAL），改用 stdin

    console.log("[ClaudePrint] Calling Claude...");

    const childEnv = applyAgentEnv(extraEnv || {}, "ClaudePrint");
    const childCwd = cwd || process.cwd();
    const child = needsShell(cmd)
      ? spawn([q(cmd), ...args.map(q)].join(" "), {
          cwd: childCwd,
          shell: true,
          windowsHide: true,
          // A2 / P0.4：默认 whitelist；SLOCK_ENV_INHERIT=1 才全量继承。
          env: childEnv,
        })
      : spawn(cmd, args, {
          cwd: childCwd,
          windowsHide: true,
          env: childEnv,
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
  // A1.2：解析到真实路径即视为可用；裸 "claude" 表示各级探测均未命中。
  return resolveClaudeBinary() !== "claude";
}
