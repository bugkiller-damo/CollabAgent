import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupTestData, closeSql, registerUser, uniqHandle } from "./helpers.js";

afterAll(async () => {
  await cleanupTestData();
  await closeSql();
});

describe("tasks: 创建 / 认领 / 状态流转", () => {
  it("在频道里建任务、认领、推进状态", async () => {
    const a = await registerUser();
    const chName = uniqHandle(); // 复用前缀，cleanup 能清掉（created_by=测试用户）

    const create = await api("/api/channels", {
      method: "POST",
      cookie: a.cookie,
      body: { name: chName, description: "test ch" },
    });
    expect(create.status).toBe(200);

    const mkTask = await api("/api/tasks", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, tasks: [{ title: "写测试" }] },
    });
    expect(mkTask.status).toBe(200);
    const num = mkTask.data.tasks[0].task_number;
    expect(num).toBeGreaterThanOrEqual(1);

    const claim = await api("/api/tasks/claim", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, task_numbers: [num] },
    });
    expect(claim.status).toBe(200);
    expect(claim.data.results[0].status).toBe("claimed");

    const upd = await api("/api/tasks/update-status", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, number: num, status: "in_review" },
    });
    expect(upd.status).toBe(200);

    const list = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    expect(list.status).toBe(200);
    const t = list.data.tasks.find((x: any) => x.task_number === num);
    expect(t.task_status).toBe("in_review");
  });
});

describe("tasks: 消息转任务（from-message）", () => {
  it("既有消息可转为任务并出现在看板，重复转换 409，消息不存在 404", async () => {
    const a = await registerUser();
    const chName = uniqHandle();
    const create = await api("/api/channels", {
      method: "POST",
      cookie: a.cookie,
      body: { name: chName, description: "test ch" },
    });
    expect(create.status).toBe(200);

    // 先发一条普通消息
    const send = await api("/api/messages/send", {
      method: "POST",
      cookie: a.cookie,
      body: { target: "#" + chName, content: "这个需求做成任务吧" },
    });
    expect(send.status).toBe(200);
    const messageId = send.data.messageId;
    expect(messageId).toBeTruthy();

    // 转为任务
    const conv = await api("/api/tasks/from-message", {
      method: "POST",
      cookie: a.cookie,
      body: { message_id: messageId },
    });
    expect(conv.status).toBe(200);
    expect(conv.data.task.task_number).toBeGreaterThanOrEqual(1);
    expect(conv.data.task.task_status).toBe("todo");

    // 看板里能查到（同一条消息，不是新建副本）
    const list = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    const t = list.data.tasks.find((x: any) => x.id === messageId);
    expect(t, "看板任务应复用原消息行").toBeTruthy();
    expect(t.task_number).toBe(conv.data.task.task_number);

    // 重复转换 → 409
    const dup = await api("/api/tasks/from-message", {
      method: "POST",
      cookie: a.cookie,
      body: { message_id: messageId },
    });
    expect(dup.status).toBe(409);

    // 消息不存在 → 404
    const missing = await api("/api/tasks/from-message", {
      method: "POST",
      cookie: a.cookie,
      body: { message_id: crypto.randomUUID() },
    });
    expect(missing.status).toBe(404);
  });
});

