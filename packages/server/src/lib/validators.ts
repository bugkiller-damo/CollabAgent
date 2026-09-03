/** 密码强度校验 */
export function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(pw)) return "密码需包含字母";
  if (!/[0-9]/.test(pw)) return "密码需包含数字";
  return null;
}

/**
 * 消息正文长度上限（字符数）。P1.33：此前 messages.content（TEXT）应用层无界，
 * 唯一上限是 Fastify 全局 bodyLimit（默认 1MiB）——超长消息撑大响应体/搜索索引/广播帧。
 * 人类/agent 双侧 send 与 edit 统一执行；agent 长报告超出时应拆条发送。
 */
export const MAX_MESSAGE_CONTENT_LEN = 10_000;
