import { describe, expect, it } from "vitest";
import { eventHash } from "../src/lib/audit.js";

const base = {
  actorId: "u-1",
  actorType: "human" as const,
  verb: "message.send",
  objectType: "message",
  objectId: "m-1",
};

describe("eventHash（O2 哈希链纯函数）", () => {
  it("确定性：相同输入 → 相同 hash", () => {
    const a = eventHash({ ...base, payload: { channelId: "c-1" } }, null);
    const b = eventHash({ ...base, payload: { channelId: "c-1" } }, null);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("payload 键序无关：jsonb 重排后 hash 不变", () => {
    const a = eventHash({ ...base, payload: { a: 1, b: 2, c: 3 } }, null);
    const b = eventHash({ ...base, payload: { c: 3, b: 2, a: 1 } }, null);
    expect(a).toBe(b);
  });

  it("嵌套 payload 同样键序无关", () => {
    const a = eventHash({ ...base, payload: { nested: { x: 1, y: 2 }, arr: [1, 2] } }, null);
    const b = eventHash({ ...base, payload: { arr: [1, 2], nested: { y: 2, x: 1 } } }, null);
    expect(a).toBe(b);
  });

  it("prev_hash 参与哈希：不同前序 → 不同 hash", () => {
    const a = eventHash({ ...base, payload: {} }, null);
    const b = eventHash({ ...base, payload: {} }, "some-prev-hash");
    expect(a).not.toBe(b);
  });

  it("不同 verb 产生不同 hash", () => {
    const a = eventHash({ ...base, verb: "message.send" }, null);
    const b = eventHash({ ...base, verb: "message.edit" }, null);
    expect(a).not.toBe(b);
  });
});
