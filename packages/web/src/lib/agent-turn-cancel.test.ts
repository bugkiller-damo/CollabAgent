import { describe, expect, it } from "vitest";
import { buildCancelTurnFrame, canCancelTurn } from "./agent-turn-cancel";

const visible = {
  isAgent: true,
  ownedByMe: true,
  runtime: "bridge",
  status: "working",
  capabilities: { cancel: true },
};

describe("canCancelTurn（WP11：「停止当前回合」可见性矩阵）", () => {
  it("bridge + cancel:true + working + 属主 → 显示", () => {
    expect(canCancelTurn(visible)).toBe(true);
  });

  it("旧别名（langchain/langgraph）归一为 bridge → 同样显示", () => {
    expect(canCancelTurn({ ...visible, runtime: "langgraph" })).toBe(true);
    expect(canCancelTurn({ ...visible, runtime: "langchain" })).toBe(true);
  });

  it("claude / 未知 / 空 runtime → 隐藏", () => {
    expect(canCancelTurn({ ...visible, runtime: "claude" })).toBe(false);
    expect(canCancelTurn({ ...visible, runtime: "codex" })).toBe(false);
    expect(canCancelTurn({ ...visible, runtime: undefined })).toBe(false);
  });

  it("capabilities 缺失 / cancel 缺省或非 true → 隐藏", () => {
    expect(canCancelTurn({ ...visible, capabilities: null })).toBe(false);
    expect(canCancelTurn({ ...visible, capabilities: undefined })).toBe(false);
    expect(canCancelTurn({ ...visible, capabilities: {} })).toBe(false);
    expect(canCancelTurn({ ...visible, capabilities: { cancel: false } })).toBe(false);
    // 非布尔「真值」不放行——probe 摘要已白名单布尔化，这里再兜一层
    expect(canCancelTurn({ ...visible, capabilities: { cancel: "yes" } })).toBe(false);
  });

  it("非 working（idle/starting/缺省）→ 隐藏（无活动回合可停）", () => {
    for (const status of ["idle", "starting", "stopped", "offline", null, undefined]) {
      expect(canCancelTurn({ ...visible, status })).toBe(false);
    }
  });

  it("非属主 / 非 agent → 隐藏（server 同属主校验，非属主帧会被静默丢）", () => {
    expect(canCancelTurn({ ...visible, ownedByMe: false })).toBe(false);
    expect(canCancelTurn({ ...visible, isAgent: false })).toBe(false);
  });
});

describe("buildCancelTurnFrame（WP11：browser → server 控制帧）", () => {
  it("帧形状：{ type, agentId }——不带 displayName/会话细节", () => {
    expect(buildCancelTurnFrame("aaaaaaaa-1111-1111-1111-111111111111")).toEqual({
      type: "agent:cancel-turn",
      agentId: "aaaaaaaa-1111-1111-1111-111111111111",
    });
  });
});
