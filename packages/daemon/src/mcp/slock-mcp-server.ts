import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Slock 平台的 MCP server（独立进程，由 Claude Code 通过 `.mcp.json` 以 stdio
 * 方式拉起，跟随 Claude Code 进程生命周期退出）。
 *
 * 见 docs/2026-07-16/12-mcp-server-plan.md。目的：把之前只能靠"教 agent 敲
 * `slock message send --target X`（内容从 stdin 传入）"这种纯文字指令 + Bash
 * 工具 + PTY 键盘输入模拟的链路，换成结构化、带 JSON Schema 的工具调用——
 * 这条链路（bracketed paste / 粘贴确认 / 回车时序 / shell 转义）正是这次会话
 * 第 4/12 个 bug 的根源，MCP 调用走 stdio 函数调用，完全绕开这些环节。
 *
 * 认证：完全复用 P1 的 scoped runtime token（`sk_agent_...`，见
 * agent-runtime-credentials.ts）——daemon spawn 时连同 SLOCK_AGENT_ID/
 * SLOCK_SERVER_URL 一起注入这个 MCP server 子进程的 env，跟 `slock` CLI
 * 用的是同一套凭证，服务端不需要任何改动。
 *
 * 首批只覆盖"高频 + 中频"操作（见方案文档的优先级表）；低频操作
 * （profile/integration/upload/list_reminders/cancel_reminder 等）继续留给
 * `slock` CLI 兜底——两条路长期并存，不强制迁移。
 */

const AGENT_ID = process.env.SLOCK_AGENT_ID;
const AGENT_TOKEN = process.env.SLOCK_AGENT_TOKEN;
const SERVER_URL = process.env.SLOCK_SERVER_URL;

if (!AGENT_ID || !AGENT_TOKEN || !SERVER_URL) {
  console.error(
    "[slock-mcp] missing SLOCK_AGENT_ID / SLOCK_AGENT_TOKEN / SLOCK_SERVER_URL env, cannot start",
  );
  process.exit(1);
}

async function callSlock(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${SERVER_URL}/internal/agent/${AGENT_ID}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    // 尽量把服务端返回的 JSON 错误体（{error: "..."}）展开成可读文字，
    // 而不是直接把 HTTP 状态码扔给 agent——见方案文档"调试"一节。
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch { /* 非 JSON 错误体，原样使用 */ }
    throw new Error(`${res.status} ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

/** multipart 上传专用（callSlock 是 JSON-only）：/upload 端点收 multipart/form-data */
async function callSlockUpload(path: string, form: FormData): Promise<unknown> {
  const res = await fetch(`${SERVER_URL}/internal/agent/${AGENT_ID}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` }, // 不要手动设 content-type，fetch 会自动带 boundary
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch { /* ignore */ }
    throw new Error(`${res.status} ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `slock 调用失败：${message}` }], isError: true };
}

const server = new McpServer({ name: "slock", version: "0.1.0" });

