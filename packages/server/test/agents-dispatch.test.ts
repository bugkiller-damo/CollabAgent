import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { api, BASE, cleanupTestData, closeSql, registerUser, sql, type TestUser, uniqHandle } from "./helpers.js";

/**
 * P1.26：dispatch completed 终态 + 经理验收端点 + 看板卡片双向同步 + daemon 离线告警。
 *
 * 覆盖：派发建卡（open + in_progress + created 事件 + 离线告警 WS）、worker 回报
 * （reported + in_review + 经理侧离线告警）、worker 越权验收 404、经理验收
 * （completed + completed_at + 卡片 done + accepted 事件）、重复验收 404、
 * GET /dispatches 双视角与 status 过滤、撤销（cancelled + 卡片 closed）、
 * 卡片→dispatch 回向同步（人工 done→completed / closed→cancelled）、
 * 非经理派发 403、worker 停班 409。
 *
 * 离线告警用例依赖「worker/manager 的 owner daemon 不在线」——测试环境本就不连
 * daemon（daemonClients 为空），computerOnlineFor 恒 false，告警必然触发。
 */

const WS_BASE = BASE.replace(/^http/, "ws") + "/ws";

/** P1.25 同款持久收集器：连接即挂监听 + 队列缓冲 + nextOfType 按类型等待——
 * 不会丢「server 先于 HTTP 响应推送的 WS 事件」（评估 P1.25 实锤坑复用解法） */
function connectCollectorWs(cookie: string): {
  nextOfType: (type: string, timeout?: number) => Promise<any>;
  close: () => void;
} {
  const ws = new WebSocket(WS_BASE, { headers: { Cookie: cookie } });
  const queue: any[] = [];
  let pending: { type: string; resolve: (m: any) => void } | null = null;
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    // 应用层心跳照答不进队列；connected 欢迎帧同样跳过
    if (msg?.type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        /* ignore */
      }
      return;
    }
    if (msg?.type === "connected") return;
    if (pending && msg?.type === pending.type) {
      const p = pending;
      pending = null;
      p.resolve(msg);
      return;
    }
    queue.push(msg);
  });
  ws.on("unexpected-response", (_req, res) => {
    res.resume();
  });
  const nextOfType = (type: string, timeout = 8000) =>
    new Promise<any>((resolve, reject) => {
      const idx = queue.findIndex((m) => m?.type === type);
      if (idx >= 0) {
        resolve(queue.splice(idx, 1)[0]);
        return;
      }
      const timer = setTimeout(() => {
        if (pending?.type === type) pending = null;
        reject(new Error(`WS event ${type} timeout`));
      }, timeout);
      pending = {
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
    });
  const close = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
  return { nextOfType, close };
}

async function createAgent(owner: TestUser, name: string): Promise<string> {
  const r = await api("/api/agents", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { name, displayName: "Disp " + name },
  });
  expect(r.status).toBe(200);
  return r.data.agent.id as string;
}

