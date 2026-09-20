import { describe, expect, it, vi } from "vitest";
import {
  type AgentRuntimeDriver,
  AgentRuntimeRegistry,
  type AgentRuntimeSession,
} from "../src/agent-runtime-driver.js";
import { DispatchError } from "../src/errors.js";

/**
 * Phase 0：AgentRuntimeRegistry 的注册/解析契约。
 * 重复 runtimeId 在构造期抛错（启动配置错误）；未知 runtime 在派发路径
 * 抛 permanent DispatchError（runtime-unsupported，retriable=false）。
 */

const stubDriver = (driverId: string, runtimeIds: string[]): AgentRuntimeDriver => ({
  driverId,
  runtimeIds,
  openSession: () =>
    ({
      alive: true,
      send: vi.fn(async () => {}),
      stop: vi.fn(),
    }) satisfies AgentRuntimeSession,
  forgetAgent: vi.fn(),
});

describe("AgentRuntimeRegistry", () => {
  it("resolve 命中已注册 runtimeId 返回对应 driver", () => {
    const claude = stubDriver("claude-stream", ["claude"]);
    const other = stubDriver("other-driver", ["other"]);
    const registry = new AgentRuntimeRegistry([claude, other]);

    expect(registry.resolve("claude")).toBe(claude);
    expect(registry.resolve("other")).toBe(other);
  });

  it("同一 runtimeId 被两个 driver 注册时构造期抛错", () => {
    const a = stubDriver("a", ["claude"]);
    const b = stubDriver("b", ["claude", "extra"]);
    expect(() => new AgentRuntimeRegistry([a, b])).toThrow(/claude/);
  });

  it("同一 driver 内部重复 runtimeId 也拒绝", () => {
    const dup = stubDriver("dup", ["x", "x"]);
    expect(() => new AgentRuntimeRegistry([dup])).toThrow(/x/);
  });

  it("未知 runtime 抛 DispatchError：code=runtime-unsupported 且 retriable=false", () => {
    const registry = new AgentRuntimeRegistry([stubDriver("claude-stream", ["claude"])]);

    try {
      registry.resolve("langchain");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DispatchError);
      const de = err as DispatchError;
      expect(de.code).toBe("runtime-unsupported");
      expect(de.retriable).toBe(false);
      expect(de.message).toContain("langchain");
    }
  });
});
