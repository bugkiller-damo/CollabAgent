import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, AgentRuntimeTurnResult } from "../src/agent-runtime-driver.js";
import { loadRuntimeManifest } from "../src/agent-runtime-manifest.js";
import { createJsonlBridgeRuntimeDriver } from "../src/drivers/jsonl-bridge-runtime.js";
import { probeRuntimeEntrypoints } from "../src/drivers/runtime-entrypoint-probe.js";

/**
 * 端到端闭环：runtimes.json manifest → loadRuntimeManifest 校验 →
 * probeRuntimeEntrypoints 真 probe → createJsonlBridgeRuntimeDriver →
 * PersistentJsonlWorkerSession → bridges/templates 里的真实模板 worker。
 * 这是「manifest 配置路径」的验收——前面每层各有单测，本文件证明串起来
 * 后模板 worker 真能跑通 initialize → turn → turn.end。
 *
 * 只在 SLOCK_TEST_PYTHON 指向装了 slock-runtime[langchain,langgraph] 的
 * 解释器时运行（模板 import 的是 site-packages 里的 SDK，不靠 PYTHONPATH）；
 * 未设置则整个文件 skip。不依赖 server/web/MCP/provider。
 */

const TEMPLATES_DIR = join(__dirname, "../../../bridges/templates");
const PYTHON = process.env.SLOCK_TEST_PYTHON?.trim();
const maybe = PYTHON ? describe : describe.skip;

const CASES = [
  { dir: "langchain-agent", runtime: "langchain" },
  { dir: "langgraph-agent", runtime: "langgraph" },
] as const;

maybe("manifest → probe → driver → 模板 worker 端到端", () => {
  for (const { dir, runtime } of CASES) {
    it(`${dir}：manifest 加载 + installed_unsupported probe + 单回合 Echo`, async () => {
      const root = mkdtempSync(join(tmpdir(), "slock-manifest-template-"));
      try {
        const workspace = join(root, "workspace");
        mkdirSync(workspace);
        const templateDir = join(TEMPLATES_DIR, dir);
        const manifestPath = join(root, "runtimes.json");
        writeFileSync(
          manifestPath,
          JSON.stringify({
            version: 1,
            entries: [
              {
                id: `${runtime}-template`,
                runtime,
                label: `${runtime} template`,
                command: PYTHON,
                args: [join(templateDir, "agent.py")],
                cwd: templateDir,
                env: { PYTHONUNBUFFERED: "1" },
                secretEnv: [],
                model: { mode: "fixed", default: "local:echo", allowed: [] },
                requireDurableThreads: false,
                startupTimeoutMs: 15_000,
                silenceTimeoutMs: 300_000,
                shutdownTimeoutMs: 10_000,
              },
            ],
          }),
          "utf-8",
        );

        const snapshot = loadRuntimeManifest(manifestPath);
        expect(snapshot.fatalError).toBeUndefined();
        expect(snapshot.invalidEntries.size).toBe(0);
        expect(snapshot.entries.size).toBe(1);
        const entry = snapshot.entries.get(`${runtime}-template`);
        expect(entry?.runtime).toBe(runtime);

        // 真 probe：spawn `${PYTHON} <template>/agent.py --slock-probe`
        const probes = probeRuntimeEntrypoints(snapshot, { env: process.env });
        expect(probes.length).toBe(1);
        const probe = probes[0]!;
        expect(probe.id).toBe(`${runtime}-template`);
        expect(probe.runtime).toBe(runtime);
        expect(probe.status).toBe("installed_unsupported");
        expect(probe.capabilities?.maxConcurrency).toBe(1);
        expect(probe.errorCode).toBeUndefined();

        // 真 driver → PersistentJsonlWorkerSession → 模板 worker 单回合
        const driver = createJsonlBridgeRuntimeDriver({
          manifestLoader: () => snapshot,
          env: process.env,
        });
        const events: AgentRuntimeEvent[] = [];
        const session = driver.openSession({
          agentName: `${runtime}-tpl-agent`,
          mode: "persistent",
          cwd: workspace,
          env: {},
          entrypoint: `${runtime}-template`,
          model: "local:echo",
          agent: { id: "a1", name: `${runtime}-tpl-agent` },
          onEvent: (e) => events.push(e),
        });
        try {
          const result = (await session.send({
            turnId: "t-1",
            conversationId: "slock:v1:a1:thread:t1",
            attempt: 1,
            prompt: "hi",
            source: { kind: "message" as const, channel: "research", sender: "alice" },
          })) as AgentRuntimeTurnResult;
          expect(result.status).toBe("success");
          expect(result.finalText).toBe("Echo: hi");
          expect(events.some((e) => e.type === "turn.end")).toBe(true);
        } finally {
          if (session.alive) session.stop();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
