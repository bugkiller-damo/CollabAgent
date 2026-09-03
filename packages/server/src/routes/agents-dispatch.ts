import type { FastifyInstance } from "fastify";
import { computerOnlineFor } from "../lib/agent-duty.js";
import { getAgent, isChannelManager, requireOwnAgent } from "../lib/agent-helpers.js";
import { resolveChannel } from "../lib/channel.js";
import { resolvePeer } from "../lib/dm.js";
import { recordTaskEvent } from "../lib/task-events.js";
import { acquireTaskNumberLock } from "../lib/task-numbering.js";
import { broadcast, sendToUser } from "../ws/handler.js";

const STATUSES = ["open", "reported", "cancelled", "completed"];

/**
 * 频道内经理 agent 派发任务给 worker agent（对应 hive `team-operations.ts`）。
 *
 * 和 agents-tasks.ts 的任务看板不同：dispatch 是经理对某个 worker 的一对一任务
 * 合同，需要严格的归属校验（谁能派、谁能报、谁能撤），不是任何频道成员都能认领。
 *
 * 实际送达/唤醒 worker 复用现有的消息投递管道（插一条消息 + broadcast
 * agent:deliver）——不管 worker 由哪个 daemon 托管，现有链路本来就会按需拉起
 * 对应的 PTY，这里不需要重新实现"确保 worker 在跑"这件事。
 *
 * 但是 daemon-core.ts 的 agent:deliver 处理里有一条防自环判断
 * （sender_type === 'agent' 直接丢弃，避免 agent 之间用 @ 提及互相触发死循环）——
 * 这类通知消息恰恰是 agent 发的，会被那条判断挡掉。所以额外带一个显式的
 * `forceDeliverTo` 字段（目标 agent 的 handle），daemon 侧认出这个字段后绕开
 * 防自环判断直接路由，不依赖对 content 做 @ 提及文本匹配。
 */
async function insertAndDeliver(
  app: FastifyInstance,
  channelId: string,
  serverId: string,
  channelName: string,
  senderId: string,
  senderAgent: any,
  content: string,
  forceDeliverTo: string,
): Promise<string> {
  const result = await app.pg.query(
    "INSERT INTO messages (channel_id, server_id, sender_id, sender_type, content) VALUES ($1, $2, $3, 'agent', $4) RETURNING id, seq, created_at",
    [channelId, serverId, senderId, content],
  );
  const msg = result.rows[0] as { id: string; seq: number; created_at: string };
  broadcast(channelId, {
    type: "agent:deliver",
    seq: msg.seq,
    message: {
      id: msg.id,
      seq: msg.seq,
      channelId: "#" + channelName,
      senderId,
      senderName: senderAgent?.display_name || senderAgent?.name || "Agent",
      senderHandle: senderAgent?.name || "agent",
      senderType: "agent",
      content,
      time: msg.created_at,
      threadId: null,
      attachments: [],
      forceDeliverTo,
    },
  });
  return String(msg.id);
}

/**
 * P1.26：dispatch 回路的离线黑洞告警（对齐 dead-letter）。
 *
 * insertAndDeliver 依赖 agent:deliver 广播实时唤醒目标 agent——目标 agent 的
 * owner daemon 不在线时（computerOnlineFor = 本实例 daemonClients 连接表），
 * 广播无人接收，daemon 重连**不会补拉**（daemon 侧 connected 分支为 no-op），
 * dispatch 将静默挂 open/reported 无人知晓（评估报告「离线黑洞」）。
 *
 * 对齐 A1 死信语义：向经理 owner 的浏览器发同款 agent:delivery-dead-letter
 * 事件（reason="daemon-offline"），web toast 立即可见、零新增事件类型。
 * best-effort：经理 owner 无浏览器在线时事件自然丢弃（与死信一致）；
 * 多实例下 computerOnlineFor 只覆盖本实例连接（跨实例 presence 归 P1.27）。
 */
function alarmIfDaemonOffline(
  channelName: string,
  manager: { user_id?: string; name?: string } | null,
  target: { name?: string; user_id?: string } | null,
  what: string,
): void {
  if (!manager?.user_id || !target?.name || !target?.user_id) return;
  if (computerOnlineFor(String(target.user_id))) return;
  sendToUser(String(manager.user_id), {
    type: "agent:delivery-dead-letter",
    agentName: target.name,
    channelName,
    error: `${what}未实时送达：对方 daemon 离线，重连后不会自动补拉唤醒（可在台账查看或重新派发）`,
    reason: "daemon-offline",
  });
}

