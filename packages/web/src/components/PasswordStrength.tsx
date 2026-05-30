export type Strength = "weak" | "medium" | "strong";

// 规则：弱 <8；中 8-11 且含字母+数字；强 ≥12 且含大小写+数字+符号
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

const CONFIG: Record<Strength, { label: string; color: string; bars: number }> = {
  weak: { label: "弱", color: "bg-red-500", bars: 1 },
  medium: { label: "中", color: "bg-yellow-500", bars: 2 },
  strong: { label: "强", color: "bg-green-500", bars: 3 },
};

export function PasswordStrength({ password }: { password: string }) {
  if (!password) return null;
  const s = scorePassword(password);
  const cfg = CONFIG[s];
  return (
    <div className="mt-1">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className={"h-1 flex-1 rounded " + (i < cfg.bars ? cfg.color : "bg-gray-300 dark:bg-gray-600")} />
        ))}
      </div>
      <div className={"text-xs mt-0.5 " + (s === "weak" ? "text-red-500" : s === "medium" ? "text-yellow-600 dark:text-yellow-500" : "text-green-600 dark:text-green-500")}>
        密码强度：{cfg.label}
        {s === "weak" && <span className="text-gray-400"> · 建议至少 8 位且含字母和数字</span>}
      </div>
    </div>
  );
}
