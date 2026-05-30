// 提醒时间/周期解析工具

export function parseDurationToMs(s: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * mult[m[2]];
}

// 根据 repeat 规则算下一次触发时间；不支持/一次性返回 null
// 支持：every:<N><s|m|h|d>、hourly、daily、daily@HH:MM
export function nextFireFromRepeat(repeat: string, from: Date): Date | null {
  const r = String(repeat).trim();
  let m = /^every:(\d+[smhd])$/.exec(r);
  if (m) { const ms = parseDurationToMs(m[1]); return ms ? new Date(from.getTime() + ms) : null; }
  if (r === "hourly") return new Date(from.getTime() + 3600000);
  if (r === "daily") return new Date(from.getTime() + 86400000);
  m = /^daily@(\d{1,2}):(\d{2})$/.exec(r);
  if (m) {
    const next = new Date(from);
    next.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  return null;
}

// 由请求体算初始触发时间
export function initialFireAt(body: { fireAt?: string; delaySeconds?: number; repeat?: string }): Date | null {
  if (body.fireAt) { const d = new Date(body.fireAt); return isNaN(d.getTime()) ? null : d; }
  if (body.delaySeconds != null) return new Date(Date.now() + Number(body.delaySeconds) * 1000);
  if (body.repeat) return nextFireFromRepeat(body.repeat, new Date());
  return null;
}

export function reminderToDto(r: any) {
  return {
    id: r.id,
    title: r.title,
    fireAt: r.fire_at,
    repeat: r.repeat_rule || null,
    channel: r.channel_ref || null,
    status: r.status,
    fireCount: r.fire_count ?? 0,
    lastFiredAt: r.last_fired_at || null,
    createdAt: r.created_at,
  };
}