export async function agentDispatchRoutes(app: FastifyInstance) {
  app.post("/:agentId/dispatch", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, toAgent, text } = req.body as { channel?: string; toAgent?: string; text?: string };
    if (!channel || !toAgent || !text) return reply.status(400).send({ error: "channel, toAgent and text required" });

    const ch = await resolveChannel(app, channel, "id, server_id, name");
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    if (!(await isChannelManager(app, ch.id, agentId))) {
      return reply.status(403).send({ error: "only the channel's designated manager can dispatch tasks" });
    }

    const peer = await resolvePeer(app, toAgent);
    if (!peer || peer.type !== "agent") return reply.status(404).send({ error: "worker agent not found" });
    const member = await app.pg.query(
      "SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_id = $2 AND member_type = 'agent'",
      [ch.id, peer.id],
    );
    if (member.rows.length === 0)
      return reply.status(400).send({ error: "worker agent is not a member of this channel" });

    const workerDuty = await app.pg.query<{ duty: string; user_id: string; name: string }>(
      "SELECT duty, user_id, name FROM agents WHERE id = $1",
      [peer.id],
    );
    if (workerDuty.rows[0]?.duty === "off") {
      return reply.status(409).send({ error: "worker is off duty" });
    }

    const manager = await getAgent(app, agentId);
    const dispatch = (
      await app.pg.query<{
        id: string;
        channel_id: string;
        from_agent_id: string;
        to_agent_id: string;
        text: string;
        status: string;
        created_at: string;
      }>(
        "INSERT INTO dispatches (channel_id, from_agent_id, to_agent_id, text) VALUES ($1, $2, $3, $4) RETURNING id, channel_id, from_agent_id, to_agent_id, text, status, created_at",
        [ch.id, agentId, peer.id, text],
      )
    ).rows[0];

    const msgId = await insertAndDeliver(
      app,
      ch.id,
      ch.server_id as string,
      ch.name as string,
      agentId,
      manager,
      `📋 @${peer.handle} 你收到经理 @${manager?.name || "manager"} 派的任务（dispatch ${dispatch.id}）：${text}`,
      peer.handle,
    );
    // P1.26：离线黑洞告警——worker daemon 离线时任务消息不会被唤醒消费，经理侧立即 toast
    alarmIfDaemonOffline(ch.name as string, manager, workerDuty.rows[0] ?? null, `派给 @${peer.handle} 的任务`);

    // P1 同步：dispatch 通知消息同时成为看板卡片（in_progress + assignee=worker），
    // 台账记 task_message_id 供 report/cancel 联动
    // P0.5：MAX+1 子查询「单语句」不等于「原子」——READ COMMITTED 下并发派发各写
    // 不同消息行、行锁不互斥，会取到同一个号。取号持频道级 advisory lock 串行化。
    const cardUpd = await app.pg.transaction(async (tx) => {
      await acquireTaskNumberLock(tx, ch.id);
      return tx.query<{ task_number: number }>(
        `UPDATE messages
           SET task_number = (SELECT COALESCE(MAX(task_number), 0) + 1 FROM messages
                              WHERE channel_id = $2 AND task_number IS NOT NULL),
               task_status = 'in_progress', task_assignee = $3, updated_at = now()
         WHERE id = $1
         RETURNING task_number`,
        [msgId, ch.id, peer.id],
      );
    });
    await app.pg.query("UPDATE dispatches SET task_message_id = $1 WHERE id = $2", [msgId, dispatch.id]);
    if (cardUpd.rows[0]) {
      await recordTaskEvent(app, {
        messageId: msgId,
        channelId: ch.id,
        taskNumber: cardUpd.rows[0].task_number,
        actorId: agentId,
        action: "created",
        toStatus: "in_progress",
        detail: `dispatch ${dispatch.id}`,
      });
    }

    return { dispatch };
  });

  app.get("/:agentId/dispatches", { preHandler: [app.authenticate, requireOwnAgent] }, async (req, reply) => {
    const agentId = (req.params as Record<string, string>).agentId;
    const { channel, status } = req.query as Record<string, string>;
    if (!channel) return reply.status(400).send({ error: "channel required" });
    const ch = await resolveChannel(app, channel, "id");
    if (!ch) return reply.status(404).send({ error: "channel not found" });

    const asManager = await isChannelManager(app, ch.id, agentId);
    const col = asManager ? "from_agent_id" : "to_agent_id";
    const params: any[] = [ch.id, agentId];
    let q = `SELECT id, channel_id, from_agent_id, to_agent_id, text, status, report_text, artifacts, created_at, reported_at, cancelled_at, completed_at
              FROM dispatches WHERE channel_id = $1 AND ${col} = $2`;
    if (status && STATUSES.includes(status)) {
      params.push(status);
      q += ` AND status = $${params.length}`;
    }
    const result = await app.pg.query(q + " ORDER BY created_at DESC", params);
    return { dispatches: result.rows };
  });

  app.post(
    "/:agentId/dispatch/:dispatchId/report",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId;
      const dispatchId = (req.params as Record<string, string>).dispatchId;
      const { reportText, artifacts } = req.body as { reportText?: string; artifacts?: string[] };

      const found = await app.pg.query<{
        id: string;
        channel_id: string;
        from_agent_id: string;
        task_message_id: string | null;
      }>(
        "SELECT id, channel_id, from_agent_id, task_message_id FROM dispatches WHERE id = $1 AND to_agent_id = $2 AND status = 'open'",
        [dispatchId, agentId],
      );
      if (found.rows.length === 0) return reply.status(404).send({ error: "no open dispatch for this agent" });
      const dispatch = found.rows[0];

      await app.pg.query(
        "UPDATE dispatches SET status = 'reported', report_text = $1, artifacts = $2, reported_at = now() WHERE id = $3",
        [reportText || "", JSON.stringify(artifacts || []), dispatchId],
      );
      // P1 同步：回报 → 看板卡片转 in_review（等经理审查）
      if (dispatch.task_message_id) {
        const cardUpd = await app.pg.query<{ task_number: number; old_status: string | null }>(
          `UPDATE messages m SET task_status = 'in_review', updated_at = now()
             FROM (SELECT task_status AS old_status FROM messages WHERE id = $1) old
           WHERE m.id = $1
           RETURNING m.task_number, old.old_status`,
          [dispatch.task_message_id],
        );
        if (cardUpd.rows[0]) {
          await recordTaskEvent(app, {
            messageId: dispatch.task_message_id,
            channelId: dispatch.channel_id,
            taskNumber: cardUpd.rows[0].task_number,
            actorId: agentId,
            action: "status_changed",
            fromStatus: cardUpd.rows[0].old_status,
            toStatus: "in_review",
            detail: `dispatch ${dispatchId} reported`,
          });
        }
      }

      const worker = await getAgent(app, agentId);
      const manager = await getAgent(app, dispatch.from_agent_id);
      if (!manager?.name) return reply.status(500).send({ error: "manager agent no longer exists" });
      const ch = await app.pg.query<{ id: string; server_id: string; name: string }>(
        "SELECT id, server_id, name FROM channels WHERE id = $1",
        [dispatch.channel_id],
      );
      await insertAndDeliver(
        app,
        dispatch.channel_id,
        ch.rows[0].server_id,
        ch.rows[0].name,
        agentId,
        worker,
        `✅ @${manager.name} 你派给 @${worker?.name || "worker"} 的任务已回报（dispatch ${dispatchId}）：${reportText || "(无说明)"}`,
        manager.name,
      );
      // P1.26：经理 daemon 离线时回报不会被唤醒消费——经理 owner 侧立即 toast
      alarmIfDaemonOffline(ch.rows[0].name, manager, manager, "worker 的任务回报");

      return { ok: true };
    },
  );

  app.post(
    "/:agentId/dispatch/:dispatchId/cancel",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId;
      const dispatchId = (req.params as Record<string, string>).dispatchId;
      const { reason } = req.body as { reason?: string };

      const found = await app.pg.query<{
        id: string;
        channel_id: string;
        to_agent_id: string;
        task_message_id: string | null;
      }>(
        "SELECT id, channel_id, to_agent_id, task_message_id FROM dispatches WHERE id = $1 AND from_agent_id = $2 AND status = 'open'",
        [dispatchId, agentId],
      );
      if (found.rows.length === 0) return reply.status(404).send({ error: "no open dispatch owned by this agent" });
      const dispatch = found.rows[0];

      await app.pg.query("UPDATE dispatches SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [
        dispatchId,
      ]);
      // P1 同步：撤回 → 看板卡片关闭
      if (dispatch.task_message_id) {
        const cardUpd = await app.pg.query<{ task_number: number; old_status: string | null }>(
          `UPDATE messages m SET task_status = 'closed', updated_at = now()
             FROM (SELECT task_status AS old_status FROM messages WHERE id = $1) old
           WHERE m.id = $1
           RETURNING m.task_number, old.old_status`,
          [dispatch.task_message_id],
        );
        if (cardUpd.rows[0]) {
          await recordTaskEvent(app, {
            messageId: dispatch.task_message_id,
            channelId: dispatch.channel_id,
            taskNumber: cardUpd.rows[0].task_number,
            actorId: agentId,
            action: "status_changed",
            fromStatus: cardUpd.rows[0].old_status,
            toStatus: "closed",
            detail: `dispatch ${dispatchId} cancelled`,
          });
        }
      }

      const manager = await getAgent(app, agentId);
      const worker = await getAgent(app, dispatch.to_agent_id);
      if (!worker?.name) return reply.status(500).send({ error: "worker agent no longer exists" });
      const ch = await app.pg.query<{ id: string; server_id: string; name: string }>(
        "SELECT id, server_id, name FROM channels WHERE id = $1",
        [dispatch.channel_id],
      );
      await insertAndDeliver(
        app,
        dispatch.channel_id,
        ch.rows[0].server_id,
        ch.rows[0].name,
        agentId,
        manager,
        `🚫 @${worker.name} 经理 @${manager?.name || "manager"} 撤回了派给你的任务（dispatch ${dispatchId}）：${reason || "(无说明)"}`,
        worker.name,
      );
      // P1.26：worker daemon 离线时撤回不会被唤醒消费——经理 owner 侧立即 toast
      alarmIfDaemonOffline(ch.rows[0].name, manager, worker, "撤回通知");

      return { ok: true };
    },
  );

  // P1.26：经理验收（accept）——dispatch 合同的闭环端点。
  // 仅 dispatch 的经理（from_agent_id）可调用，且只接受 reported（worker 已回报）
  // 的合同；验收通过 → status='completed'（终态）+ completed_at，看板卡片
  // in_review → done。单语句条件更新保证状态转换原子（并发双 accept 只有一
  // 方命中，另一方 404）。
  app.post(
    "/:agentId/dispatch/:dispatchId/accept",
    { preHandler: [app.authenticate, requireOwnAgent] },
    async (req, reply) => {
      const agentId = (req.params as Record<string, string>).agentId;
      const dispatchId = (req.params as Record<string, string>).dispatchId;
      const { note } = req.body as { note?: string };

      const upd = await app.pg.query<{
        id: string;
        channel_id: string;
        to_agent_id: string;
        task_message_id: string | null;
      }>(
        `UPDATE dispatches SET status = 'completed', completed_at = now()
          WHERE id = $1 AND from_agent_id = $2 AND status = 'reported'
          RETURNING id, channel_id, to_agent_id, task_message_id`,
        [dispatchId, agentId],
      );
      if (upd.rows.length === 0) return reply.status(404).send({ error: "no reported dispatch owned by this agent" });
      const dispatch = upd.rows[0];

      // P1 同步：验收 → 看板卡片 done（closed 留给撤销/人工关闭语义）
      if (dispatch.task_message_id) {
        const cardUpd = await app.pg.query<{ task_number: number; old_status: string | null }>(
          `UPDATE messages m SET task_status = 'done', updated_at = now()
             FROM (SELECT task_status AS old_status FROM messages WHERE id = $1) old
           WHERE m.id = $1
           RETURNING m.task_number, old.old_status`,
          [dispatch.task_message_id],
        );
        if (cardUpd.rows[0]) {
          await recordTaskEvent(app, {
            messageId: dispatch.task_message_id,
            channelId: dispatch.channel_id,
            taskNumber: cardUpd.rows[0].task_number,
            actorId: agentId,
            action: "status_changed",
            fromStatus: cardUpd.rows[0].old_status,
            toStatus: "done",
            detail: `dispatch ${dispatchId} accepted`,
          });
        }
      }

      const manager = await getAgent(app, agentId);
      const worker = await getAgent(app, dispatch.to_agent_id);
      if (!worker?.name) return reply.status(500).send({ error: "worker agent no longer exists" });
      const ch = await app.pg.query<{ id: string; server_id: string; name: string }>(
        "SELECT id, server_id, name FROM channels WHERE id = $1",
        [dispatch.channel_id],
      );
      await insertAndDeliver(
        app,
        dispatch.channel_id,
        ch.rows[0].server_id,
        ch.rows[0].name,
        agentId,
        manager,
        `🎉 @${worker.name} 经理 @${manager?.name || "manager"} 验收通过了你的任务回报（dispatch ${dispatchId}）：${note || "(无备注)"}`,
        worker.name,
      );
      // P1.26：worker daemon 离线时验收通知不会被唤醒消费——经理 owner 侧立即 toast
      alarmIfDaemonOffline(ch.rows[0].name, manager, worker, "验收通知");

      return { ok: true };
    },
  );
}
