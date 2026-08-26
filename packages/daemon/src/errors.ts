/** 从 unknown catch 取值，避免 `(err as any)?.message`。P1.13 引入；P1.14 统一错误模型见下方 DispatchError。 */
export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * P1.14 统一错误模型：派发链路的错误语义收口到 DispatchError。
 *
 * 此前错误语义散落在各处：doDispatch 抛魔法字符串 Error、队列对所有失败
 * 一律退避重试、死信上报只有裸 message。现在：
 * - 永久失败（agent stopped / 无 agentId / 会话被换）带 `retriable: false`，
 *   队列首次失败即死信，不再空转退避；
 * - 临时失败（in-flight 超时 / mint 失败 / 回合内错误）保持 retriable，
 *   语义与旧的「一律重试」等价；
 * - 未分类的普通 Error 由 isRetriableError 视为 retriable（保守默认，不改变
 *   冻结 PTY 路径等未迁移抛点的既有重试行为）。
 */
export type DispatchErrorCode =
  /** 无 agentId（agent 未注册/已删除）——重试无意义 */
  | "agent-unknown"
  /** stop/unregister 后投递，或投递中途被停——重试无意义 */
  | "agent-stopped"
  /** spawn 完成时发现常驻会话已被换掉——本回合放弃，下条消息重新 spawn */
  | "session-lost"
  /** 队列 in-flight 截止（deliver 挂住）——可重试 */
  | "inflight-timeout"
  /** scoped token mint 失败（网络/服务端 5xx）——可重试 */
  | "credential-mint-failed";

const NON_RETRIABLE: ReadonlySet<DispatchErrorCode> = new Set(["agent-unknown", "agent-stopped", "session-lost"]);

export class DispatchError extends Error {
  readonly code: DispatchErrorCode;
  /** 队列据此决定重试还是直接死信；由 code 推导，构造时不开放覆盖 */
  readonly retriable: boolean;

  constructor(code: DispatchErrorCode, message: string) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.retriable = !NON_RETRIABLE.has(code);
  }
}

export const isDispatchError = (err: unknown): err is DispatchError => err instanceof DispatchError;

/** 死信上报等出口取错误码；非 DispatchError 返回 undefined（调用方可选填） */
export const errCode = (err: unknown): DispatchErrorCode | undefined => (isDispatchError(err) ? err.code : undefined);

/**
 * 重试判定的唯一入口。未迁移的普通 Error / 冻结 PTY 路径抛点一律视为
 * retriable——保持 P1.14 之前「失败即退避重试」的既有行为，只有显式标注
 * retriable=false 的 DispatchError 才走首次失败即死信。
 */
export const isRetriableError = (err: unknown): boolean => (isDispatchError(err) ? err.retriable : true);
