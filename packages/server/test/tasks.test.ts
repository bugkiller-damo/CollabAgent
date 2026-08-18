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
