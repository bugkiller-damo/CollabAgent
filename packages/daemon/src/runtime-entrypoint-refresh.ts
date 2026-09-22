/**
 * 批次 B / P1.2：manifest 变更 → 重跑 probe → `entrypoints:refresh` 上报。
 *
 * 现状缺口：entrypoints 摘要只在 daemon WS `ready` 时上报一次；manifest
 * mtime loader 只刷新本地 dispatch 视图——`slock runtime add|edit|remove`
 * （或手写改文件）后 server 侧 meta 陈旧到下次 daemon 重连/重启。
 *
 * 本模块：轮询共享的 manifestLoader（mtime 缓存，revision 迁移自动审计），
 * revision 变化即重跑 `probeRuntimeEntrypoints` 并把安全摘要经 send() 推给
 * server（daemon-core 包成 `entrypoints:refresh` 帧）。手写编辑与 CLI CRUD
 * 走同一条路径，无需 daemon 与 CLI 之间的 IPC。
 *
 * 附带：probe 结果落 `runtime-probe-last.json`（manifest 同目录）——
 * `slock runtime list` 读取的「最近一次 probe 状态」数据源。
 */

import type { RuntimeEntrypointProbe } from "@collabagent/shared";
import type { RuntimeManifestSnapshot } from "./agent-runtime-manifest.js";
import { probeRuntimeEntrypoints, type RuntimeEntrypointProbeDeps } from "./drivers/runtime-entrypoint-probe.js";
import { attachDiagnostics, type IRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { mergeRuntimeProbeSnapshot } from "./runtime-probe-snapshot.js";

export interface EntrypointRefreshDeps {
  /** 与 dispatch 路径共享的 mtime 缓存 loader（agent-runtime 注入同一实例，
   *  watcher 驱动的加载同时给 dispatch 暖缓存；revision 迁移审计只此一家写） */
  loader: () => RuntimeManifestSnapshot;
  /** probe 结果的出口（daemon-core 包成 WS 帧发送；ws 未 OPEN 时静默丢） */
  send: (probes: RuntimeEntrypointProbe[]) => void;
  /** 轮询间隔，默认 2000ms（测试可缩短） */
  intervalMs?: number;
  /** probe 依赖注入（测试可给假 execute/env/resolveSecretRef） */
  probeDeps?: RuntimeEntrypointProbeDeps;
  /** 最近一次 probe 快照是否落盘（默认 true；测试可关） */
  persistSnapshot?: boolean;
  /** 批次 C（P1.5）：运行诊断——probe 摘要附带 lastError/lastOkAt；
   *  subscribe 由 daemon-core 接 resend() */
  diagnostics?: IRuntimeDiagnostics;
}

export interface EntrypointRefresher {
  start(): void;
  stop(): void;
  /** 立即检查一次（rev 变化才上报）；供 start 与测试用 */
  tick(): void;
  /** 批次 C（P1.5）：诊断变化时把最近一份 probe（合并新诊断）重推一次，
   *  不重跑 probe（那是真 spawn）。无已发快照时静默。 */
  resend(): void;
}

export const createEntrypointRefresher = (deps: EntrypointRefreshDeps): EntrypointRefresher => {
  const intervalMs = deps.intervalMs ?? 2000;
  let lastRevision: string | undefined;
  let lastProbes: RuntimeEntrypointProbe[] | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;

  const emit = (probes: RuntimeEntrypointProbe[]): void => {
    lastProbes = probes;
    try {
      deps.send(attachDiagnostics(probes, deps.diagnostics));
    } catch {
      /* 发送失败不阻断轮询 */
    }
  };

  const tick = (): void => {
    let snapshot: RuntimeManifestSnapshot;
    try {
      snapshot = deps.loader();
    } catch {
      return; // loader 异常本周期跳过（下周期重试；mtime loader 实际不抛）
    }
    if (snapshot.revision === lastRevision) return;
    lastRevision = snapshot.revision;
    let probes: RuntimeEntrypointProbe[];
    try {
      probes = probeRuntimeEntrypoints(snapshot, deps.probeDeps);
    } catch (err) {
      console.warn(`[EntrypointRefresh] probe failed: ${(err as Error)?.message}`);
      return;
    }
    if (deps.persistSnapshot !== false) {
      try {
        mergeRuntimeProbeSnapshot(snapshot.path, snapshot.revision, probes);
      } catch {
        /* 快照落盘是旁路 */
      }
    }
    emit(probes);
  };

  return {
    start() {
      if (timer) return;
      lastRevision = deps.loader().revision; // 基线：ready 已报过当前状态，不重复推
      timer = setInterval(tick, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    resend() {
      if (!lastProbes) return;
      try {
        deps.send(attachDiagnostics(lastProbes, deps.diagnostics));
      } catch {
        /* 发送失败是旁路 */
      }
    },
  };
};