describe("tasks: dispatch 派发同步看板（P1）", () => {
  it("派发建卡片(in_progress)→回报(in_review)；再派发→撤回(closed)", async () => {
    const a = await registerUser();
    const run = uniqHandle().replace(/[^a-zA-Z0-9]/g, "");
    const chName = uniqHandle();
    await api("/api/channels", {
      method: "POST",
      cookie: a.cookie,
      body: { name: chName, description: "dispatch sync" },
    });

    // 建经理 + worker 两个 agent 并拉进频道
    const mk = async (name: string) => {
      const r = await api("/api/agents", {
        method: "POST",
        cookie: a.cookie,
        body: { name, runtime: "claude", model: "sonnet" },
      });
      expect(r.status).toBe(200);
      return r.data.agent;
    };
    const mgr = await mk(`mgr${run}`);
    const wkr = await mk(`wkr${run}`);

    const ch = await api("/api/channels/resolve?target=" + encodeURIComponent("#" + chName), { cookie: a.cookie });
    const channelId = ch.data.id;
    for (const ag of [mgr, wkr]) {
      const inv = await api(`/api/channels/${channelId}/invite`, {
        method: "POST",
        cookie: a.cookie,
        body: { handle: ag.name },
      });
      expect(inv.status).toBe(200);
    }
    // 指定经理
    const pm = await api(`/api/channels/${channelId}/members/${mgr.id}`, {
      method: "PATCH",
      cookie: a.cookie,
      body: { is_manager: true },
    });
    expect(pm.status).toBe(200);

    // 派发 → 看板出现 in_progress 卡片，assignee 是 worker
    const d1 = await api(`/internal/agent/${mgr.id}/dispatch`, {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, toAgent: wkr.name, text: "做个登录页" },
    });
    expect(d1.status).toBe(200);
    const list1 = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    expect(list1.data.tasks.length).toBe(1);
    const card = list1.data.tasks[0];
    expect(card.task_status).toBe("in_progress");
    expect(card.assignee_handle).toBe(wkr.name);
    expect(card.content).toContain("做个登录页");

    // 回报 → in_review
    const rep = await api(`/internal/agent/${wkr.id}/dispatch/${d1.data.dispatch.id}/report`, {
      method: "POST",
      cookie: a.cookie,
      body: { reportText: "已完成" },
    });
    expect(rep.status).toBe(200);
    const list2 = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    expect(list2.data.tasks.find((t: any) => t.task_number === card.task_number).task_status).toBe("in_review");

    // 人类在看板把 agent 创建的任务标为 done：创建者是 agent，无通知中心，
    // 通知写入必须跳过而不是外键违约 500
    const done = await api("/api/tasks/update-status", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, number: card.task_number, status: "done" },
    });
    expect(done.status).toBe(200);
    const list2b = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    expect(list2b.data.tasks.find((t: any) => t.task_number === card.task_number).task_status).toBe("done");

    // 再派发一条 → 撤回 → closed，且新卡取号不冲突
    const d2 = await api(`/internal/agent/${mgr.id}/dispatch`, {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, toAgent: wkr.name, text: "再做个设置页" },
    });
    expect(d2.status).toBe(200);
    const cancel = await api(`/internal/agent/${mgr.id}/dispatch/${d2.data.dispatch.id}/cancel`, {
      method: "POST",
      cookie: a.cookie,
      body: { reason: "不需要了" },
    });
    expect(cancel.status).toBe(200);
    const list3 = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    expect(list3.data.tasks.length).toBe(2);
    const nums = list3.data.tasks.map((t: any) => t.task_number);
    expect(new Set(nums).size).toBe(2); // 无重号
    const closed = list3.data.tasks.find((t: any) => t.content.includes("设置页"));
    expect(closed.task_status).toBe("closed");
  });
});

