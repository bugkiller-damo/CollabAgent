import { describe, expect, it } from "vitest";
import { cleanChannelName } from "../src/lib/channel.js";
import { newCsrfToken, parseCookies } from "../src/lib/cookies.js";
import { dmChannelName, isDmTarget } from "../src/lib/dm.js";
import {
  initialFireAt,
  isValidIANATimezone,
  nextFireFromRepeat,
  nextFireNoDrift,
  parseDurationToMs,
  serverLocalTimezone,
  validatePatrolRepeat,
} from "../src/lib/reminders.js";
import { isAllowedMimeType } from "../src/lib/storage.js";

describe("cleanChannelName", () => {
  it('去掉前导 "#"', () => expect(cleanChannelName("#general")).toBe("general"));
  it("去掉线程后缀", () => expect(cleanChannelName("#general:abc")).toBe("general"));
  it("无 # 保持不变", () => expect(cleanChannelName("general")).toBe("general"));
  it("空字符串", () => expect(cleanChannelName("")).toBe(""));
});

describe("isDmTarget", () => {
  it("dm: 前缀 true", () => expect(isDmTarget("dm:@user")).toBe(true));
  it("普通频道 false", () => expect(isDmTarget("#general")).toBe(false));
});

describe("dmChannelName", () => {
  it("排序稳定", () => expect(dmChannelName("b", "a")).toBe("dm_a_b"));
});

describe("parseDurationToMs", () => {
  it("30m 转毫秒", () => expect(parseDurationToMs("30m")).toBe(1800000));
  it("2h 转毫秒", () => expect(parseDurationToMs("2h")).toBe(7200000));
  it("无效格式", () => expect(parseDurationToMs("abc")).toBeNull());
});

describe("nextFireFromRepeat", () => {
  it("every:30m 增加30分钟", () => {
    const b = new Date("2026-01-01T12:00:00Z");
    expect(nextFireFromRepeat("every:30m", b)!.toISOString()).toBe("2026-01-01T12:30:00.000Z");
  });
});

describe("initialFireAt", () => {
  it("fireAt 指定时间", () => {
    const d = new Date("2026-06-15T10:00:00Z");
    expect(initialFireAt({ fireAt: d.toISOString() })!.toISOString()).toBe(d.toISOString());
  });
  it("空返回 null", () => expect(initialFireAt({})).toBeNull());
});

// ---- P1.23：IANA 时区 + 消漂移重排 ----
describe("isValidIANATimezone / serverLocalTimezone", () => {
  it("合法 IANA 名", () => expect(isValidIANATimezone("Asia/Shanghai")).toBe(true));
  it("UTC 合法", () => expect(isValidIANATimezone("UTC")).toBe(true));
  it("非法名拒绝", () => expect(isValidIANATimezone("Mars/Olympus")).toBe(false));
  it("server 本地 tz 非空", () => expect(serverLocalTimezone().length).toBeGreaterThan(0));
});

