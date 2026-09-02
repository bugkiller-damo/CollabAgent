// 提醒时间/周期解析工具

export function parseDurationToMs(s: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(String(s).trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * mult[m[2]];
}

// ---- P1.23：IANA 时区支持 ----
// daily@HH:MM 此前用 setHours 依赖 server 本地时区（UTC 部署时东八区用户提醒错 8 小时）。
// 现 reminders.timezone 显式存 IANA 名称（daemon 跑在用户机器上，创建时随附本机时区），
// 计算用 Intl 按 tz 换算；tz 为 NULL 的存量行回退 server 本地时区（行为不变）。
export function isValidIANATimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function serverLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

interface ZonedWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** instant 在 tz 的本地挂钟读数 */
function zonedWallClock(tz: string, at: Date): ZonedWallClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23", // hour12:false 在部分平台会吐 "24:xx"
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** instant 时刻 tz 相对 UTC 的偏移（毫秒，东正西负） */
function tzOffsetMs(tz: string, instantMs: number): number {
  const at = new Date(Math.floor(instantMs / 1000) * 1000);
  const w = zonedWallClock(tz, at);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - at.getTime();
}

/** tz 本地挂钟 (y,mo,d,h,mi) → UTC 时间戳；DST 边界做一次修正逼近 */
function wallClockToEpochMs(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - tzOffsetMs(tz, guess);
  const refined = guess - tzOffsetMs(tz, ts);
  if (refined !== ts) ts = refined;
  return ts;
}

/** tz 本地的下一个 HH:MM 时刻（严格大于 after；DST 跳变日以挂钟为准） */
function nextDailyAtInTz(hh: number, mm: number, tz: string, after: Date): Date {
  const w = zonedWallClock(tz, after);
  // 以 UTC 日历数做「日历句柄」+1 天（自动跨月跨年），再映射回 tz 挂钟
  let ts = wallClockToEpochMs(tz, w.year, w.month, w.day, hh, mm);
  if (ts <= after.getTime()) {
    const nd = new Date(Date.UTC(w.year, w.month - 1, w.day) + 86400000);
    ts = wallClockToEpochMs(tz, nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(), hh, mm);
  }
  return new Date(ts);
}

// 根据 repeat 规则算下一次触发时间；不支持/一次性返回 null
// 支持：every:<N><s|m|h|d>、hourly、daily、daily@HH:MM
// tz（IANA 名称）仅作用于 daily@HH:MM；缺省/存量行回退 server 本地时区
export function nextFireFromRepeat(repeat: string, from: Date, tz?: string | null): Date | null {
  const r = String(repeat).trim();
  let m = /^every:(\d+[smhd])$/.exec(r);
  if (m) {
    const ms = parseDurationToMs(m[1]);
    return ms ? new Date(from.getTime() + ms) : null;
  }
  if (r === "hourly") return new Date(from.getTime() + 3600000);
  if (r === "daily") return new Date(from.getTime() + 86400000);
  m = /^daily@(\d{1,2}):(\d{2})$/.exec(r);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    // 此前 setHours(25,70) 会静默翻日成 02:10，改为显式拒绝（validatePatrolRepeat 报 unsupported）
    if (hh > 23 || mm > 59) return null;
    if (tz && isValidIANATimezone(tz)) return nextDailyAtInTz(hh, mm, tz, from);
    const next = new Date(from);
    next.setHours(hh, mm, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  return null;
}

// P1.23 消漂移重排：以「刚触发的那次 fire_at」为基准排下一次，并跳过停机积压的
// 槽位直到严格大于 now。此前 scheduler 用处理时刻 new Date() 为基准——every:1h
// 实际 >1h（逐轮累积处理延迟）；长时间停机后还会逐 tick 补触发（每 20s 追一个周期）。
// - 间隔型（every:/hourly/daily）：等差快进，O(1)，锚点仍是历史序列；
// - daily@HH:MM：时钟锚定规则本就无间隔漂移，逐日推进跳过错过的天（上限 ~400 天，
//   超限退化为「从 now 起下一个槽位」，不放弃提醒）。
export function nextFireNoDrift(repeat: string, lastFireAt: Date, now: Date, tz?: string | null): Date | null {
  const first = nextFireFromRepeat(repeat, lastFireAt, tz);
  if (!first) return null;
  if (first.getTime() > now.getTime()) return first;
  const r = String(repeat).trim();
  const m = /^every:(\d+[smhd])$/.exec(r);
  const stepMs = m ? parseDurationToMs(m[1]) : r === "hourly" ? 3600000 : r === "daily" ? 86400000 : null;
  if (stepMs) {
    // k 取最小整数使 lastFireAt + k*step > now：floor + 1，序列仍是 lastFireAt + n*step
    const k = Math.floor((now.getTime() - lastFireAt.getTime()) / stepMs) + 1;
    return new Date(lastFireAt.getTime() + k * stepMs);
  }
  let next = first;
  for (let i = 0; i < 400 && next.getTime() <= now.getTime(); i++) {
    const n = nextFireFromRepeat(repeat, next, tz);
    if (!n || n.getTime() <= next.getTime()) return null; // 防御：规则不自推进
    next = n;
  }
  if (next.getTime() > now.getTime()) return next;
  return nextFireFromRepeat(repeat, now, tz); // 停机超过 ~400 天：放弃补槽，取下一个未来槽位
}

// 由请求体算初始触发时间；tz 透传给 daily@HH:MM 类 repeat（缺省 server 本地时区）
export function initialFireAt(
  body: { fireAt?: string; delaySeconds?: number; repeat?: string },
  tz?: string | null,
): Date | null {
  if (body.fireAt) {
    const d = new Date(body.fireAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (body.delaySeconds != null) return new Date(Date.now() + Number(body.delaySeconds) * 1000);
  if (body.repeat) return nextFireFromRepeat(body.repeat, new Date(), tz);
  return null;
}

// ---- T2 patrol 护栏参数（设计:docs/2026-08-19/02-t2-agent-patrol-design.md §6) ----
export const PATROL_MIN_INTERVAL_MS = 5 * 60 * 1000; // patrol 最小周期 5min
export const PATROL_MAX_PER_AGENT = 10; // 每 agent 活跃 patrol 上限

// patrol 周期校验:必须可解析且周期 ≥ 5min;返回错误文案,合法返回 null
// （tz 不参与校验：daily@ 槽位间距为小时级，5min 下限实际由 every: 类规则触发）
export function validatePatrolRepeat(repeat: string): string | null {
  const next = nextFireFromRepeat(repeat, new Date());
  if (!next) return "unsupported repeat rule (supported: every:N{s,m,h,d}, hourly, daily, daily@HH:MM)";
  if (next.getTime() - Date.now() < PATROL_MIN_INTERVAL_MS) return "patrol interval too short (min 5m)";
  return null;
}

export function reminderToDto(r: any) {
  return {
    id: r.id,
    kind: r.kind || "reminder",
    title: r.title,
    instructions: r.instructions || null,
    fireAt: r.fire_at,
    repeat: r.repeat_rule || null,
    timezone: r.timezone || null, // P1.23：daily@HH:MM 的计算时区（IANA；null=存量行回退 server 本地）
    channel: r.channel_ref || null,
    status: r.status,
    paused: r.paused ?? false,
    fireCount: r.fire_count ?? 0,
    consecutiveSilent: r.consecutive_silent ?? 0,
    maxConsecutiveSilent: r.max_consecutive_silent ?? 5,
    lastFiredAt: r.last_fired_at || null,
    createdAt: r.created_at,
  };
}