describe("tasks: 操作历史 + 批注（detail/comments）", () => {
  it("创建→认领→改状态后 GET /detail 返回完整事件流；列表含 sender_id/sender_type", async () => {
    const a = await registerUser();
    const chName = uniqHandle();
    await api("/api/channels", { method: "POST", cookie: a.cookie, body: { name: chName, description: "" } });

    const mk = await api("/api/tasks", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, tasks: [{ title: "带历史的任务" }] },
    });
    expect(mk.status).toBe(200);
    const num = mk.data.tasks[0].task_number;

    // 列表响应带 sender_id / sender_type（创建者筛选的数据源）
    const list = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    const row = list.data.tasks.find((t: any) => t.task_number === num);
    expect(row.sender_id).toBeTruthy();
    expect(row.sender_type).toBe("human");
    const messageId = row.id;

    await api("/api/tasks/claim", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, task_numbers: [num] },
    });
    await api("/api/tasks/update-status", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, number: num, status: "in_review" },
    });

    const detail = await api(`/api/tasks/detail?message_id=${messageId}`, { cookie: a.cookie });
    expect(detail.status).toBe(200);
    expect(detail.data.task.task_number).toBe(num);
    expect(detail.data.task.creator_name).toBeTruthy();
    const actions = detail.data.events.map((e: any) => e.action);
    expect(actions).toEqual(["created", "claimed", "status_changed"]);
    const sc = detail.data.events.find((e: any) => e.action === "status_changed");
    expect(sc.from_status).toBe("in_progress");
    expect(sc.to_status).toBe("in_review");
    for (const e of detail.data.events) expect(e.actor_name).toBeTruthy();
  });

  it("批注：写两条按序返回，空内容 400，超长 400", async () => {
    const a = await registerUser();
    const chName = uniqHandle();
    await api("/api/channels", { method: "POST", cookie: a.cookie, body: { name: chName, description: "" } });
    const mk = await api("/api/tasks", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, tasks: [{ title: "批注目标" }] },
    });
    expect(mk.status).toBe(200);
    const list = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    const messageId = list.data.tasks[0].id;

    const c1 = await api("/api/tasks/comments", {
      method: "POST",
      cookie: a.cookie,
      body: { message_id: messageId, content: "第一条批注" },
    });
    expect(c1.status).toBe(200);
    expect(c1.data.comment.author_name).toBeTruthy();
    await api("/api/tasks/comments", {
      method: "POST",
      cookie: a.cookie,
      body: { message_id: messageId, content: "第二条批注" },
    });

    const detail = await api(`/api/tasks/detail?message_id=${messageId}`, { cookie: a.cookie });
    expect(detail.data.comments.map((c: any) => c.content)).toEqual(["第一条批注", "第二条批注"]);

    const empty = await api("/api/tasks/comments", {
      method: "POST",
      cookie: a.cookie,
      body: { message_id: messageId, content: "   " },
    });
    expect(empty.status).toBe(400);
    const tooLong = await api("/api/tasks/comments", {
      method: "POST",
      cookie: a.cookie,
      body: { message_id: messageId, content: "x".repeat(2001) },
    });
    expect(tooLong.status).toBe(400);
  });

  it("非任务消息调 /detail 与 /comments 均 404", async () => {
    const a = await registerUser();
    const chName = uniqHandle();
    await api("/api/channels", { method: "POST", cookie: a.cookie, body: { name: chName, description: "" } });
    const send = await api("/api/messages/send", {
      method: "POST",
      cookie: a.cookie,
      body: { target: "#" + chName, content: "普通消息不是任务" },
    });
    expect(send.status).toBe(200);
    const messageId = send.data.messageId;
    const d = await api(`/api/tasks/detail?message_id=${messageId}`, { cookie: a.cookie });
    expect(d.status).toBe(404);
    const c = await api("/api/tasks/comments", {
      method: "POST",
      cookie: a.cookie,
      body: { message_id: messageId, content: "hi" },
    });
    expect(c.status).toBe(404);
  });
});

