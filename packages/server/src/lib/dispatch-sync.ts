import type { FastifyInstance } from "fastify";

/**
 * P1.26：看板卡片 → dispatch 回向同步（双向同步的另一半）。
 *
 * dispatch 侧（agents-dispatch.ts）状态流转一直驱动卡片：created→in_progress、
 * reported→in_review、accepted→done、cancelled→closed。反向此前缺失——人类/agent
 * 经 tasks 路由把 dispatch 关联卡片（dispatches.task_message_id）直接置为
 * done/closed 时，台账 dispatch 永挂 open/reported（「卡片已关、合同永挂」分叉）。
 *
 * 映射：卡片 done → dispatch completed（completed_at）；卡片 closed → dispatch
 * cancelled（cancelled_at）。条件更新只作用于非终态（open/reported），已终态的
 * dispatch 不回退不重写；无关联 dispatch（task_message_id 悬空或普通卡片）零影响。
 * 不产生额外 task event / 频道消息——卡片状态变化本身已由调用方 recordTaskEvent，
 * dispatch 台账变化经 GET /dispatches 可见（对 agent 的主动唤醒归后续）。
 *
 * 返回 true 表示有 dispatch 行被同步（仅供测试断言）。
 */
export async function syncDispatchOnCardClose(
  app: FastifyInstance,
  messageId: string,
  cardStatus: "done" | "closed",
): Promise<boolean> {
  const toCompleted = cardStatus === "done";
  const r = await app.pg.query<{ id: string }>(
    `UPDATE dispatches
        SET status = $2,
            completed_at = CASE WHEN $3 THEN now() ELSE completed_at END,
            cancelled_at = CASE WHEN $4 THEN now() ELSE cancelled_at END
      WHERE task_message_id = $1 AND status IN ('open', 'reported')
      RETURNING id`,
    // P1.26 实锤留痕：目标状态单参数复用（status=$2 与 $2='completed' 字面量比较）
    // 触发 PG 42P08 参数类型推断冲突（varchar vs text）——与 P1.24 的 42P18 同类，
    // 真库测试当场击中。改双布尔参数消歧。
    [messageId, toCompleted ? "completed" : "cancelled", toCompleted, !toCompleted],
  );
  return r.rows.length > 0;
}
