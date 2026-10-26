import { describe, expect, it } from "vitest";
import { autostartPlan } from "../src/cli/computer-autostart.js";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const CLI = "D:\\apps\\slock\\cli.cjs";

describe("autostartPlan", () => {
  it("win32 → schtasks onlogon；/tr 整体包引号、内引号转义；id 含 server 名", () => {
    const p = autostartPlan("bugkillers-test-server", NODE, CLI, "win32", "C:\\Users\\u");
    expect(p.kind).toBe("schtasks");
    expect(p.id).toBe("SlockComputer-bugkillers-test-server");
    expect(p.runCmd).toContain(`"${NODE}" "${CLI}" computer start "/bugkillers-test-server" --detach`);
    const tr = p.installArgv![0]!.args[6]!;
    expect(tr.startsWith('"') && tr.endsWith('"')).toBe(true);
    expect(tr).toContain('\\"');
    expect(p.uninstallArgv![0]!.args).toContain("/delete");
    expect(p.probe?.bin).toBe("schtasks");
  });

  it("darwin → LaunchAgent plist；RunAtLoad+Background；probe 查文件", () => {
    const p = autostartPlan("srv", "/usr/local/bin/node", "/opt/slock/cli.cjs", "darwin", "/Users/u");
    expect(p.kind).toBe("launchd");
    expect(p.filePath).toBe("/Users/u/Library/LaunchAgents/ai.slock.computer.srv.plist");
    expect(p.fileContent).toContain("<key>RunAtLoad</key>");
    expect(p.fileContent).toContain("<string>/opt/slock/cli.cjs</string>");
    expect(p.fileContent).toContain("<string>--detach</string>");
    expect(p.installArgv![0]!.bin).toBe("launchctl");
    expect(p.probe?.file).toBe(p.filePath);
  });

  it("linux → systemd --user unit；enable --now；Restart=on-failure", () => {
    const p = autostartPlan("srv", "/usr/bin/node", "/opt/slock/cli.cjs", "linux", "/home/u");
    expect(p.kind).toBe("systemd");
    expect(p.filePath).toBe("/home/u/.config/systemd/user/slock-computer-srv.service");
    expect(p.fileContent).toContain("ExecStart=/usr/bin/node /opt/slock/cli.cjs computer start /srv --detach");
    expect(p.fileContent).toContain("WantedBy=default.target");
    expect(p.installArgv!.some((s) => s.args.includes("enable"))).toBe(true);
    expect(p.uninstallArgv![0]!.args).toContain("disable");
  });

  it("unsupported 平台 → kind=unsupported 且带 manual runCmd", () => {
    const p = autostartPlan("srv", "node", "cli.cjs", "freebsd", "/home/u");
    expect(p.kind).toBe("unsupported");
    expect(p.runCmd).toContain("computer start");
  });
});