// P0.5：claim 条件更新（双 claim 只有一个成功）+ 取号互斥（advisory lock）+ 唯一索引兜底
describe("P0.5: claim 条件更新与取号唯一性", () => {
  async function setupChannelWithTask(taskCount = 1) {
    const a = await registerUser();
    const chName = uniqHandle();
    const create = await api("/api/channels", { method: "POST", cookie: a.cookie, body: { name: chName } });
    expect(create.status).toBe(200);
    const mk = await api("/api/tasks", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, tasks: Array.from({ length: taskCount }, (_, i) => ({ title: `t${i}` })) },
    });
    expect(mk.status).toBe(200);
    return { a, chName, nums: (mk.data.tasks as any[]).map((t) => t.task_number) };
  }

  it("双 claim 串行：第二人 already_claimed_by_other；done 后 claim → task_is_done", async () => {
    const { a, chName, nums } = await setupChannelWithTask();
    const num = nums[0];
    const b = await registerUser();

    const c1 = await api("/api/tasks/claim", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, task_numbers: [num] },
    });
    expect(c1.data.results[0]).toMatchObject({ status: "claimed" });

    const c2 = await api("/api/tasks/claim", {
      method: "POST",
      cookie: b.cookie,
      body: { channel: "#" + chName, task_numbers: [num] },
    });
    expect(c2.data.results[0]).toEqual({ number: num, status: "conflict", error: "already_claimed_by_other" });

    await api("/api/tasks/update-status", {
      method: "POST",
      cookie: a.cookie,
      body: { channel: "#" + chName, number: num, status: "done" },
    });
    const c3 = await api("/api/tasks/claim", {
      method: "POST",
      cookie: b.cookie,
      body: { channel: "#" + chName, task_numbers: [num] },
    });
    expect(c3.data.results[0]).toEqual({ number: num, status: "conflict", error: "task_is_done" });
  });

  it("并发双 claim：恰好一个成功", async () => {
    const { a, chName, nums } = await setupChannelWithTask();
    const b = await registerUser();
    const num = nums[0];
    const [r1, r2] = await Promise.all([
      api("/api/tasks/claim", {
        method: "POST",
        cookie: a.cookie,
        body: { channel: "#" + chName, task_numbers: [num] },
      }),
      api("/api/tasks/claim", {
        method: "POST",
        cookie: b.cookie,
        body: { channel: "#" + chName, task_numbers: [num] },
      }),
    ]);
    const statuses = [r1.data.results[0].status, r2.data.results[0].status].sort();
    expect(statuses).toEqual(["claimed", "conflict"]);
    const errs = [r1.data.results[0].error, r2.data.results[0].error].filter(Boolean);
    expect(errs).toEqual(["already_claimed_by_other"]);
  });

  it("并发建任务：取号互不重复且看板连号（advisory lock + 唯一索引兜底）", async () => {
    const a = await registerUser();
    const chName = uniqHandle();
    await api("/api/channels", { method: "POST", cookie: a.cookie, body: { name: chName } });
    const rs = await Promise.all(
      Array.from({ length: 6 }, () =>
        api("/api/tasks", {
          method: "POST",
          cookie: a.cookie,
          body: { channel: "#" + chName, tasks: [{ title: "x" }] },
        }),
      ),
    );
    for (const r of rs) expect(r.status).toBe(200);
    const nums = rs.flatMap((r) => r.data.tasks.map((t: any) => t.task_number));
    expect(new Set(nums).size).toBe(nums.length);

    const list = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { cookie: a.cookie });
    const board = (list.data.tasks as any[]).map((t) => t.task_number).sort((x, y) => x - y);
    expect(board).toEqual(board.map((_, i) => i + 1));
  });

  it("agent 侧 claim 同样走条件更新（agent A 认领后 agent B 冲突）", async () => {
    const owner = await registerUser();
    const chName = uniqHandle();
    await api("/api/channels", { method: "POST", cookie: owner.cookie, body: { name: chName } });
    const mkTask = await api("/api/tasks", {
      method: "POST",
      cookie: owner.cookie,
      body: { channel: "#" + chName, tasks: [{ title: "agent claim" }] },
    });
    const num = mkTask.data.tasks[0].task_number;

    const mkAgent = async (name: string) => {
      const r = await api("/api/agents", {
        method: "POST",
        cookie: owner.cookie,
        csrf: owner.csrf,
        body: { name, displayName: name },
      });
      expect(r.status).toBe(200);
      const agent = r.data.agent;
      const j = await api(`/internal/agent/${agent.id}/channels/${chName}/join`, {
        method: "POST",
        cookie: owner.cookie,
        csrf: owner.csrf,
      });
      expect(j.status).toBe(200);
      return agent;
    };
    const agA = await mkAgent("tk_a_" + uniqHandle());
    const agB = await mkAgent("tk_b_" + uniqHandle());

    const c1 = await api(`/internal/agent/${agA.id}/tasks/claim`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { channel: "#" + chName, task_numbers: [num] },
    });
    expect(c1.data.results[0].status).toBe("claimed");

    const c2 = await api(`/internal/agent/${agB.id}/tasks/claim`, {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { channel: "#" + chName, task_numbers: [num] },
    });
    expect(c2.data.results[0]).toEqual({ number: num, status: "conflict", error: "already_claimed_by_other" });
  });
});