describe("nextFireFromRepeat: daily@HH:MM 按 IANA 时区", () => {
  it("Asia/Shanghai 08:00：from 恰为当日槽位 → 取次日（北京时间 1/2 08:00）", () => {
    const from = new Date("2026-01-01T00:00:00Z"); // 北京时间 1/1 08:00
    expect(nextFireFromRepeat("daily@08:00", from, "Asia/Shanghai")!.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
  it("Asia/Shanghai 09:00：08:30 之后取当天槽位", () => {
    const from = new Date("2026-06-15T00:30:00Z"); // 北京时间 08:30
    expect(nextFireFromRepeat("daily@09:00", from, "Asia/Shanghai")!.toISOString()).toBe("2026-06-15T01:00:00.000Z");
  });
  it("DST 切换日按挂钟计算（America/New_York，2026-03-08 进入 EDT）", () => {
    expect(nextFireFromRepeat("daily@09:00", new Date("2026-03-07T12:00:00Z"), "America/New_York")!.toISOString()).toBe(
      "2026-03-07T14:00:00.000Z",
    ); // 09:00 EST = 14:00Z
    expect(nextFireFromRepeat("daily@09:00", new Date("2026-03-08T12:00:00Z"), "America/New_York")!.toISOString()).toBe(
      "2026-03-08T13:00:00.000Z",
    ); // 09:00 EDT = 13:00Z
  });
  it("不带 tz 保持旧行为：槽位落在 server 本地时区的 09:00", () => {
    const from = new Date("2026-01-01T12:00:00Z");
    const next = nextFireFromRepeat("daily@09:00", from)!;
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    const w = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(next);
    expect(w).toBe("09:00");
  });
  it("越界 HH:MM 显式拒绝（此前 setHours 静默翻日）", () => {
    expect(nextFireFromRepeat("daily@25:00", new Date())).toBeNull();
    expect(nextFireFromRepeat("daily@09:70", new Date())).toBeNull();
  });
});

describe("nextFireNoDrift（P1.23：以原 fire_at 为基准重排）", () => {
  const last = new Date("2026-01-01T10:00:00Z");
  it("every:1h 无积压：紧邻下一周期，锚点不变", () => {
    const now = new Date("2026-01-01T10:30:00Z");
    expect(nextFireNoDrift("every:1h", last, now)!.toISOString()).toBe("2026-01-01T11:00:00.000Z");
  });
  it("every:1h 停机 3.5h：等差快进到下一个锚位（不再以处理时刻为基准）", () => {
    const now = new Date("2026-01-01T13:30:00Z");
    expect(nextFireNoDrift("every:1h", last, now)!.toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });
  it("every:1h 停机恰为整数个周期：不落在 now 上（严格未来）", () => {
    const now = new Date("2026-01-01T13:00:00Z");
    expect(nextFireNoDrift("every:1h", last, now)!.toISOString()).toBe("2026-01-01T14:00:00.000Z");
  });
  it("daily@tz 跳过错过的天：停机跨天不补触发", () => {
    const l = new Date("2026-01-01T01:00:00Z"); // 北京时间 1/1 09:00（刚触发）
    const now = new Date("2026-01-03T00:00:00Z"); // 北京时间 1/3 08:00（1/2 槽位错过）
    expect(nextFireNoDrift("daily@09:00", l, now, "Asia/Shanghai")!.toISOString()).toBe("2026-01-03T01:00:00.000Z");
  });
  it("不可解析规则返回 null", () => {
    expect(nextFireNoDrift("whenever", last, new Date())).toBeNull();
  });
});

// T2 patrol 频率护栏（设计:docs/2026-08-19/02-t2-agent-patrol-design.md §6 最小周期 5min）
describe("validatePatrolRepeat", () => {
  it("every:30m 合法", () => expect(validatePatrolRepeat("every:30m")).toBeNull());
  it("every:5m 边界合法", () => expect(validatePatrolRepeat("every:5m")).toBeNull());
  it("hourly 合法", () => expect(validatePatrolRepeat("hourly")).toBeNull());
  it("daily@09:00 合法", () => expect(validatePatrolRepeat("daily@09:00")).toBeNull());
  it("every:30s 低于 5min 下限被拒绝", () => expect(validatePatrolRepeat("every:30s")).toMatch(/too short/));
  it("every:1m 低于下限被拒绝", () => expect(validatePatrolRepeat("every:1m")).toMatch(/too short/));
  it("非法语法被拒绝", () => expect(validatePatrolRepeat("whenever")).toMatch(/unsupported/));
  it("空字符串被拒绝", () => expect(validatePatrolRepeat("")).toMatch(/unsupported/));
});

describe("newCsrfToken", () => {
  it("48 位 hex", () => {
    const t = newCsrfToken();
    expect(/^[0-9a-f]{48}$/.test(t)).toBe(true);
  });
  it("每次不同", () => {
    const a = newCsrfToken();
    const b = newCsrfToken();
    expect(a).not.toBe(b);
  });
});

describe("parseCookies", () => {
  it("解析 a=b", () => {
    const r = parseCookies("x=1; y=hi");
    expect(r.x).toBe("1");
    expect(r.y).toBe("hi");
  });
  it("空头返回空对象", () => {
    expect(parseCookies("")).toEqual({});
    expect(parseCookies(undefined as any)).toEqual({});
  });
});

describe("isAllowedMimeType", () => {
  it("允许 jpeg", () => expect(isAllowedMimeType("image/jpeg")).toBe(true));
  it("拒绝 html", () => expect(isAllowedMimeType("text/html")).toBe(false));
});
