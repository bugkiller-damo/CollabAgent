import type { FastifyInstance } from "fastify";
import { getAgent, isChannelManager, requireOwnAgent } from "../lib/agent-helpers.js";
import { resolveChannel } from "../lib/channel.js";
import { resolvePeer } from "../lib/dm.js";
import { broadcast } from "../ws/handler.js";

const STATUSES = ["open", "reported", "cancelled"];

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
  const msg = result.rows[0];
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

    // P1 同步：dispatch 通知消息同时成为看板卡片（in_progress + assignee=worker），
    // 原子取号防并发重号；台账记 task_message_id 供 report/cancel 联动
    await app.pg.query(
      `UPDATE messages
         SET task_number = (SELECT COALESCE(MAX(task_number), 0) + 1 FROM messages
                            WHERE channel_id = $2 AND task_number IS NOT NULL),
             task_status = 'in_progress', task_assignee = $3, updated_at = now()
       WHERE id = $1`,
      [msgId, ch.id, peer.id],
    );
    await app.pg.query("UPDATE dispatches SET task_message_id = $1 WHERE id = $2", [msgId, dispatch.id]);

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
    let q = `SELECT id, channel_id, from_agent_id, to_agent_id, text, status, report_text, artifacts, created_at, reported_at, cancelled_at
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
        await app.pg.query("UPDATE messages SET task_status = 'in_review', updated_at = now() WHERE id = $1", [
          dispatch.task_message_id,
        ]);
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
        await app.pg.query("UPDATE messages SET task_status = 'closed', updated_at = now() WHERE id = $1", [
          dispatch.task_message_id,
        ]);
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

      return { ok: true };
    },
  );
}
