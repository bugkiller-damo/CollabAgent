#!/usr/bin/env node
/**
 * O20：pre-commit 敏感文件拦截（lefthook 调用，参数 = staged 文件列表）。
 *
 * 两道闸：
 * 1. 文件名黑名单：cookies.txt / .env* / *.pem / *.key / curl（根目录 0 字节垃圾的历史教训）
 * 2. 内容模式：sk_agent_ / sk_machine_ token 字面量、PEM 私钥块
 *
 * 退出码 1 = 阻断提交并打印命中清单；0 = 通过。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const NAME_BLOCKLIST = new Set(["cookies.txt", "curl"]);
const NAME_PATTERNS = [/^\.env(\..*)?$/i, /\.(pem|key|p12|pfx)$/i];
const CONTENT_PATTERNS = [/sk_(agent|machine)_[A-Za-z0-9]+/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

const staged = process.argv.slice(2);
if (staged.length === 0) process.exit(0);

const hits = [];
for (const file of staged) {
  const name = basename(file);
  if (NAME_BLOCKLIST.has(name)) {
    hits.push(`${file}  （文件名黑名单：${name}）`);
    continue;
  }
  if (NAME_PATTERNS.some((re) => re.test(name))) {
    hits.push(`${file}  （敏感文件名模式）`);
    continue;
  }
  // 测试夹具允许假 runtime token；文件名黑名单仍生效。
  // 本脚本自身含模式字面量，跳过内容扫描以免自击。
  const posix = file.replace(/\\/g, "/");
  if (name === "check-sensitive-files.mjs" || /\.test\.[cm]?[jt]sx?$/i.test(name) || /(^|\/)test(\/)/.test(posix)) {
    continue;
  }
  // 内容扫描：只读前 256KB，跳过二进制/不存在（删除中的文件）
  let head = "";
  try {
    if (!existsSync(file)) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // 二进制不扫
    head = buf.subarray(0, 256 * 1024).toString("utf-8");
  } catch {
    continue;
  }
  for (const re of CONTENT_PATTERNS) {
    const m = head.match(re);
    if (m) {
      hits.push(`${file}  （内容含 ${m[0].slice(0, 16)}…）`);
      break;
    }
  }
}

if (hits.length > 0) {
  console.error("✗ 检测到敏感文件/内容，已阻断提交：\n  " + hits.join("\n  "));
  console.error("  如确认是误报，请调整 scripts/check-sensitive-files.mjs 的规则。");
  process.exit(1);
}
process.exit(0);
