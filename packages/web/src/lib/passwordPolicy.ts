/**
 * 密码策略前端镜像（P1-14）：与 server `validators.ts` validatePassword 同源同序同文案——
 * ≥8 位 + 含字母 + 含数字。三处消费：RegisterPage / ForgotPasswordPage / ProfileSettings，
 * 单点定义防策略漂移（P1-14 根因即 ForgotPasswordPage ≥6 与 server 脱钩）。
 * server 仍是唯一强制点（400 文案经 apiClient 透传），此处预检只为消除「客户端过、server 拒」。
 */
export function validatePasswordPolicy(pw: string): string | null {
  if (pw.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(pw)) return "密码需包含字母";
  if (!/[0-9]/.test(pw)) return "密码需包含数字";
  return null;
}