describe("agents dispatch P1.26（completed 终态 + 验收 + 双向同步 + 离线告警）", () => {
  let manager: TestUser, worker: TestUser;
  let managerAgentId: string, workerAgentId: string, workerAgentName: string, managerAgentName: string;
  let channelId: string, channelName: string;
  let closeCollector: (() => void) | null = null;

  beforeAll(async () => {
    manager = await registerUser();
    worker = await registerUser();
    managerAgentName = uniqHandle();
    workerAgentName = uniqHandle();
    managerAgentId = await createAgent(manager, managerAgentName);
    workerAgentId = await createAgent(worker, workerAgentName);
    channelName = uniqHandle();
    const ch = await api("/api/channels", {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: { name: channelName, type: "public" },
    });
    expect(ch.status).toBe(200);
    channelId = ch.data.channel.id as string;
    // 跨用户 agent 入圈：invite 只收「频道同 server / 邀者自有」的 agent，
    // 测试直接种子 channel_members（invite 逻辑归 channels 套件）
    await sql`
      INSERT INTO channel_members (channel_id, member_id, member_type, role)
      VALUES (${channelId}, ${managerAgentId}::uuid, 'agent', 'member'),
             (${channelId}, ${workerAgentId}::uuid, 'agent', 'member')
      ON CONFLICT DO NOTHING`;
    await sql`UPDATE channel_members SET is_manager = true
       WHERE channel_id = ${channelId} AND member_id = ${managerAgentId}::uuid AND member_type = 'agent'`;
  });

  afterAll(async () => {
    closeCollector?.();
    await cleanupTestData();
    await closeSql();
  });

  async function createDispatch(text: string): Promise<{ id: string; status: string }> {
    const r = await api(`/internal/agent/${managerAgentId}/dispatch`, {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: { channel: channelName, toAgent: workerAgentName, text },
    });
    expect(r.status).toBe(200);
    return r.data.dispatch;
  }

  async function cardOf(dispatchId: string): Promise<{ id: string; task_number: number; task_status: string | null }> {
    const rows = await sql`
      SELECT m.id, m.task_number, m.task_status FROM messages m
      JOIN dispatches d ON d.task_message_id = m.id WHERE d.id = ${dispatchId}::uuid`;
    expect(rows.length).toBe(1);
    return rows[0] as any;
  }

  it("派发 → 台账 open + 卡片 in_progress/assignee + created 事件 + worker daemon 离线告警", async () => {
    const collector = connectCollectorWs(manager.cookie);
    closeCollector = collector.close;
    const dispatch = await createDispatch("修复登录页样式");
    expect(dispatch.status).toBe("open");

    const card = await cardOf(dispatch.id);
    expect(card.task_status).toBe("in_progress");
    expect(card.task_number).not.toBeNull();
    const assignee = await sql`SELECT task_assignee FROM messages WHERE id = ${card.id}`;
    expect(String(assignee[0].task_assignee)).toBe(workerAgentId);

    const ev = await sql`SELECT action, to_status FROM task_events WHERE message_id = ${card.id} ORDER BY created_at`;
    expect(ev.some((e: any) => e.action === "created" && e.to_status === "in_progress")).toBe(true);

    // worker 的 owner daemon 不在线（测试环境无 daemon 连接）→ 经理 owner 浏览器
    // 收到 dead-letter 同款告警，reason="daemon-offline"
    const alarm = await collector.nextOfType("agent:delivery-dead-letter");
    expect(alarm.agentName).toBe(workerAgentName);
    expect(alarm.reason).toBe("daemon-offline");
    expect(String(alarm.error)).toContain("离线");
  });

  it("worker 回报 → reported + 卡片 in_review + 经理 daemon 离线告警", async () => {
    const dispatch = await createDispatch("回报链路");
    const collector = connectCollectorWs(manager.cookie);
    closeCollector = collector.close;
    const r = await api(`/internal/agent/${workerAgentId}/dispatch/${dispatch.id}/report`, {
      method: "POST",
      cookie: worker.cookie,
      csrf: worker.csrf,
      body: { reportText: "已完成" },
    });
    expect(r.status).toBe(200);
    const row = await sql`SELECT status, report_text FROM dispatches WHERE id = ${dispatch.id}::uuid`;
    expect(row[0].status).toBe("reported");
    expect(row[0].report_text).toBe("已完成");
    const card = await cardOf(dispatch.id);
    expect(card.task_status).toBe("in_review");

    // 经理的 owner daemon 同样不在线 → 回报不会被唤醒消费，经理侧收到告警
    const alarm = await collector.nextOfType("agent:delivery-dead-letter");
    expect(alarm.agentName).toBe(managerAgentName);
    expect(alarm.reason).toBe("daemon-offline");
  });

  it("worker 尝试验收 → 404（验收是经理专属）", async () => {
    const dispatch = await createDispatch("越权验收");
    const r = await api(`/internal/agent/${workerAgentId}/dispatch/${dispatch.id}/accept`, {
      method: "POST",
      cookie: worker.cookie,
      csrf: worker.csrf,
      body: {},
    });
    expect(r.status).toBe(404);
  });

  it("经理验收 → completed + completed_at + 卡片 done + accepted 事件", async () => {
    const dispatch = await createDispatch("待验收");
    await api(`/internal/agent/${workerAgentId}/dispatch/${dispatch.id}/report`, {
      method: "POST",
      cookie: worker.cookie,
      csrf: worker.csrf,
      body: { reportText: "done" },
    });
    const r = await api(`/internal/agent/${managerAgentId}/dispatch/${dispatch.id}/accept`, {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: { note: "干得漂亮" },
    });
    expect(r.status).toBe(200);
    const row = await sql`SELECT status, completed_at FROM dispatches WHERE id = ${dispatch.id}::uuid`;
    expect(row[0].status).toBe("completed");
    expect(row[0].completed_at).not.toBeNull();
    const card = await cardOf(dispatch.id);
    expect(card.task_status).toBe("done");
    const ev =
      await sql`SELECT action, to_status, detail FROM task_events WHERE message_id = ${card.id} ORDER BY created_at`;
    expect(ev.some((e: any) => e.to_status === "done" && String(e.detail).includes("accepted"))).toBe(true);
  });

  it("重复验收 → 404（reported 只能被验收一次，终态不可再入）", async () => {
    const dispatch = await createDispatch("重复验收");
    await api(`/internal/agent/${workerAgentId}/dispatch/${dispatch.id}/report`, {
      method: "POST",
      cookie: worker.cookie,
      csrf: worker.csrf,
      body: { reportText: "done" },
    });
    const r1 = await api(`/internal/agent/${managerAgentId}/dispatch/${dispatch.id}/accept`, {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: {},
    });
    expect(r1.status).toBe(200);
    const r2 = await api(`/internal/agent/${managerAgentId}/dispatch/${dispatch.id}/accept`, {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: {},
    });
    expect(r2.status).toBe(404);
  });

  it("GET /dispatches 双视角 + status=completed 过滤 + completed_at 回显", async () => {
    const asManager = await api(
      `/internal/agent/${managerAgentId}/dispatches?channel=${channelName}&status=completed`,
      { cookie: manager.cookie },
    );
    expect(asManager.status).toBe(200);
    expect(asManager.data.dispatches.length).toBeGreaterThanOrEqual(1);
    expect(asManager.data.dispatches[0].status).toBe("completed");
    expect(asManager.data.dispatches[0].completed_at).toBeTruthy();

    const asWorker = await api(`/internal/agent/${workerAgentId}/dispatches?channel=${channelName}`, {
      cookie: worker.cookie,
    });
    expect(asWorker.status).toBe(200);
    expect(asWorker.data.dispatches.length).toBeGreaterThanOrEqual(1);
  });

  it("撤销 → cancelled + 卡片 closed", async () => {
    const dispatch = await createDispatch("要撤销");
    const r = await api(`/internal/agent/${managerAgentId}/dispatch/${dispatch.id}/cancel`, {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: { reason: "不需要了" },
    });
    expect(r.status).toBe(200);
    const row = await sql`SELECT status FROM dispatches WHERE id = ${dispatch.id}::uuid`;
    expect(row[0].status).toBe("cancelled");
    const card = await cardOf(dispatch.id);
    expect(card.task_status).toBe("closed");
  });

  it("卡片→dispatch 回向同步：人工置 done → completed；置 closed → cancelled", async () => {
    const d1 = await createDispatch("人工 done");
    const c1 = await cardOf(d1.id);
    const r1 = await api("/api/tasks/update-status", {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: { channel: channelName, number: c1.task_number, status: "done" },
    });
    expect(r1.status).toBe(200);
    const row1 = await sql`SELECT status, completed_at FROM dispatches WHERE id = ${d1.id}::uuid`;
    expect(row1[0].status).toBe("completed");
    expect(row1[0].completed_at).not.toBeNull();

    const d2 = await createDispatch("人工 closed");
    const c2 = await cardOf(d2.id);
    const r2 = await api("/api/tasks/update-status", {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: { channel: channelName, number: c2.task_number, status: "closed" },
    });
    expect(r2.status).toBe(200);
    const row2 = await sql`SELECT status, cancelled_at FROM dispatches WHERE id = ${d2.id}::uuid`;
    expect(row2[0].status).toBe("cancelled");
    expect(row2[0].cancelled_at).not.toBeNull();
  });

  it("非经理 agent 派发 → 403", async () => {
    const r = await api(`/internal/agent/${workerAgentId}/dispatch`, {
      method: "POST",
      cookie: worker.cookie,
      csrf: worker.csrf,
      body: { channel: channelName, toAgent: managerAgentName, text: "反向派发" },
    });
    expect(r.status).toBe(403);
  });

  it("worker 停班 → 409；复班恢复", async () => {
    const off = await api(`/api/agents/${workerAgentId}/duty`, {
      method: "POST",
      cookie: worker.cookie,
      csrf: worker.csrf,
      body: { duty: "off" },
    });
    expect(off.status).toBe(200);
    const r = await api(`/internal/agent/${managerAgentId}/dispatch`, {
      method: "POST",
      cookie: manager.cookie,
      csrf: manager.csrf,
      body: { channel: channelName, toAgent: workerAgentName, text: "对停班 worker 派发" },
    });
    expect(r.status).toBe(409);
    const on = await api(`/api/agents/${workerAgentId}/duty`, {
      method: "POST",
      cookie: worker.cookie,
      csrf: worker.csrf,
      body: { duty: "on" },
    });
    expect(on.status).toBe(200);
  });
});
