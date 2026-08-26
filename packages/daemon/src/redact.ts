/**
 * P1.15：token 脱敏——观察帧 / terminal log / WS 围观流共用的出口清洗。
 * （评估报告 docs/2026-08-24/01 §2.4：agent 读出自己的 scoped token 后 echo 到输出，
 * token 会随观察帧进 web 面板 / WS 审计流、随终端镜像落盘 terminal log。）
 *
 * 明文 token 只允许存在于：token 文件（0600）、进程内存、server 端 sha256 哈希。
 * 一切「离开 daemon 控制面」的文本出口统一过 redactSecrets / redactDeep。
 *
 * 模式对齐 server 侧签发格式（server/src/routes/agents-credentials.ts）：
 * `sk_agent_` + 32 位 [a-z0-9]；`sk_machine_` 为账号级 machine token，一并脱敏
 * （防御性——它本不应出现在 agent 输出里，但日志/面板绝不是它该出现的地方）。
 */

const SECRET_PATTERN = /\bsk_(agent|machine)_[a-z0-9]{4,}\b/g;

/** 文本中的 scoped/machine token 替换为 `sk_agent_***`（保留前缀，便于辨识脱敏对象类型） */
export const redactSecrets = (text: string): string => text.replace(SECRET_PATTERN, "sk_$1_***");

/**
 * 结构化 payload 的递归脱敏（观察帧 toolInput 等）。只处理 JSON 形态
 * （string / array / plain object），其他原样返回；不修改入参（返回新对象）。
 */
export const redactDeep = <T>(value: T): T => {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
};
