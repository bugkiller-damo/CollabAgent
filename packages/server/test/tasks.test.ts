import { describe, it, expect, afterAll } from "vitest";
import { api, registerUser, uniqHandle, cleanupTestData, closeSql } from "./helpers.js";

afterAll(async () => { await cleanupTestData(); await closeSql(); });

describe("tasks: 创建 / 认领 / 状态流转", () => {
  it("在频道里建任务、认领、推进状态", async () => {
    const a = await registerUser();
    const chName = uniqHandle(); // 复用前缀，cleanup 能清掉（created_by=测试用户）

    const create = await api("/api/channels", { method: "POST", token: a.token, body: { name: chName, description: "test ch" } });
    expect(create.status).toBe(200);

    const mkTask = await api("/api/tasks", { method: "POST", token: a.token, body: { channel: "#" + chName, tasks: [{ title: "写测试" }] } });
    expect(mkTask.status).toBe(200);
    const num = mkTask.data.tasks[0].task_number;
    expect(num).toBeGreaterThanOrEqual(1);

    const claim = await api("/api/tasks/claim", { method: "POST", token: a.token, body: { channel: "#" + chName, task_numbers: [num] } });
    expect(claim.status).toBe(200);
    expect(claim.data.results[0].status).toBe("claimed");

    const upd = await api("/api/tasks/update-status", { method: "POST", token: a.token, body: { channel: "#" + chName, number: num, status: "in_review" } });
    expect(upd.status).toBe(200);

    const list = await api(`/api/tasks?channel=${encodeURIComponent("#" + chName)}`, { token: a.token });
    expect(list.status).toBe(200);
    const t = list.data.tasks.find((x: any) => x.task_number === num);
    expect(t.task_status).toBe("in_review");
  });
});
