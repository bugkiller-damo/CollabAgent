/**
 * 子进程 env 默认清空 + 显式白名单（改造方案 A2，见
 * docs/2026-08-18/03-slock-modification-plan.md §1.A2；评估报告 P0.4
 * 于 2026-08-25 将默认从 warn-only 翻正为 whitelist）。
 *
 * 问题：三处 spawn（PTY / PersistentClaude / claudePrint）历来用
 * `{ ...process.env, ...overrides }` 全量继承 daemon 环境——daemon 进程里有
 * server apiKey 等高敏感变量，会随 env 流向 agent 子进程及其再派生的
 * MCP 子进程（同机进程 env 可被跨进程读取）。buzz 侧的纪律是 env_clear() +
 * WINDOWS_SHELL_RESOLUTION_ENV 显式转发（见 02 对比文档 §1.4），本模块对齐。
 *
 * 模式：
 * - 默认 whitelist：只转发 BASE_WHITELIST + 已存在的代理键 + 调用方 overrides。
 * - SLOCK_ENV_INHERIT=1：显式回到全量继承（排障回退；明文 token 仍剔除）。
 * - SLOCK_ENV_WHITELIST=1：兼容别名，与默认同为 whitelist（A2 灰度期开关，现为 no-op）。
 */

/** Windows 上 spawn claude.cmd / node / git 能正常工作的最小键集。
 *  每条键的理由写在注释里；新增键前先确认工具确实需要它（可用 `diffAgentEnv` 对照）。 */
const BASE_WHITELIST = new Set([
  "SYSTEMROOT", // cmd.exe / 大量 Win32 API 的定位锚，缺了 shell 直接起不来
  "SYSTEMDRIVE", // 部分安装器/路径解析引用
  "WINDIR", // 同 SYSTEMROOT 的另一约定名，老工具认这个
  "COMSPEC", // cmd.exe 路径，shell:true spawn 依赖
  "PATHEXT", // .cmd/.bat 可执行扩展名解析（claude.cmd 靠它）
  "PATH", // 可执行文件查找
  "APPDATA", // npm prefix（claude.cmd 所在）、claude 配置目录
  "LOCALAPPDATA", // 工具缓存目录
  "USERPROFILE", // HOME 的 Windows 等价物，git/ssh/node 都用
  "USERNAME", // 部分工具日志/路径拼接
  "HOMEDRIVE", // 兼容少数直接引用的工具
  "HOMEPATH", // 同上
  "TEMP", // 临时目录
  "TMP", // 同上（两个约定名都存在）
  "NUMBER_OF_PROCESSORS", // 并行度探测
  "OS", // 平台判定（Windows_NT）
  "PROGRAMFILES", // 装在 Program Files 下的工具自定位
  "PROGRAMFILES(X86)", // 同上（32 位）
  "PROGRAMW6432", // 同上（64 位重定向）
  "PROGRAMDATA", // 机器级配置目录
  "PUBLIC", // 公共目录，少数安装器引用
]);

/** 代理变量：仅当 daemon 自身 env 里存在才转发（公司网络/本地代理场景） */
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

export type AgentEnvMode = "whitelist" | "inherit";

/** 每次调用时读 env（仓内惯例：测试在 beforeEach 里改 process.env 即可生效） */
export const resolveAgentEnvMode = (): AgentEnvMode => {
  if (process.env.SLOCK_ENV_INHERIT === "1") return "inherit";
  return "whitelist";
};

/**
 * 构造白名单 env。Windows env 键大小写不敏感（Node 层已归一化，但防御性
 * 按大写比较），overrides 最后合并（SLOCK_* 由调用方显式给）。
 * O11 兜底：无论 overrides 带不带，结果里绝不含 SLOCK_AGENT_TOKEN 明文。
 */
export const buildAgentEnv = (
  overrides: Record<string, string>,
  fullEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(fullEnv)) {
    if (value === undefined) continue;
    if (BASE_WHITELIST.has(key.toUpperCase())) env[key] = value;
  }
  for (const key of PROXY_KEYS) {
    const v = fullEnv[key];
    if (v !== undefined) env[key] = v;
  }
  Object.assign(env, overrides);
  // O11：明文 token 不进子进程 env（经 token 文件传递，见 agent-token-file.ts）。
  // 正常路径调用方不会传，这里防御性剔除。
  delete env.SLOCK_AGENT_TOKEN;
  return env;
};

/** 对照用：返回「白名单模式下会被剔除」的键名列表（只返回键名，不碰值——值可能敏感） */
export const diffAgentEnv = (
  whitelisted: Record<string, string>,
  fullEnv: NodeJS.ProcessEnv = process.env,
): string[] => {
  const dropped: string[] = [];
  for (const key of Object.keys(fullEnv)) {
    if (!(key in whitelisted)) dropped.push(key);
  }
  return dropped.sort();
};

/**
 * 三处 spawn 的统一入口：按模式返回最终给子进程的 env。
 * 默认 whitelist；`SLOCK_ENV_INHERIT=1` 才全量继承（明文 token 仍剔除）。
 */
export const applyAgentEnv = (overrides: Record<string, string>, label: string): Record<string, string> => {
  const mode = resolveAgentEnvMode();
  if (mode === "inherit") {
    console.warn(
      `[EnvWhitelist] (${label}) SLOCK_ENV_INHERIT=1: passing full daemon env (SLOCK_AGENT_TOKEN still stripped)`,
    );
    const full: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) full[key] = value;
    }
    Object.assign(full, overrides);
    // O11：继承模式是排障回退，不是安全回退——明文 token 仍不进子进程。
    delete full.SLOCK_AGENT_TOKEN;
    return full;
  }
  return buildAgentEnv(overrides);
};