server.registerTool(
  "send_message",
  {
    title: "发送消息",
    description: "在指定频道/线程/私信里发一条消息",
    inputSchema: {
      target: z.string().describe('目标：频道（如 "#general"）、频道内线程（如 "#general:threadId"）、或私信（如 "dm:@handle"）'),
      content: z.string().describe("消息正文"),
      threadId: z.string().optional().describe("可选：显式指定线程 id"),
      attachmentIds: z.array(z.string()).optional().describe("可选：随消息附带的附件 id 列表（先用 upload_attachment 上传获得）"),
    },
  },
  async ({ target, content, threadId, attachmentIds }) => {
    try {
      const result = await callSlock("/send", {
        method: "POST",
        body: JSON.stringify({ target, content, threadId, attachmentIds }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "upload_attachment",
  {
    title: "上传附件",
    description: "上传一个本地文件，返回 attachmentId（之后用 send_message 的 attachmentIds 随消息发出）",
    inputSchema: {
      path: z.string().describe("本地文件绝对路径，如 D:\\docs\\report.pdf"),
    },
  },
  async ({ path }) => {
    try {
      const buf = await readFile(path);
      const form = new FormData();
      form.append("file", new Blob([buf]), basename(path));
      const result = await callSlockUpload("/upload", form);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_tasks",
  {
    title: "查看任务",
    description: "列出指定频道的任务板",
    inputSchema: {
      channel: z.string().describe('频道名，如 "#general"'),
      status: z.enum(["todo", "in_progress", "in_review", "done", "closed"]).optional().describe("可选：按状态过滤"),
    },
  },
  async ({ channel, status }) => {
    try {
      const qs = new URLSearchParams({ channel, ...(status ? { status } : {}) });
      const result = await callSlock(`/tasks?${qs.toString()}`);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "create_tasks",
  {
    title: "创建任务",
    description: "在指定频道创建一个或多个任务",
    inputSchema: {
      channel: z.string().describe('频道名，如 "#general"'),
      titles: z.array(z.string()).min(1).describe("任务标题列表"),
    },
  },
  async ({ channel, titles }) => {
    try {
      const result = await callSlock("/tasks", {
        method: "POST",
        body: JSON.stringify({ channel, tasks: titles.map((title) => ({ title })) }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "claim_tasks",
  {
    title: "认领任务",
    description: "认领指定频道的一个或多个任务（按任务编号）",
    inputSchema: {
      channel: z.string().describe('频道名，如 "#general"'),
      taskNumbers: z.array(z.number().int()).min(1).describe("要认领的任务编号列表"),
    },
  },
  async ({ channel, taskNumbers }) => {
    try {
      const result = await callSlock("/tasks/claim", {
        method: "POST",
        body: JSON.stringify({ channel, task_numbers: taskNumbers }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "update_task_status",
  {
    title: "更新任务状态",
    description: "更新指定任务的状态（todo/in_progress/in_review/done/closed）",
    inputSchema: {
      channel: z.string().describe('频道名，如 "#general"'),
      number: z.number().int().describe("任务编号"),
      status: z.enum(["todo", "in_progress", "in_review", "done", "closed"]),
    },
  },
  async ({ channel, number, status }) => {
    try {
      const result = await callSlock("/tasks/update-status", {
        method: "POST",
        body: JSON.stringify({ channel, number, status }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "unclaim_task",
  {
    title: "放弃认领任务",
    description: "取消对指定任务的认领",
    inputSchema: {
      channel: z.string().describe('频道名，如 "#general"'),
      taskNumber: z.number().int().describe("任务编号"),
    },
  },
  async ({ channel, taskNumber }) => {
    try {
      const result = await callSlock("/tasks/unclaim", {
        method: "POST",
        body: JSON.stringify({ channel, task_number: taskNumber }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "dispatch_task",
  {
    title: "派发任务",
    description: "把任务派给指定 worker agent（仅频道的指定经理可用）",
    inputSchema: {
      channel: z.string().describe('频道名，如 "#general"'),
      toAgent: z.string().describe("worker agent 的 handle（不带 @）"),
      text: z.string().describe("任务内容"),
    },
  },
  async ({ channel, toAgent, text }) => {
    try {
      const result = await callSlock("/dispatch", {
        method: "POST",
        body: JSON.stringify({ channel, toAgent, text }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_dispatches",
  {
    title: "查看派发任务",
    description: "列出指定频道里跟自己相关的派发任务（经理看自己派的，worker 看分给自己的）",
    inputSchema: {
      channel: z.string().describe('频道名，如 "#general"'),
      status: z.enum(["open", "reported", "cancelled"]).optional().describe("可选：按状态过滤"),
    },
  },
  async ({ channel, status }) => {
    try {
      const qs = new URLSearchParams({ channel, ...(status ? { status } : {}) });
      const result = await callSlock(`/dispatches?${qs.toString()}`);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "report_task",
  {
    title: "回报任务",
    description: "回报一个分给自己的派发任务的完成情况",
    inputSchema: {
      dispatchId: z.string().describe("dispatch id"),
      reportText: z.string().describe("回报内容"),
      artifacts: z.array(z.string()).optional().describe("可选：产出物列表"),
    },
  },
  async ({ dispatchId, reportText, artifacts }) => {
    try {
      const result = await callSlock(`/dispatch/${dispatchId}/report`, {
        method: "POST",
        body: JSON.stringify({ reportText, artifacts }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "cancel_dispatch",
  {
    title: "撤回派发任务",
    description: "撤回自己派发的一个未完成任务（仅任务的经理可用）",
    inputSchema: {
      dispatchId: z.string().describe("dispatch id"),
      reason: z.string().optional().describe("可选：撤回原因"),
    },
  },
  async ({ dispatchId, reason }) => {
    try {
      const result = await callSlock(`/dispatch/${dispatchId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "read_history",
  {
    title: "读取历史消息",
    description: "读取指定频道/私信的最近消息记录",
    inputSchema: {
      channel: z.string().describe('目标：频道（如 "#general"）或私信（如 "dm:@handle"）'),
      limit: z.number().int().min(1).max(100).optional().describe("条数（默认 30，上限 100）"),
    },
  },
  async ({ channel, limit }) => {
    try {
      const qs = new URLSearchParams({ channel, limit: String(limit || 30) });
      const result = await callSlock(`/history?${qs.toString()}`);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "check_messages",
  {
    title: "查收新消息",
    description: "查收自上次查收以来发给你的新消息（含频道 @ 与私信；查收后游标前移，重复调用只拿增量）",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await callSlock("/receive");
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "search_messages",
  {
    title: "搜索消息",
    description: "在你有权限的频道里按关键词搜索消息",
    inputSchema: {
      query: z.string().describe("搜索关键词"),
      channel: z.string().optional().describe('可选：限定频道（如 "#general"）'),
      limit: z.number().int().min(1).max(50).optional().describe("条数（默认 20）"),
    },
  },
  async ({ query, channel, limit }) => {
    try {
      const qs = new URLSearchParams({ q: query, ...(channel ? { channel } : {}), ...(limit ? { limit: String(limit) } : {}) });
      const result = await callSlock(`/search?${qs.toString()}`);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "schedule_reminder",
  {
    title: "设置提醒",
    description: "设置一个未来触发的提醒（到点会重新唤醒你处理）",
    inputSchema: {
      title: z.string().describe("提醒标题"),
      delaySeconds: z.number().int().positive().optional().describe("多少秒后触发（与 fireAt 二选一）"),
      fireAt: z.string().optional().describe("ISO 时间字符串（与 delaySeconds 二选一）"),
      channel: z.string().optional().describe('可选：关联频道，如 "#general"'),
    },
  },
  async ({ title, delaySeconds, fireAt, channel }) => {
    try {
      const result = await callSlock("/reminders", {
        method: "POST",
        body: JSON.stringify({ title, delaySeconds, fireAt, channel }),
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_reminders",
  {
    title: "列出提醒",
    description: "列出你设置过的提醒（默认只看未到期的）",
    inputSchema: {
      status: z.enum(["scheduled", "all"]).optional().describe("scheduled=只看待触发（默认）；all=含已触发/已取消"),
    },
  },
  async ({ status }) => {
    try {
      const qs = status ? new URLSearchParams({ status }) : undefined;
      const result = await callSlock(`/reminders${qs ? "?" + qs.toString() : ""}`);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "cancel_reminder",
  {
    title: "取消提醒",
    description: "取消一个未到期的提醒",
    inputSchema: {
      reminderId: z.string().describe("提醒 id（用 list_reminders 查询获得）"),
    },
  },
  async ({ reminderId }) => {
    try {
      const result = await callSlock(`/reminders/${encodeURIComponent(reminderId)}`, { method: "DELETE" });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  },
);

// 不用顶层 await：esbuild 打包成 cjs 格式不支持顶层 await（`node18` target 下
// 会直接编译失败），包一层立即执行的 async 函数。
void (async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
