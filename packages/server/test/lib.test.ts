import { describe, expect, it } from "vitest";
import { cleanChannelName } from "../src/lib/channel.js";
import { newCsrfToken, parseCookies } from "../src/lib/cookies.js";
import { dmChannelName, isDmTarget } from "../src/lib/dm.js";
import { initialFireAt, nextFireFromRepeat, parseDurationToMs, validatePatrolRepeat } from "../src/lib/reminders.js";
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
