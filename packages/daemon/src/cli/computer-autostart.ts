/**
 * `slock computer install/uninstall` —— 登录自启注册（S3 常驻形态）。
 *
 * 三平台落地件（注册的动作 = 登录时跑 `node <cli.cjs> computer start /<name> --detach`）：
 *   Windows : schtasks /create /tn SlockComputer-<name> /sc onlogon /tr "..."
 *   macOS   : ~/Library/LaunchAgents/ai.slock.computer.<name>.plist + launchctl load -w
 *   Linux   : ~/.config/systemd/user/slock-computer-<name>.service + systemctl --user enable --now
 *
 * 设计：
 * - autostartPlan 是纯函数（平台/家目录/路径全注入），单测不碰系统；
 * - install/uninstall/installed 只做薄执行；任何一步失败输出手工指引，
 *   不静默、不硬崩（用户机器环境千差万别，注册失败比注册错位置好排查）。
 * - cliPath 只收 cli.cjs 等 node 直跑入口——登录时没有 pnpm/tsx 上下文，
 *   tsx dev 形态不提供 install（dev 机器用 start 就行）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix } from "node:path";

export interface AutostartPlan {
  kind: "schtasks" | "launchd" | "systemd" | "unsupported";
  /** 任务/服务标识（SlockComputer-<name> / ai.slock.computer.<name> / slock-computer-<name>） */
  id: string;
  /** 登录时实际执行的命令行 */
  runCmd: string;
  /** 注册要写的文件（plist/unit）；schtasks 不需要文件 */
  filePath?: string;
  fileContent?: string;
  /** 注册/注销/查询命令（spawnSync argv，不含可执行名） */
  installArgv?: { bin: string; args: string[] }[];
  uninstallArgv?: { bin: string; args: string[] }[];
  /** installed 探测：优先查文件，schtasks 走 query 命令 */
  probe?: { file?: string; bin?: string; args?: string[] };
}

const quoteArg = (p: string) => `"${p}"`;

export function autostartPlan(
  name: string,
  nodePath: string,
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): AutostartPlan {
  const runCmd = `${quoteArg(nodePath)} ${quoteArg(cliPath)} computer start "/${name}" --detach`;
  // spec 用目标平台分隔符拼（测试可在任意宿主模拟 darwin/linux）
  const joinT = platform === "win32" ? (...segs: string[]) => segs.join("\\") : posix.join;

  if (platform === "win32") {
    const id = `SlockComputer-${name}`;
    return {
      kind: "schtasks",
      id,
      runCmd,
      // schtasks /tr 的嵌套引号转义：整体再包一层 "，内部 " → \"
      installArgv: [
        {
          bin: "schtasks",
          args: ["/create", "/tn", id, "/sc", "onlogon", "/tr", `"${runCmd.replace(/"/g, '\\"')}"`, "/f"],
        },
      ],
      uninstallArgv: [{ bin: "schtasks", args: ["/delete", "/tn", id, "/f"] }],
      probe: { bin: "schtasks", args: ["/query", "/tn", id] },
    };
  }

  if (platform === "darwin") {
    const id = `ai.slock.computer.${name}`;
    const filePath = joinT(home, "Library", "LaunchAgents", `${id}.plist`);
    const args = [nodePath, cliPath, "computer", "start", `/${name}`, "--detach"]
      .map((a) => `      <string>${a}</string>`)
      .join("\n");
    const fileContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${id}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
  </dict>
</plist>
`;
    return {
      kind: "launchd",
      id,
      runCmd,
      filePath,
      fileContent,
      installArgv: [{ bin: "launchctl", args: ["load", "-w", filePath] }],
      uninstallArgv: [{ bin: "launchctl", args: ["unload", "-w", filePath] }],
      probe: { file: filePath },
    };
  }

  if (platform === "linux") {
    const id = `slock-computer-${name}`;
    const unitDir = joinT(home, ".config", "systemd", "user");
    const filePath = joinT(unitDir, `${id}.service`);
    const fileContent = `[Unit]
Description=Slock computer daemon (${name})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${cliPath} computer start /${name} --detach
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    return {
      kind: "systemd",
      id,
      runCmd,
      filePath,
      fileContent,
      installArgv: [
        { bin: "systemctl", args: ["--user", "daemon-reload"] },
        { bin: "systemctl", args: ["--user", "enable", "--now", `${id}.service`] },
      ],
      uninstallArgv: [
        { bin: "systemctl", args: ["--user", "disable", "--now", `${id}.service`] },
        { bin: "systemctl", args: ["--user", "daemon-reload"] },
      ],
      probe: { file: filePath },
    };
  }

  return { kind: "unsupported", id: `slock-computer-${name}`, runCmd };
}

