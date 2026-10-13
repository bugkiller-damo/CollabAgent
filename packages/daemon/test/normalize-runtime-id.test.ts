import {
  BRIDGE_RUNTIME_ID,
  BRIDGE_RUNTIME_IDS,
  isBridgeRuntime,
  LEGACY_BRIDGE_RUNTIME_IDS,
  normalizeRuntimeId,
} from "@collabagent/shared";
import { describe, expect, it } from "vitest";

/**
 * WP6（DEC-1）：langchain/langgraph 仅为输入别名——归一在所有边界发生，
 * 归一身份恒为 "bridge"；别名永不持久化、永不进入原始比较。
 * daemon 侧固定一份 shared 归一语义的回归面。
 */
describe("normalizeRuntimeId / isBridgeRuntime（WP6 归一语义）", () => {
  it("canonical bridge 原样通过", () => {
    expect(normalizeRuntimeId("bridge")).toBe("bridge");
  });

  it.each(LEGACY_BRIDGE_RUNTIME_IDS)("旧别名 %s → bridge", (alias) => {
    expect(normalizeRuntimeId(alias)).toBe(BRIDGE_RUNTIME_ID);
  });

  it("大小写/空白不敏感：' LangGraph ' → bridge", () => {
    expect(normalizeRuntimeId(" LangGraph ")).toBe("bridge");
    expect(normalizeRuntimeId("LANGCHAIN")).toBe("bridge");
    expect(normalizeRuntimeId("  Bridge\t")).toBe("bridge");
  });

  it("非 bridge 族 id 归一后小写直通（claude/codex 不受影响）", () => {
    expect(normalizeRuntimeId("claude")).toBe("claude");
    expect(normalizeRuntimeId("Codex")).toBe("codex");
    expect(normalizeRuntimeId("my-runtime")).toBe("my-runtime");
  });

  it("空/空白/undefined/null → undefined", () => {
    expect(normalizeRuntimeId("")).toBeUndefined();
    expect(normalizeRuntimeId("   ")).toBeUndefined();
    expect(normalizeRuntimeId(undefined)).toBeUndefined();
    expect(normalizeRuntimeId(null)).toBeUndefined();
  });

  it("isBridgeRuntime ≡ normalize===bridge（别名/大小写都算）", () => {
    expect(isBridgeRuntime("bridge")).toBe(true);
    expect(isBridgeRuntime("langgraph")).toBe(true);
    expect(isBridgeRuntime(" LangChain ")).toBe(true);
    expect(isBridgeRuntime("claude")).toBe(false);
    expect(isBridgeRuntime(undefined)).toBe(false);
    expect(isBridgeRuntime("not-a-runtime")).toBe(false);
  });

  it("BRIDGE_RUNTIME_IDS 只含 canonical bridge（别名不在注册面）", () => {
    expect(BRIDGE_RUNTIME_IDS).toEqual(["bridge"]);
    expect(BRIDGE_RUNTIME_IDS).not.toContain("langchain");
    expect(BRIDGE_RUNTIME_IDS).not.toContain("langgraph");
  });
});
