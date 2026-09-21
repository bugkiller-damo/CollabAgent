import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { splitMessageContent } from "./message-split.js";
import { prepareUpload } from "./upload-payload.js";

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
// O11：token 优先从文件读（.mcp.json 里只配 SLOCK_AGENT_TOKEN_FILE 路径，
// 明文 token 不进任何进程 env / 配置文件）；SLOCK_AGENT_TOKEN 字面量为旧版兼容兜底。
// **每次请求重读文件**：daemon 每条 dispatch 都轮换 scoped token 并覆写 token
// 文件（服务端 upsert，旧 token 立即失效）。常驻进程（persistent claude 的 MCP
// 子进程跟随 claude 进程生命周期）若启动时缓存一次，第二轮 dispatch 起全部
// 401「Invalid or expired agent token」（2026-08-18 真机实测，turn 2 回复丢失）。
const readAgentToken = (): string | undefined => {
  const file = process.env.SLOCK_AGENT_TOKEN_FILE;
  if (file) {
    try {
      const t = readFileSync(file, "utf-8").trim();
      if (t) return t;
    } catch {
      /* 落到 env 兜底 */
    }
  }
  return process.env.SLOCK_AGENT_TOKEN;
};
const SERVER_URL = process.env.SLOCK_SERVER_URL;

if (!AGENT_ID || !readAgentToken() || !SERVER_URL) {
  console.error(
    "[slock-mcp] missing SLOCK_AGENT_ID / SLOCK_AGENT_TOKEN_FILE(or SLOCK_AGENT_TOKEN) / SLOCK_SERVER_URL env, cannot start",
  );
  process.exit(1);
}

/** 每次调用重读 token（见 readAgentToken 注释）；读不到时给 agent 可读的错误 */
const requireToken = (): string => {
  const t = readAgentToken();
  if (!t) throw new Error("[slock-mcp] agent token unavailable (token file empty or unreadable)");
  return t;
};