const runCmd = (bin: string, args: string[]): { ok: boolean; output: string } => {
  const r = spawnSync(bin, args, { encoding: "utf-8", windowsHide: true });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: !r.error && r.status === 0, output };
};

/** 是否已注册自启——供 status 展示与 install 幂等短路 */
export function autostartInstalled(name: string, plan: AutostartPlan = autostartPlan(name, "", "")): boolean {
  const probe = plan.probe;
  if (!probe) return false;
  if (probe.file) return existsSync(probe.file);
  if (probe.bin && probe.args) return runCmd(probe.bin, probe.args).ok;
  return false;
}

export function installAutostart(name: string, nodePath: string, cliPath: string) {
  const plan = autostartPlan(name, nodePath, cliPath);
  if (plan.kind === "unsupported") {
    return {
      ok: false,
      code: "platform-unsupported",
      data: { name, platform: process.platform, manual: `register this at login: ${plan.runCmd}` },
    };
  }
  const steps: string[] = [];
  if (autostartInstalled(name, plan)) {
    steps.push(`${plan.id}: already registered (re-registering to refresh command)`);
  }
  if (plan.filePath && plan.fileContent) {
    try {
      mkdirSync(dirname(plan.filePath), { recursive: true });
      writeFileSync(plan.filePath, plan.fileContent);
      steps.push(`wrote ${plan.filePath}`);
    } catch (err) {
      return {
        ok: false,
        code: "autostart-file-failed",
        data: { name, file: plan.filePath, error: String(err), manual: plan.runCmd },
      };
    }
  }
  for (const step of plan.installArgv ?? []) {
    const r = runCmd(step.bin, step.args);
    if (!r.ok) {
      return {
        ok: false,
        code: "autostart-register-failed",
        data: {
          name,
          id: plan.id,
          failed: `${step.bin} ${step.args.join(" ")}`,
          output: r.output,
          manual: plan.runCmd,
        },
      };
    }
    steps.push(`${step.bin} ${step.args.join(" ")}`);
  }
  return { ok: true, data: { name, id: plan.id, kind: plan.kind, runCmd: plan.runCmd, steps } };
}

export function removeAutostart(name: string) {
  // 探测用空 nodePath/cliPath——plan 只取 id/kind/probe/uninstallArgv
  const plan = autostartPlan(name, "", "");
  if (plan.kind === "unsupported") {
    return { ok: false, code: "platform-unsupported", data: { name, platform: process.platform } };
  }
  if (!autostartInstalled(name, plan)) {
    return { ok: true, data: { name, id: plan.id, removed: false, note: "not registered" } };
  }
  const steps: string[] = [];
  for (const step of plan.uninstallArgv ?? []) {
    const r = runCmd(step.bin, step.args);
    if (!r.ok) {
      return {
        ok: false,
        code: "autostart-remove-failed",
        data: { name, id: plan.id, failed: `${step.bin} ${step.args.join(" ")}`, output: r.output },
      };
    }
    steps.push(`${step.bin} ${step.args.join(" ")}`);
  }
  if (plan.filePath) {
    try {
      rmSync(plan.filePath, { force: true });
      steps.push(`removed ${plan.filePath}`);
    } catch {
      /* best-effort */
    }
  }
  return { ok: true, data: { name, id: plan.id, removed: true, steps } };
}
