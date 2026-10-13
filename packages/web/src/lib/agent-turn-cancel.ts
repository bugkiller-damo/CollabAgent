import { isBridgeRuntime } from "@collabagent/shared";

/**
 * WP11：「停止当前回合」按钮的可见性判定（纯函数——组件与测试共用）。
 *
 * 全部满足才显示：
 * - agent 档案 + 属主本人（server 侧同属主校验——非属主点了也会被静默丢）；
 * - bridge runtime（归一口径：旧 langchain/langgraph 别名也算）；
 * - 绑定机 probe 的当前 entrypoint 声明 capabilities.cancel === true；
 * - live 状态为 working（有活动回合才有得停）。
 * 缺一即藏——不可取消的形态不给出会产生「点了没用」错觉的按钮。
 */
export function canCancelTurn(input: {
  isAgent: boolean;
  ownedByMe: boolean;
  runtime?: string;
  status?: string | null;
  capabilities?: Record<string, unknown> | null;
}): boolean {
  return (
    input.isAgent === true &&
    input.ownedByMe === true &&
    isBridgeRuntime(input.runtime) &&
    input.status === "working" &&
    input.capabilities?.cancel === true
  );
}

/** WP11：控制帧组包——集中在此，组件与测试共用同一形状 */
export function buildCancelTurnFrame(agentId: string): { type: "agent:cancel-turn"; agentId: string } {
  return { type: "agent:cancel-turn", agentId };
}
