/**
 * 批次 C（P1.5）：entrypoint 运行诊断快照。
 *
 * probe 快照（runtime-probe-last.json）回答「启动面是否健康」，本模块回答
 * 「运行面最近发生了什么」——dispatch 路径的 spawn/回合失败按 entrypoint
 * 记 lastError（DispatchError 消息已含脱敏 stderr 尾，见 persistent-jsonl-worker
 * 的 stderrTail()），恢复成功时记 lastOkAt 并清除 lastError。
 *
 * 纪律：
 * - 只在「状态迁移」时写盘：新错误 / 错误→成功恢复。recordOk 对无历史
 *   错误的条目是 no-op——不是每个回合都写文件、都推 refresh。
 * - message 进文件前再过一次 redactSecrets（上游已脱敏，纵深防御）+ 截断。
 * - 损坏/缺失的存储文件安全降级为空表。
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivateSync, slockDir } from "./private-dir.js";
import { redactSecrets } from "./redact.js";

export interface RuntimeDiagnosticRecord {
  lastError?: { code?: string; message: string; at: string };
  lastOkAt?: string;
}

export interface IRuntimeDiagnostics {
  /** 记录一次失败（始终落盘——排障面需要最新错误） */
  recordError(entrypoint: string, error: { code?: string; message: string }): void;
  /** 恢复信号：仅当该条目挂着 lastError 时才写（清除 + lastOkAt） */
  recordOk(entrypoint: string): void;
  get(entrypoint: string): RuntimeDiagnosticRecord | undefined;
  all(): Record<string, RuntimeDiagnosticRecord>;
  /** 内容变化通知（daemon-core 据此推 entrypoints:refresh）；返回退订函数 */
  subscribe(listener: () => void): () => void;
}

interface DiagnosticsFile {
  entries: Record<string, RuntimeDiagnosticRecord>;
}

export const defaultDiagnosticsPath = (): string => join(slockDir(), "runtime-diagnostics.json");

const MAX_MESSAGE_CHARS = 600;

/**
 * 把诊断摘要合并到 probe 条目上（ready 载荷与 entrypoints:refresh 共用）。
 * 无记录/无命中时返回原数组，不产生多余字段。
 */
export const attachDiagnostics = <T extends { id: string }>(
  probes: T[],
  diagnostics: IRuntimeDiagnostics | undefined,
): T[] => {
  const diag = diagnostics?.all();
  if (!diag || Object.keys(diag).length === 0) return probes;
  return probes.map((p) => {
    const d = diag[p.id];
    if (!d) return p;
    return {
      ...p,
      diagnostics: {
        ...(d.lastError ? { lastError: d.lastError } : {}),
        ...(d.lastOkAt ? { lastOkAt: d.lastOkAt } : {}),
      },
    };
  });
};

export const createRuntimeDiagnostics = (filePath: string, opts?: { now?: () => number }): IRuntimeDiagnostics => {
  const now = opts?.now ?? (() => Date.now());
  const listeners = new Set<() => void>();

  const readAll = (): DiagnosticsFile => {
    if (!existsSync(filePath)) return { entries: {} };
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      return {
        entries:
          typeof raw === "object" && raw !== null && typeof raw.entries === "object" && raw.entries !== null
            ? (raw.entries as Record<string, RuntimeDiagnosticRecord>)
            : {},
      };
    } catch {
      return { entries: {} };
    }
  };

  const writeAll = (data: DiagnosticsFile): void => {
    try {
      mkdirPrivateSync(dirname(filePath));
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      try {
        chmodSync(tmp, 0o600);
      } catch {
        /* best-effort：Windows 上 chmod 语义有限 */
      }
      renameSync(tmp, filePath);
    } catch (err) {
      console.warn(`[RuntimeDiagnostics] persist failed: ${(err as Error)?.message}`);
      return; // 落盘失败不推 refresh——推了也是旧数据
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* listener 是旁路 */
      }
    }
  };

  return {
    recordError(entrypoint, error) {
      if (!entrypoint) return;
      const data = readAll();
      const prev = data.entries[entrypoint] ?? {};
      data.entries[entrypoint] = {
        ...(prev.lastOkAt ? { lastOkAt: prev.lastOkAt } : {}),
        lastError: {
          ...(error.code ? { code: error.code } : {}),
          message: redactSecrets(error.message).slice(-MAX_MESSAGE_CHARS),
          at: new Date(now()).toISOString(),
        },
      };
      writeAll(data);
    },

    recordOk(entrypoint) {
      if (!entrypoint) return;
      const data = readAll();
      const prev = data.entries[entrypoint];
      // 无历史错误 = 常态成功回合，不落盘不通知（每回合写文件太吵）。
      if (!prev?.lastError) return;
      data.entries[entrypoint] = { lastOkAt: new Date(now()).toISOString() };
      writeAll(data);
    },

    get(entrypoint) {
      return readAll().entries[entrypoint];
    },

    all() {
      return { ...readAll().entries };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