async function callSlock(path: string, init?: RequestInit): Promise<unknown> {
  // content-type: application/json 只在有 body 时带——无 body 的 DELETE/POST 若带
  // JSON content-type，Fastify 会报 400 "Body cannot be empty"（2026-07-29 实测
  // cancel_reminder 中招，agent 反复重试白烧 token）。
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${requireToken()}`,
  };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${SERVER_URL}/internal/agent/${AGENT_ID}${path}`, {
    ...init,
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    // 尽量把服务端返回的 JSON 错误体（{error: "..."}）展开成可读文字，
    // 而不是直接把 HTTP 状态码扔给 agent——见方案文档"调试"一节。
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch {
      /* 非 JSON 错误体，原样使用 */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

/** multipart 上传专用（callSlock 是 JSON-only）：/upload 端点收 multipart/form-data */
async function callSlockUpload(path: string, form: FormData): Promise<unknown> {
  const res = await fetch(`${SERVER_URL}/internal/agent/${AGENT_ID}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireToken()}` }, // 不要手动设 content-type，fetch 会自动带 boundary
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) detail = parsed.error;
    } catch {
      /* ignore */
    }
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
    // A7.1：告知上限与自动分段——此前描述不提上限，agent 撞 400 后只会删内容重试
    //（报告 §8.13 #2）。拆条按段落/代码块边界，attachmentIds 只挂最后一条。
    description:
      "在指定频道/线程/私信里发一条消息。单条上限约 9000 字符，超出会自动按段落/代码块边界拆成多条顺序发送（attachmentIds 只随最后一条）；代码/多文件/长报告优先走 upload_attachment 交付，不要把超长代码贴进消息。",
    inputSchema: {
      target: z
        .string()
        .describe('目标：频道（如 "#general"）、频道内线程（如 "#general:threadId"）、或私信（如 "dm:@handle"）'),
      content: z.string().describe("消息正文（超长自动分段）"),
      threadId: z.string().optional().describe("可选：显式指定线程 id"),
      attachmentIds: z
        .array(z.string())
        .optional()
        .describe("可选：随消息附带的附件 id 列表（先用 upload_attachment 上传获得；拆条时只挂最后一条）"),
      // Phase 5 §15.4：幂等键由 worker SDK 自动注入（<turnId>:<tool>:<seq>），
      // agent 无需也不应手写；拆条时各条派生 <key>#<i>，保证逐条去重。
      idempotencyKey: z.string().optional().describe("幂等去重键（由运行时注入，勿手写）"),
    },
  },
  async ({ target, content, threadId, attachmentIds, idempotencyKey }) => {
    try {
      const chunks = splitMessageContent(content);
      if (chunks.length === 1) {
        const result = await callSlock("/send", {
          method: "POST",
          body: JSON.stringify({ target, content, threadId, attachmentIds, idempotencyKey }),
        });
        return ok(result);
      }
      // 顺序发保证到达顺序；附件只挂末条。任一失败即抛——已发出的不撤回
      //（部分送达比静默失败好排查，agent 可据 messageIds 续发）。
      const messageIds: string[] = [];
      let lastResult: unknown = {};
      for (let i = 0; i < chunks.length; i++) {
        lastResult = await callSlock("/send", {
          method: "POST",
          body: JSON.stringify({
            target,
            content: chunks[i],
            threadId,
            attachmentIds: i === chunks.length - 1 ? attachmentIds : undefined,
            idempotencyKey: idempotencyKey ? `${idempotencyKey}#${i}` : undefined,
          }),
        });
        const id =
          (lastResult as { messageId?: unknown; id?: unknown })?.messageId ?? (lastResult as { id?: unknown })?.id;
        if (typeof id === "string") messageIds.push(id);
      }
      return ok({ ...(lastResult as Record<string, unknown>), autoSplit: chunks.length, messageIds });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "upload_attachment",
  {
    title: "上传附件",
    // A7.3：path 可传目录——内存里打成 zip 上传；源码类扩展名按 text/plain 上报 MIME
    description:
      "上传一个本地文件或目录，返回 attachmentId（之后用 send_message 的 attachmentIds 随消息发出）。传目录时自动打成 zip（隐藏文件/目录、node_modules、符号链接会被排除）；代码/多文件工程/长报告优先进 deliverables/ 目录后整体上传。",
    inputSchema: {
      path: z.string().describe("本地文件或目录的绝对路径，如 D:\\docs\\report.pdf 或 D:\\work\\deliverables\\x"),
    },
  },
  async ({ path }) => {
    try {
      const payload = await prepareUpload(path);
      const form = new FormData();
      // Buffer<ArrayBufferLike> 不满足 BlobPart（可能背 SharedArrayBuffer）——
      // 拷一份纯 ArrayBuffer 背的 Uint8Array；payload 公开 API 不变。
      const bytes = new Uint8Array(payload.bytes);
      form.append("file", new Blob([bytes], { type: payload.mimeType }), payload.filename);
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
      idempotencyKey: z.string().optional().describe("幂等去重键（由运行时注入，勿手写）"),
    },
  },
  async ({ channel, toAgent, text, idempotencyKey }) => {
    try {
      const result = await callSlock("/dispatch", {
        method: "POST",
        body: JSON.stringify({ channel, toAgent, text, idempotencyKey }),
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
      threadId: z.string().optional().describe("可选：线程 id（父帖 UUID 或短前缀）；缺省只返回顶层消息"),
    },
  },
  async ({ channel, limit, threadId }) => {
    try {
      const qs = new URLSearchParams({ channel, limit: String(limit || 30) });
      if (threadId) qs.set("threadId", threadId);
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
      const qs = new URLSearchParams({
        q: query,
        ...(channel ? { channel } : {}),
        ...(limit ? { limit: String(limit) } : {}),
      });
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
      // P1.23：daily@HH:MM 类规则按此 IANA 时区计算（缺省随附 daemon 本机时区，
      // 提醒按「用户的钟」触发，不受 server 部署时区摆布）
      timezone: z.string().optional().describe("IANA 时区（如 Asia/Shanghai；缺省用本机时区）"),
    },
  },
  async ({ title, delaySeconds, fireAt, channel, timezone }) => {
    try {
      const machineTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const result = await callSlock("/reminders", {
        method: "POST",
        body: JSON.stringify({ title, delaySeconds, fireAt, channel, timezone: timezone || machineTz }),
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
