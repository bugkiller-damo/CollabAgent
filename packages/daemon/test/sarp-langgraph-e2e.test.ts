import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, AgentRuntimeTurnResult } from "../src/agent-runtime-driver.js";
import {
  type JsonlWorkerSessionOptions,
  PersistentJsonlWorkerSession,
} from "../src/drivers/persistent-jsonl-worker.js";

/**
 * Phase 3 验收测试：真实 LangGraph worker ↔ daemon session。
 *
 * 与 sarp-python-worker（裸 serve()）不同——这里 spawn 的是
 * serve_langgraph() + 真 CompiledStateGraph + 真 SqliteSaver：
 * thread_id 记忆、worker 重启后 checkpoint 恢复、interrupt()/
 * Command(resume=) 都由框架真实语义承担（设计文档 §20.4 矩阵的
 * daemon 侧端到端部分；SDK 内部矩阵在 bridges/python/tests）。
 *
 * 需要能 import LangGraph 框架的 Python 解释器（fixture 的 slock_runtime
 * 经 spawn 期 PYTHONPATH 注入，故选择探针只验证框架依赖）。候选顺序与
 * sarp-python-worker 相同：SLOCK_TEST_PYTHON → 仓库本地 venv（win32
 * `.venv/Scripts/python.exe`，其他平台 `.venv/bin/python`）→ `python3`
 * → `python`；存在但缺框架依赖的候选被跳过，全部不可用才 skip 整个文件。
 */

const SDK_DIR = join(__dirname, "../../../bridges/python");
const VENV_PY = join(
  SDK_DIR,
  ".venv",
  ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]),
);
const FIXTURE = join(__dirname, "fixtures", "sarp_langgraph_worker.py");

const FRAMEWORK_PROBE = ["-c", "import langchain_core, langgraph; from langgraph.checkpoint.sqlite import SqliteSaver"];

const findPython = (): string | null => {
  const candidates = [process.env.SLOCK_TEST_PYTHON, VENV_PY, "python3", "python"].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, FRAMEWORK_PROBE, { stdio: "pipe" });
    if (r.status === 0) return c;
  }
  return null;
};

const PYTHON = findPython();
const maybe = PYTHON ? describe : describe.skip;

const openWorker = (
  workspace: string,
  fxEnv: Record<string, string> = {},
  over: Partial<JsonlWorkerSessionOptions> = {},
): { session: PersistentJsonlWorkerSession; events: AgentRuntimeEvent[] } => {
  const events: AgentRuntimeEvent[] = [];
  const session = new PersistentJsonlWorkerSession({
    agentName: "lg-agent",
    runtime: "langgraph",
    entrypoint: "lg-e2e",
    workspace,
    spawnSpec: {
      command: PYTHON!,
      args: [FIXTURE],
      cwd: workspace,
      env: { PYTHONPATH: SDK_DIR, PYTHONUNBUFFERED: "1", ...fxEnv },
    },
    timeouts: { startupMs: 15000, silenceMs: 15000, shutdownMs: 3000 },
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { session, events };
};

const req = (
  turnId: string,
  prompt: string,
  conversationId = "slock:v1:a1:thread:t1",
  resume?: { interruptId: string; resumeToken: string; value: string },
) => ({
  turnId,
  conversationId,
  attempt: 1,
  prompt,
  source: { kind: "thread" as const, channel: "research", threadId: "t1" },
  ...(resume ? { resume } : {}),
});

maybe("真实 LangGraph worker ↔ daemon session", () => {
  it("同一会话两回合：SqliteSaver checkpoint 记忆生效", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-lg-"));
    const { session } = openWorker(ws);
    const r1 = (await session.send(req("t-1", "first"))) as AgentRuntimeTurnResult;
    expect(r1.status).toBe("success");
    expect(r1.finalText).toBe("echo[1]:first");
    const r2 = (await session.send(req("t-2", "second"))) as AgentRuntimeTurnResult;
    // 第二回合看到 [Human, AI, Human] = 3 条——上一回合状态在 checkpoint 里
    expect(r2.finalText).toBe("echo[3]:second");
    session.stop();
  });

  it("worker 进程重启后同 conversationId 状态仍在（durable checkpoint）", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-lg-"));
    const s1 = openWorker(ws);
    const r1 = (await s1.session.send(req("t-1", "first"))) as AgentRuntimeTurnResult;
    expect(r1.finalText).toBe("echo[1]:first");
    s1.session.stop();
    expect(s1.session.alive).toBe(false);

    // 全新进程、同一 workspace + conversationId → checkpoint 恢复
    const s2 = openWorker(ws);
    const r2 = (await s2.session.send(req("t-2", "after-restart"))) as AgentRuntimeTurnResult;
    expect(r2.finalText).toBe("echo[3]:after-restart");
    s2.session.stop();
  });

  it("不同 conversationId 互不共享状态", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-lg-"));
    const { session } = openWorker(ws);
    await session.send(req("t-1", "first", "slock:v1:a1:thread:t1"));
    const other = (await session.send(req("t-2", "fresh", "slock:v1:a1:thread:OTHER"))) as AgentRuntimeTurnResult;
    expect(other.finalText).toBe("echo[1]:fresh");
    session.stop();
  });

  it("interrupt() → 审批提示回传 → resume 走 Command(resume) 原 checkpoint 续跑", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-lg-"));
    const { session, events } = openWorker(ws, { SLOCK_LG_INTERRUPT: "1" });
    const first = (await session.send(req("t-int", "exec"))) as AgentRuntimeTurnResult;
    expect(first.status).toBe("interrupted");
    expect(first.interrupt?.prompt).toBe("批准敏感操作？");
    expect(events.some((e) => e.type === "interrupt")).toBe(true);

    const second = (await session.send(
      req("t-res", "ignored", "slock:v1:a1:thread:t1", {
        interruptId: first.interrupt!.interruptId,
        resumeToken: first.interrupt!.resumeToken,
        value: "approved",
      }),
    )) as AgentRuntimeTurnResult;
    expect(second.status).toBe("success");
    // gate 的 verdict + reply 的 echo 都进了 state.messages——resume 后图续跑
    expect(second.finalText).toContain("echo[");
    expect(second.finalText).toContain("verdict:approved");
    session.stop();
  });

  it("非流式 invoke 路径也产出 finalText（streaming=False 由 SDK 侧测；此处补一条跨会话隔离 sanity）", async () => {
    const ws = mkdtempSync(join(tmpdir(), "slock-lg-"));
    const { session } = openWorker(ws);
    const r = (await session.send(req("t-9", "x", "slock:v1:a1:dm:bob"))) as AgentRuntimeTurnResult;
    expect(r.status).toBe("success");
    expect(r.finalText).toBe("echo[1]:x");
    session.stop();
  });
});
