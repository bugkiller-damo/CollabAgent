export type Strength = "weak" | "medium" | "strong";

// 规则：弱 <8；中 8-11 且含字母+数字；强 ≥12 且含大小写+数字+符号
// 与 packages/web/src/components/PasswordStrength.tsx 中的 scorePassword 逐字对齐
export function scorePassword(pw: string): Strength {
  if (!pw) return "weak";
  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSymbol = /[^a-zA-Z0-9]/.test(pw);
  if (pw.length >= 12 && hasLower && hasUpper && hasDigit && hasSymbol) return "strong";
  if (pw.length >= 8 && /[a-zA-Z]/.test(pw) && hasDigit) return "medium";
  return "weak";
}
