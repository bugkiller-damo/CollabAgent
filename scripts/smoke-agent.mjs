#!/usr/bin/env node
// Agent 能力冒烟测试：直接打 /internal/agent/:id/* 接口，验证“管道”是否通（不依赖 LLM 是否决定调用）。
// 用法：node scripts/smoke-agent.mjs [agentId]
//   BASE 环境变量可覆盖服务器地址（默认 http://localhost:3001）
// 鉴权用 dev-token（服务端 authenticate 接受 "Bearer dev-token"）。
// 会创建一个临时任务/反应并在结束时尽量清理。

const BASE = process.env.BASE || "http://localhost:3001";
const AUTH = { Authorization: "Bearer dev-token", "Content-Type": "application/json" };
let pass = 0, fail = 0;

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: AUTH, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${extra}`); }
}

const enc = encodeURIComponent;

async function main() {
  const agentId = process.argv[2] || (await api("GET", "/api/agents")).data?.agents?.[0]?.id;
  if (!agentId) { console.error("找不到 agent，先在 Agent 管理页创建一个"); process.exit(1); }
  const B = `/internal/agent/${agentId}`;
  const CH = "#general";
  console.log(`Agent=${agentId}  channel=${CH}  server=${BASE}\n`);

  console.log("[Phase 1] 收/读/服务器");
  check("server info", (await api("GET", `${B}/server`)).ok);
  check("receive", (await api("GET", `${B}/receive`)).ok);
  check("history", (await api("GET", `${B}/history?channel=${enc(CH)}&limit=3`)).ok);
  check("channel-members", (await api("GET", `${B}/channel-members?channel=${enc(CH)}`)).ok);

  console.log("[send] 发消息");
  const sent = await api("POST", `${B}/send`, { target: CH, content: "smoke-test 自动消息" });
  check("send", sent.ok, JSON.stringify(sent.data));
  const sentId = sent.data?.messageId;

  console.log("[Phase 3] 任务");
  const created = await api("POST", `${B}/tasks`, { channel: CH, tasks: [{ title: "smoke-test 任务" }] });
  const taskNum = created.data?.tasks?.[0]?.task_number;
  check("task create", created.ok && taskNum != null);
  check("task list", (await api("GET", `${B}/tasks?channel=${enc(CH)}`)).ok);
  check("task claim", (await api("POST", `${B}/tasks/claim`, { channel: CH, task_numbers: [taskNum] })).data?.results?.[0]?.status === "claimed");
  check("task update-status", (await api("POST", `${B}/tasks/update-status`, { channel: CH, number: taskNum, status: "in_review" })).ok);

  console.log("[Phase 3] 搜索 / 资料 / 表情");
  check("search", (await api("GET", `${B}/search?q=smoke&channel=${enc(CH)}`)).ok);
  const prof = await api("GET", `${B}/profile`);
  check("profile show", prof.ok);
  const origDesc = prof.data?.description ?? "";
  check("profile update", (await api("POST", `${B}/profile`, { description: "smoke-test 临时简介" })).ok);
  await api("POST", `${B}/profile`, { description: origDesc }); // 还原
  if (sentId) {
    check("reaction add", (await api("POST", `${B}/messages/${sentId}/reactions`, { emoji: "👍" })).ok);
    check("reaction remove", (await api("DELETE", `${B}/messages/${sentId}/reactions`, { emoji: "👍" })).ok);
  }

  // 清理：把临时任务关掉（无删除接口，置为 closed），临时消息留痕影响小
  if (taskNum != null) await api("POST", `${B}/tasks/update-status`, { channel: CH, number: taskNum, status: "closed" });

  console.log(`\n结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("脚本出错:", e.message); process.exit(1); });
