import { beforeEach, describe, expect, it } from "vitest";
import { createLiveRunRegistry } from "../src/live-run-registry.js";
import type { LiveAgentRun } from "../src/types/index.js";

const sampleRun = (overrides: Partial<LiveAgentRun> = {}): LiveAgentRun => ({
  runId: "run-1",
  agentId: "agent-1",
  pid: 12345,
  status: "running",
  output: "",
  exitCode: null,
  startedAt: Date.now(),
  ...overrides,
});

describe("live-run-registry", () => {
  let reg: ReturnType<typeof createLiveRunRegistry>;

  beforeEach(() => {
    reg = createLiveRunRegistry();
  });

  describe("基础 CRUD", () => {
    it("add + get", () => {
      const run = sampleRun();
      reg.add(run);
      expect(reg.get("run-1")).toEqual(run);
    });

    it("get 返回 undefined 当 runId 不存在", () => {
      expect(reg.get("nonexistent")).toBeUndefined();
    });

    it("list 返回所有运行", () => {
      reg.add(sampleRun({ runId: "r1" }));
      reg.add(sampleRun({ runId: "r2" }));
      reg.add(sampleRun({ runId: "r3" }));
      expect(reg.list()).toHaveLength(3);
    });

    it("remove 清理 run + pending", () => {
      reg.add(sampleRun());
      reg.createExitEntry("run-1");
      reg.remove("run-1");
      expect(reg.get("run-1")).toBeUndefined();
    });
  });

  describe("退出通道", () => {
    it("createExitEntry + resolveExit 流程", () => {
      reg.createExitEntry("run-1");
      reg.add(sampleRun());
      reg.resolveExit("run-1");
      expect(reg.get("run-1")?.status).toBe("exited");
    });
  });

  describe("Pending exit code (启动中退出保护)", () => {
    it("setPendingExitCode 在 run 未注册时暂存", () => {
      reg.setPendingExitCode("run-future", 137);
      expect(reg.hasPendingExitCode("run-future")).toBe(true);
    });

    it("add() 时自动应用 pending exit code", () => {
      reg.setPendingExitCode("run-1", 137);
      const run = sampleRun();
      reg.add(run);
      expect(run.status).toBe("exited");
      expect(run.exitCode).toBe(137);
      expect(reg.hasPendingExitCode("run-1")).toBe(false);
    });

    it("setPendingExitCode 在 run 已注册时直接更新", () => {
      const run = sampleRun();
      reg.add(run);
      reg.setPendingExitCode("run-1", 1);
      expect(run.exitCode).toBe(1);
      expect(run.status).toBe("exited");
    });

    it("clearPendingExitCode 删除暂存", () => {
      reg.setPendingExitCode("run-1", 137);
      reg.clearPendingExitCode("run-1");
      expect(reg.hasPendingExitCode("run-1")).toBe(false);
    });
  });

  describe("竞态场景", () => {
    it("进程在 add() 前退出 -> setPending -> add() 自动处理", () => {
      const runId = "fast-fail";
      reg.createExitEntry(runId);
      reg.setPendingExitCode(runId, 139);
      const run = sampleRun({ runId });
      reg.add(run);
      expect(run.status).toBe("exited");
      expect(run.exitCode).toBe(139);
    });
  });
});
