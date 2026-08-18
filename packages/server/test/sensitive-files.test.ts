import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// O20：敏感文件拦截脚本的进程级单测（真 spawn node 跑脚本，验证退出码语义）
// 注：该脚本不走 ES import——它是 lefthook 的 pre-commit 外部进程入口。

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "check-sensitive-files.mjs");
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function run(files: string[]): number {
  const r = spawnSync(process.execPath, [SCRIPT, ...files], { encoding: "utf-8" });
  return r.status ?? -1;
}

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "slock-sensitive-"));
  tmpDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("check-sensitive-files（O20）", () => {
  it("文件名黑名单：cookies.txt / curl / .env / *.pem 直接阻断", () => {
    expect(run([tmpFile("cookies.txt", "# netscape")])).toBe(1);
    expect(run([tmpFile("curl", "")])).toBe(1);
    expect(run([tmpFile(".env", "OK=1")])).toBe(1);
    expect(run([tmpFile(".env.production", "OK=1")])).toBe(1);
    expect(run([tmpFile("server.pem", "x")])).toBe(1);
  });

  it("内容含 sk_agent_/sk_machine_ token 或 PEM 私钥块 → 阻断", () => {
    // 拼接构造样本，避免本测试文件自身命中 pre-commit 拦截规则
    const agentTok = "sk_" + "agent_" + "abcdefghij123456";
    const machineTok = "sk_" + "machine_" + "zzzzzzzz";
    expect(run([tmpFile("note.md", `token: ${agentTok}`)])).toBe(1);
    expect(run([tmpFile("note.md", machineTok)])).toBe(1);
    const pem = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
    expect(run([tmpFile("k.txt", pem)])).toBe(1);
  });

  it("正常文件通过；不存在的文件（删除中）跳过", () => {
    expect(run([tmpFile("readme.md", "# hello"), tmpFile("a.ts", "const x = 1;")])).toBe(0);
    expect(run([join(tmpDirs[0] ?? tmpdir(), "deleted-file.ts")])).toBe(0);
  });

  it("无参数（空暂存区）直接通过", () => {
    expect(run([])).toBe(0);
  });
});
