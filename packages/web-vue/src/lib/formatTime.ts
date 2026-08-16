/** 智能时间格式化：根据距离当前时间的远近，选择合适的显示粒度 */
export function formatTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
  const diffDay = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);

  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  // 不到 1 分钟 → "刚刚"
  if (diffSec < 60) return "刚刚";
  // 不到 1 小时 → "X 分钟前"
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  // 今天 → "HH:MM"
  if (diffDay === 0) return time;
  // 昨天 → "昨天 HH:MM"
  if (diffDay === 1) return `昨天 ${time}`;
  // 今年 → "M月D日 HH:MM"
  if (d.getFullYear() === now.getFullYear()) {
    const md = d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    return `${md} ${time}`;
  }
  // 往年 → "YYYY年M月D日"
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
}
