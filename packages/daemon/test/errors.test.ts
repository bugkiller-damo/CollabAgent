import { describe, expect, it } from "vitest";
import { DispatchError, errCode, errMessage, isRetriableError } from "../src/errors.js";

describe("errors（P1.14 统一错误模型）", () => {
  it("errMessage：Error 取 message，非 Error 走 String", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
    expect(errMessage("plain")).toBe("plain");
    expect(errMessage(42)).toBe("42");
    expect(errMessage(undefined)).toBe("undefined");
  });

  it("永久失败 code → retriable=false", () => {
    for (const code of ["agent-unknown", "agent-stopped", "session-lost"] as const) {
      expect(new DispatchError(code, "x").retriable).toBe(false);
    }
  });

  it("临时失败 code → retriable=true", () => {
    for (const code of ["inflight-timeout", "credential-mint-failed"] as const) {
      expect(new DispatchError(code, "x").retriable).toBe(true);
    }
  });

  it("retriable 由 code 推导，构造后不开放覆盖", () => {
    const err = new DispatchError("agent-stopped", "x");
    expect(err.name).toBe("DispatchError");
    expect(err.code).toBe("agent-stopped");
    expect(err.retriable).toBe(false);
  });

  it("isRetriableError：DispatchError 按其 retriable，其余一律视为可重试", () => {
    expect(isRetriableError(new DispatchError("agent-stopped", "x"))).toBe(false);
    expect(isRetriableError(new DispatchError("credential-mint-failed", "x"))).toBe(true);
    expect(isRetriableError(new Error("boom"))).toBe(true);
    expect(isRetriableError("string")).toBe(true);
    expect(isRetriableError(undefined)).toBe(true);
  });

  it("errCode：DispatchError 取 code，非 DispatchError 返回 undefined", () => {
    expect(errCode(new DispatchError("session-lost", "x"))).toBe("session-lost");
    expect(errCode(new Error("boom"))).toBeUndefined();
    expect(errCode("x")).toBeUndefined();
  });
});
