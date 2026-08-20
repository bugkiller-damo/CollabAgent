import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStateMachine } from "../src/agent-runtime-state.js";

/**
 * 五态状态机（uninit/idle/starting/working/stopped）。
 * 关键语义（以 src/agent-runtime-state.ts 实现为准）：
 * - 非法迁移不抛到外部：console.warn 告警后被吞，状态保持不变；
 * - 同态迁移是 no-op（不告警）；
 * - 未知 agent 的首个迁移按 uninit 校验。
 */

describe("agent-runtime-state", () => {
  let sm: ReturnType<typeof createAgentStateMachine>;
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  /** 把 agent "a" 合法地置于目标态（非法直达路径不存在时走中转） */
  const placeAt = (s: "idle" | "starting" | "working" | "stopped") => {
    sm.transitionState("a", "idle");
    if (s === "starting") sm.transitionState("a", "starting");
    if (s === "working") sm.transitionState("a", "working"); // idle → working 直通合法
    if (s === "stopped") sm.transitionState("a", "stopped");
  };

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    sm = createAgentStateMachine();
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  describe("合法迁移", () => {
    it("未知 agent 无状态；首个迁移按 uninit 校验", () => {
      expect(sm.getState("a")).toBeUndefined();
      sm.transitionState("a", "idle"); // uninit → idle 合法
      expect(sm.getState("a")).toBe("idle");
    });

    it("完整生命周期链全部放行", () => {
      sm.transitionState("a", "idle");
      sm.transitionState("a", "starting");
      sm.transitionState("a", "working");
      sm.transitionState("a", "idle");
      sm.transitionState("a", "stopped");
      sm.transitionState("a", "idle"); // stopped → idle（重启复活）
      expect(sm.getState("a")).toBe("idle");
    });

    it("idle → working 直通合法（常驻/复用分支收到新消息直接进工作态）", () => {
      sm.transitionState("a", "idle");
      sm.transitionState("a", "working");
      expect(sm.getState("a")).toBe("working");
    });
  });

  describe("非法迁移", () => {
    it.each([
      ["working", "starting"],
      ["working", "uninit"],
      ["starting", "uninit"],
      ["stopped", "working"],
      ["stopped", "starting"],
      ["idle", "uninit"],
    ] as const)("%s → %s 被吞且状态不变", (from, to) => {
      placeAt(from);
      warn.mockClear();
      sm.transitionState("a", to);
      expect(sm.getState("a")).toBe(from);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${from} → ${to}`));
    });

    it("uninit → working 非法：状态保持 undefined（从未落账）", () => {
      sm.transitionState("a", "working");
      expect(sm.getState("a")).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid state transition"));
    });

    it("同态迁移是 no-op，不告警", () => {
      sm.transitionState("a", "idle");
      warn.mockClear();
      sm.transitionState("a", "idle");
      expect(sm.getState("a")).toBe("idle");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("getWorkingAgents", () => {
    it("只返回 working 态 agent，带 lastTransitionAt", () => {
      sm.transitionState("a", "idle");
      sm.transitionState("a", "working");
      sm.transitionState("b", "idle");
      sm.transitionState("c", "idle");
      sm.transitionState("c", "starting");
      const working = sm.getWorkingAgents();
      expect(working.map((w) => w.name)).toEqual(["a"]);
      expect(working[0]!.lastTransitionAt).toBeGreaterThan(0);
    });

    it("agent 离开 working 后不再出现在列表", () => {
      sm.transitionState("a", "idle");
      sm.transitionState("a", "working");
      sm.transitionState("a", "idle");
      expect(sm.getWorkingAgents()).toHaveLength(0);
    });
  });

  describe("startup timer", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("clearStartupTimer 清掉已存定时器", () => {
      sm.transitionState("a", "idle");
      const cb = vi.fn();
      sm.setStartupTimer("a", setTimeout(cb, 100));
      sm.clearStartupTimer("a");
      vi.advanceTimersByTime(200);
      expect(cb).not.toHaveBeenCalled();
    });

    it("未 clear 的定时器照常触发", () => {
      sm.transitionState("a", "idle");
      const cb = vi.fn();
      sm.setStartupTimer("a", setTimeout(cb, 100));
      vi.advanceTimersByTime(200);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("无状态 agent 的 timer 不被存储（clear 无对象可清）", () => {
      const cb = vi.fn();
      sm.setStartupTimer("ghost", setTimeout(cb, 100)); // ghost 无状态 → set 被忽略
      sm.clearStartupTimer("ghost"); // no-op，不抛错
      vi.advanceTimersByTime(200);
      expect(cb).toHaveBeenCalledTimes(1); // 无人清理，照常触发
    });
  });
});
