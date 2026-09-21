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
  | "credential-mint-failed"
  /** runtime 未在 driver registry 注册 / 无 preset——重试无意义 */
  | "runtime-unsupported"
  | "runtime-profile-conflict"
  | "entrypoint-required"
  | "entrypoint-not-found"
  | "entrypoint-runtime-mismatch"
  | "entrypoint-not-allowed"
  | "model-not-allowed"
  | "manifest-invalid"
  | "pty-runtime-unsupported"
  // Phase 2：SARP/1 bridge worker 生命周期与协议错误（02-daemon-langchain-langgraph-runtime-design.md §15）
  /** worker 进程在 handshake / 回合中退出——可重试（spawn 崩溃、OOM、依赖缺失） */
  | "worker-exited"
  /** runtime.ready 未在 startupTimeoutMs 内到达——可重试 */
  | "runtime-start-timeout"
  /** 回合中 silenceTimeoutMs 无任何 stdout 帧——可重试（进程被判卡死并回收） */
  | "runtime-silence-timeout"
  /** 握手校验失败：worker 报出的 runtime id 与 profile 不符——重试无意义 */
  | "runtime-id-mismatch"
  /** worker 声明不支持本协议版本——重试无意义（需升级 worker） */
  | "protocol-version-unsupported"
  /** profile requireDurableThreads 但 worker capabilities.durableThreads=false——重试无意义 */
  | "durable-threads-required"
  /** 协议违规（坏帧/越序/重复终态/未知非 optional 消息）——当前 worker 必须终止 */
  | "protocol-violation"
  /** wire MODEL_RATE_LIMITED——可重试；retryAfterMs 取 worker 声明值与退避较大者 */
  | "provider-rate-limited"
  /** wire *_AUTH_FAILED / 凭证类错误——重试无意义 */
  | "provider-auth-failed"
  /** wire *_NETWORK_FAILED / 供应商不可达——可重试 */
  | "provider-network-failed"
  /** wire GRAPH_INPUT_INVALID 等输入校验失败——重试无意义 */
  | "graph-input-invalid"
  /** wire MCP_START_FAILED——可重试（MCP server 拉起失败） */
  | "mcp-start-failed"
  /** success 但 finalText 为空且本回合无 slock send 成功——重试无意义（§8.7.8） */
  | "empty-success"
  /** manifest command 解析不到可执行文件——重试无意义 */
  | "command-not-found"
  /** manifest cwd 不是存在的绝对目录——重试无意义 */
  | "cwd-not-found"
  /** secretEnv 引用的环境变量在 daemon env 中缺失——重试无意义 */
  | "secret-env-missing"
  /** Phase 5：crash-loop 熔断期内的快速失败——熔断期重试只是空转 */
  | "worker-crash-loop"
  /** 未映射的 worker 错误码兜底——永久（worker 想要可重试必须报已知码） */
  | "worker-error";

const NON_RETRIABLE: ReadonlySet<DispatchErrorCode> = new Set([
  "agent-unknown",
  "agent-stopped",
  "session-lost",
  "runtime-unsupported",
  "runtime-profile-conflict",
  "entrypoint-required",
  "entrypoint-not-found",
  "entrypoint-runtime-mismatch",
  "entrypoint-not-allowed",
  "model-not-allowed",
  "manifest-invalid",
  "pty-runtime-unsupported",
  "runtime-id-mismatch",
  "protocol-version-unsupported",
  "durable-threads-required",
  "protocol-violation",
  "provider-auth-failed",
  "graph-input-invalid",
  "empty-success",
  "command-not-found",
  "cwd-not-found",
  "secret-env-missing",
  // worker-crash-loop：熔断期内的快速失败必须立即死信而非重试——
  // 重试等于在冷却期内继续烧 spawn 探测，违背熔断本意。冷却结束后
  // 由「新消息到达」自然触发一次探测派发。
  "worker-crash-loop",
  "worker-error",
]);

/** retryAfterMs 上限——worker 声明的退避值不许无限放大（§15.2 钳制到全局最大退避） */
export const DISPATCH_MAX_RETRY_AFTER_MS = 120_000;

export class DispatchError extends Error {
  readonly code: DispatchErrorCode;
  /** 队列据此决定重试还是直接死信；由 code 推导，构造时不开放覆盖 */
  readonly retriable: boolean;
  /**
   * worker 声明的建议重试等待（wire error.retryAfterMs → 队列取其与指数退避
   * 的较大值，再钳制到 maxDelayMs / DISPATCH_MAX_RETRY_AFTER_MS）。
   */
  readonly retryAfterMs?: number;

  constructor(code: DispatchErrorCode, message: string, opts?: { retryAfterMs?: number }) {
    super(message);
    this.name = "DispatchError";
    this.code = code;
    this.retriable = !NON_RETRIABLE.has(code);
    const ra = opts?.retryAfterMs;
    if (typeof ra === "number" && Number.isFinite(ra) && ra > 0) {
      this.retryAfterMs = Math.min(Math.round(ra), DISPATCH_MAX_RETRY_AFTER_MS);
    }
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
