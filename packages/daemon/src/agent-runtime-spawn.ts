/**
 * ⚠️ 混合文件（2026-08-20，演进 Step 3 标注）
 * - `writeMcpConfig`：headless 路径也在用（agent-runtime-dispatch.ts MCP 配置注入），
 *   **不在冻结范围**，正常维护；
 * - 其余（`buildPtyEnv` / `SpawnPtyForAgentDeps` / `SpawnPtyForAgent` /
 *   `createSpawnPtyForAgent`）仅服务 PTY fallback（SLOCK_USE_PTY=1），
 *   为 ❄️ LEGACY / FROZEN：不接受新功能与非缺陷改动，删除评估见
 *   docs/2026-08-20/02-daemon-evolution-tracker.md Step 3（2026-09 底）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IExitChain } from "./agent-runtime-exit.js";
import type { IAgentStateMachine } from "./agent-runtime-state.js";
import { installTermsAcceptHandler } from "./agent-runtime-terms-dialog.js";
import type { ITurnTracker } from "./agent-runtime-turn-tracker.js";
import { BUSY_MARKER_RE, PROMPT_RE } from "./agent-runtime-turn-tracker.js";
import { captureSessionId } from "./agent-sessions.js";
import { getClaudePermissionArgs, getCommandPreset, renderResumeArgs } from "./command-presets.js";
import type { IIdleReclaimer } from "./idle-reclaimer.js";
import { bundleSlockMcpServer } from "./mcp-bundle.js";
import type { PostStartInputWriter } from "./post-start-input-writer.js";
import { formatRestartSummary } from "./restart-summary.js";
import type { IAgentManager, IAgentRunStore, LiveAgentRun, PtyOutputEvent } from "./types/index.js";

/**
 * PTY 启动 Claude 时的参数（仿照 Hive `claude-command-defaults.ts`）。
 *
 * **关键差异**：不传 `--append-system-prompt-file`。
 * Claude Code 交互模式下系统提示作为第一条 user message 发送（见下方
 * bootstrap 注入块）。YOLO args 三件套：
 * - `--dangerously-skip-permissions`：跳过工具权限询问
 * - `--permission-mode=bypassPermissions`：bypass 模式
 * - `--disallowedTools=Task`：禁用 Task 子代理
 */
// O12：主路径不再带 --dangerously-skip-permissions / bypassPermissions，
// 改显式工具白名单（见 command-presets.ts getClaudePermissionArgs 注释）。
// 每次 spawn 动态求值（SLOCK_AGENT_ALLOWED_TOOLS 可覆盖），不用模块级冻结常量。
const getSpawnPermissionArgs = (): string[] => getClaudePermissionArgs();

/**
 * Session resume（见 docs/2026-07-16/13-autostart-session-resume-plan.md §3.1）。
 *
 * 捕获（把 sessionId 存进 runStore）始终开启——风险很低，纯粹是往状态文件
 * 多写一个字段，不影响任何现有行为，即使从没被消费也无害。
 *
 * 但"把捕获到的 sessionId 喂回 `--resume` 参数"此前默认关闭（设计文档把这条
 * 标成"风险最高、需要小范围实测验证的一环"）。2026-07-29 起**默认开启**：
 * token 实测显示每次冷启动都要全量 bootstrap + agent 用工具调用重建上下文
 * （读 MEMORY/查历史/查派发），是消耗大头；而 resume 的失败兜底链已经完备——
 * 如果开了 resume 之后 PTY 在很短时间内就退出（见
 * `RESUME_QUICK_FAIL_WINDOW_MS`），视为 resume 失败，清空存的 sessionId 并
 * 立即无 `--resume` 重新尝试一次，不会"agent 从此再也起不来"。
 * 显式 `SLOCK_SESSION_RESUME=0` 可关回旧行为。
 */
// 每次调用时读一次（不在模块顶层冻成常量），这样测试可以在 beforeEach 里
// 直接改 process.env 生效，不需要靠 vi.resetModules() 重新加载整个模块图。
const isSessionResumeEnabled = (): boolean => process.env.SLOCK_SESSION_RESUME !== "0";
/** 判定"resume 失败"的宽限期：PTY 在这么短时间内退出，大概率是 --resume 本身炸了，不是正常工作后退出。
 *  可用 `SLOCK_RESUME_GRACE_MS` 覆盖（主要是测试用——真实环境不需要调）。 */
const getResumeGraceWindowMs = (): number => {
  const v = Number(process.env.SLOCK_RESUME_GRACE_MS);
  return Number.isFinite(v) && v > 0 ? v : 3000;
};
/** 捕获 sessionId 前的等待：给 Claude Code 时间在磁盘上把 session 文件落盘。
 *  可用 `SLOCK_SESSION_CAPTURE_DELAY_MS` 覆盖（主要是测试用）。 */
const getSessionCaptureDelayMs = (): number => {
  const v = Number(process.env.SLOCK_SESSION_CAPTURE_DELAY_MS);
  return Number.isFinite(v) && v > 0 ? v : 5000;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 清空持久化状态里的 lastSessionId（resume 失败兜底用），保留其余字段
 * （totalRuns 等）不变——不是简单删除整条记录，只是让"下一次不要再用这个
 * 坏掉的 sessionId"。
 */
const clearSavedSessionId = (runStore: IAgentRunStore | undefined, agentId: string, agentName: string): void => {
  if (!runStore) return;
  const prev = runStore.loadRuntimeState(agentId);
  runStore.saveRuntimeState({
    agentId,
    agentName,
    status: prev?.status ?? "idle",
    lastTransitionAt: Date.now(),
    totalRuns: prev?.totalRuns ?? 0,
    currentRunId: null,
    lastSessionId: null,
    lastSessionUpdatedAt: null,
  });
};

/**
 * PTY 关键环境变量（仿照 Hive `agent-run-starter.ts:77-86`）。
 * 没有这些，Claude Code 的 TUI 可能不渲染 ❯ 提示符，或走非交互分支。
 *
 * O11：显式剔除 SLOCK_AGENT_TOKEN——明文 token 不进子进程 env（同机跨进程可读、
 * 可能进 core dump）。token 经 workspace 里的 `.slock/agent-token` 文件传递
 * （SLOCK_AGENT_TOKEN_FILE 只含路径，非敏感）；daemon 侧退出清理仍需 token 值，
 * 由调用方在 env 对象上保留（daemon 内部），这里只剥离「给子进程的那份」。
 */
export const buildPtyEnv = (baseEnv: Record<string, string>): Record<string, string> => {
  const env = { ...baseEnv };
  delete env.SLOCK_AGENT_TOKEN;
  env.COLORTERM = "truecolor";
  env.FORCE_COLOR = "1";
  env.TERM = "xterm-256color";
  env.TERM_PROGRAM = "slock";
  // 显式删除 NO_COLOR（优先级高于 FORCE_COLOR）
  delete env.NO_COLOR;
  return env;
};

/**
 * 写入项目级 `.mcp.json`（Claude Code 在 cwd 里自动发现的 MCP server 配置，
 * 见 docs/2026-07-16/12-mcp-server-plan.md）+ `.claude/settings.local.json`
 * 里的 `enableAllProjectMcpServers: true`。
 *
 * 后者是为了跳过 Claude Code 首次遇到新 `.mcp.json` 时弹出的"是否信任这个
 * 项目的 MCP server"确认对话框——这类一次性信任对话框和 bug 1 的
 * Accept-Permissions 对话框是同一类风险：如果 bootstrap 消息在对话框还开着
 * 的时候被写入，会被对话框当输入吃掉，永久丢失。**这条路径还没做过真机
 * 验证**：如果之后实测发现仍然弹出信任对话框，需要在
 * agent-runtime-terms-dialog.ts 里加一个同类的检测 + 自动确认分支，而不是
 * 继续猜测配置项名称。
 */
export const writeMcpConfig = (
  workspace: string,
  agentId: string,
  agentTokenFile: string,
  serverUrl: string,
  mcpBundlePath: string,
): void => {
  // O11：.mcp.json 只放 token 文件路径（非敏感），不再内嵌明文 token；
  // MCP server 启动时按 SLOCK_AGENT_TOKEN_FILE 读文件取 token（见 mcp/slock-mcp-server.ts）
  const mcpConfig = {
    mcpServers: {
      slock: {
        command: "node",
        args: [mcpBundlePath],
        env: {
          SLOCK_AGENT_ID: agentId,
          SLOCK_AGENT_TOKEN_FILE: agentTokenFile,
          SLOCK_SERVER_URL: serverUrl,
        },
      },
    },
  };
  writeFileSync(join(workspace, ".mcp.json"), JSON.stringify(mcpConfig, null, 2));

  const claudeDir = join(workspace, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // 坏 JSON（比如手工改坏了）——直接覆盖，不阻塞 MCP 信任配置生效
    }
  }
  settings.enableAllProjectMcpServers = true;
  // effort 降档：Claude Code 2.1.x 会话默认 high effort，thinking token 照付
  // （2026-07-29 实测：haiku agent 屏幕显示 "● high · /effort"，Thought for 22s）。
  // 协作平台的 agent 以执行类任务为主，medium 足够；SLOCK_AGENT_EFFORT 可覆盖。
  // 注意：settings.json 的 effort 键名未查到官方文档确认（2026-07-29 web 检索
  // 未证实）——Claude Code 对未知键静默忽略，写错无害；真机验证 /effort 指示
  // 没变的话说明键名不对，需要换控制通道（如 MAX_THINKING_TOKENS env）。
  const effort = (process.env.SLOCK_AGENT_EFFORT || "medium").toLowerCase();
  if (["low", "medium", "high"].includes(effort) && settings.effort === undefined) {
    settings.effort = effort;
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
};

export interface SpawnPtyForAgentDeps {
  agentManager: IAgentManager;
  resolvedClaudePath: string;
  runStore?: IAgentRunStore;
  exitChain: IExitChain;
  stateMachine: IAgentStateMachine;
  turnTracker: ITurnTracker;
  idleReclaimer: IIdleReclaimer;
  postStartWriter: PostStartInputWriter;
  /** agentName -> runId 缓存（常驻 PTY），spawn 成功后写入 */
  runIdByAgent: Map<string, string>;
  /** runId -> unsubscribe 函数（回合结束订阅） */
  unsubByRunId: Map<string, () => void>;
  /** 查 agent 配置的模型（runtime_profile.model）——spawn 时拼 --model；未配置返回 undefined */
  getAgentModel: (agentName: string) => string | undefined;
  /** agentName -> 最近一次 PTY 输出时间（静默兜底回合结束用，agent-runtime.ts 的扫描器读） */
  lastOutputAtByAgent: Map<string, number>;
  /** 查该 agent 的首选终端尺寸（面板协商后记住的；未设置返回 undefined 用默认 80x24） */
  getPreferredTermSize: (agentName: string) => { cols: number; rows: number } | undefined;
}

export type SpawnPtyForAgent = (
  agentName: string,
  agentId: string,
  workspace: string,
  promptFile: string,
  env: Record<string, string>,
  initialUserMsg: string,
) => Promise<string>;

/**
 * 启动一个新 PTY（agentName 无现有 runId 时调用）。
 *
 * `initialUserMsg` 是触发本次启动的那条用户消息——**必须**和 bootstrap 系统提示
 * 合并成一次 `postStartWriter` 写入，而不是分两次独立写。原因：如果 doDispatch
 * 在 spawn 返回后立刻单独写一次用户消息，它的就绪轮询和 bootstrap 自己的就绪轮询
 * 是两个互不相干的定时器，谁先探测到 `❯` 就绪就先写——大概率是用户消息先到（因为
 * bootstrap 还在等 `termsAcceptDone`），导致 Claude 在还不知道自己是谁、该怎么回复
 * 之前就收到了用户内容，顺序错乱。合并成一次写彻底消除这个竞态。
 */
export const createSpawnPtyForAgent = (deps: SpawnPtyForAgentDeps): SpawnPtyForAgent => {
  const {
    agentManager,
    resolvedClaudePath,
    runStore,
    exitChain,
    stateMachine,
    turnTracker,
    idleReclaimer,
    postStartWriter,
    runIdByAgent,
    unsubByRunId,
    getAgentModel,
    lastOutputAtByAgent,
    getPreferredTermSize,
  } = deps;

  // 预热打包：createSpawnPtyForAgent 在 daemon 启动时构造一次（早于任何用户
  // 消息到达），这里提前踢一下 bundleSlockMcpServer() 的 memoized promise，
  // 让 esbuild 编译发生在等待第一条消息的空闲时间，而不是拖慢第一次真实 spawn。
  void bundleSlockMcpServer();

  /**
   * 单次 spawn 尝试。`resumeSessionId` 非空时会带上 `--resume <id>`；
   * `isRetry` 为 true 表示这是"resume 疑似失败后的无 resume 重试"，不会再
   * 触发第二次宽限期检测（避免无限重试）。
   */
  const attemptSpawn = async (
    agentName: string,
    agentId: string,
    workspace: string,
    promptFile: string,
    env: Record<string, string>,
    initialUserMsg: string,
    resumeSessionId: string | null,
    isRetry: boolean,
  ): Promise<string> => {
    const ptyEnv = buildPtyEnv(env);

    // MCP 工具接入（见 docs/2026-07-16/12-mcp-server-plan.md）：spawn 前把
    // `.mcp.json` 写进这个 agent 的 workspace，让 Claude Code 启动时就能发现。
    // 打包失败/写文件失败都不应该让整次 spawn 失败——MCP 只是 CLI 之外一条
    // 更结构化的通道，不是硬依赖，agent 仍可以退回用 `slock` CLI。
    try {
      const mcpBundlePath = await bundleSlockMcpServer();
      if (mcpBundlePath) {
        writeMcpConfig(workspace, agentId, env.SLOCK_AGENT_TOKEN_FILE ?? "", env.SLOCK_SERVER_URL ?? "", mcpBundlePath);
      }
    } catch (err: any) {
      console.warn(`[Runtime] @${agentName} MCP config setup failed, falling back to CLI-only: ${err?.message ?? err}`);
    }

    const resumeArgs = resumeSessionId ? renderResumeArgs(getCommandPreset("claude"), resumeSessionId) : [];

    // 模型配置（runtime_profile.model，Web 端 sonnet/opus/haiku 可选）——此前从未
    // 接进启动参数，管理后台选的模型完全是摆设。做一次保守校验，防注入/坏值。
    const configuredModel = getAgentModel(agentName);
    const modelArgs = configuredModel && /^[a-z0-9._-]+$/i.test(configuredModel) ? ["--model", configuredModel] : [];
    if (modelArgs.length > 0) {
      console.log(`[Runtime] @${agentName} spawning with --model ${configuredModel}`);
    }

    // 用一个 Promise 让宽限期窗口能知道"这次 attempt 是否已经退出"，同时把
    // 真正的清理转给 exitChain——它的清理回调对"还没 registerRunContext 过的
    // runId"是安全的 no-op（见下方注释），所以宽限期还没过时提前触发也不会
    // 误清理别的 run。
    let notifyExit: (() => void) | null = null;
    const exitedSignal = new Promise<void>((resolve) => {
      notifyExit = resolve;
    });

    const snapshot = await agentManager.startAgent({
      agentId,
      agentName: resolvedClaudePath,
      workspaceDir: workspace,
      systemPromptFile: promptFile,
      env: ptyEnv,
      args: [...getSpawnPermissionArgs(), ...modelArgs, ...resumeArgs],
      // 面板协商过的首选尺寸（若有）：新 PTY 直接按用户面板比例启动，
      // 而不是先 80x24 启动再被动 resize
      ...(getPreferredTermSize(agentName) ?? {}),
      onExit: (runId, exitCode) => {
        notifyExit?.();
        // 此刻大概率还没调用 registerRunContext（宽限期检测还没过），
        // exitChain.onExit 内部 `runContext.get(runId)` 查不到会直接 no-op，
        // 不会误清理别的 run；宽限期过后为真正存活的 run 走到下面正常路径时，
        // 这个 onExit 闭包仍然是同一个，后续真正退出时会走满清理链。
        exitChain.onExit(runId, exitCode);
      },
    });

    if (resumeSessionId && !isRetry) {
      const graceWindowMs = getResumeGraceWindowMs();
      const exited = await Promise.race([exitedSignal.then(() => true), sleep(graceWindowMs).then(() => false)]);
      if (exited) {
        console.warn(
          `[Runtime] @${agentName} PTY exited within ${graceWindowMs}ms of spawning with ` +
            `--resume ${resumeSessionId.slice(0, 8)}...— treating as a failed resume, clearing saved ` +
            `session id and retrying once without --resume`,
        );
        clearSavedSessionId(runStore, agentId, agentName);
        return attemptSpawn(agentName, agentId, workspace, promptFile, env, initialUserMsg, null, true);
      }
    }

    runIdByAgent.set(agentName, snapshot.runId);
    exitChain.registerRunContext(snapshot.runId, {
      agentName,
      agentId,
      token: env.SLOCK_AGENT_TOKEN ?? "",
      workspace, // O11：退出清理时删除 workspace/.slock/agent-token
      startedAt: snapshot.startedAt,
    });
    runStore?.insertAgentRun({
      runId: snapshot.runId,
      agentId,
      agentName,
      status: "starting",
      exitCode: null,
      startedAt: snapshot.startedAt,
      endedAt: null,
      messagesProcessed: 0,
      lastTurnDuration: null,
    });

    // 安装首次启动的 terms-accept 处理器（一次性）。bootstrap 写入必须等它
    // resolve（对话框已处理完/确认不会出现）才能开始，见函数注释。
    const termsAcceptDone = installTermsAcceptHandler(agentManager, snapshot.runId, agentName);

    // 订阅输出：
    // 1) SLOCK_VERBOSE_PTY=1 时镜像到 stdout（调试用）
    // 2) 检测"当前屏幕"就绪且不忙碌 → 回合结束 → working → idle
    //
    // 直接看 screenText（终端模拟器渲染出来的当前帧），不用再对累计的原始字节
    // 做正则扫描——不需要偏移量记账，也不需要"最后一次出现的位置"这种历史比较，
    // 当前帧本身就是答案。
    const unsub = agentManager.getOutputBus().subscribe(snapshot.runId, (ev: PtyOutputEvent) => {
      if (process.env.SLOCK_VERBOSE_PTY === "1") {
        process.stdout.write(ev.data);
      }
      lastOutputAtByAgent.set(agentName, Date.now());

      // 回合结束检测：
      const run = agentManager.getRun(snapshot.runId);
      if (!run) return;
      if (run.status === "exited" || run.status === "error") return;

      if (stateMachine.getState(agentName) !== "working") return;

      // 只有写入过还没等到回合结束的消息，才触发回合结束检测
      if (!turnTracker.hasPending(agentName)) return;

      if (BUSY_MARKER_RE.test(run.screenText)) {
        // 真的在忙——记下来，且不可能是回合结束，直接返回
        turnTracker.markBusyObserved(agentName);
        return;
      }
      // 必须先观察到忙碌过，才能把"当前空闲"当成"回合结束"；否则可能只是
      // Claude 还没来得及接收/处理这次写入，看到的空闲欢迎屏跟真正说完话
      // 之后的空闲屏在当前这一帧里长得一模一样，区分不出来。
      if (!turnTracker.hasBeenBusy(agentName)) return;
      if (!PROMPT_RE.test(run.screenText)) return;

      turnTracker.decPending(agentName);
      turnTracker.clearBusyObserved(agentName);
      stateMachine.transitionState(agentName, "idle");
      idleReclaimer.touch(agentName);
      console.log(
        `[Runtime] @${agentName} round-end (outputLen=${run.output.length}) current screen: ` +
          `${run.screenText.replace(/\s+/g, " ").trim().slice(-500)}`,
      );
    });
    unsubByRunId.set(snapshot.runId, unsub);

    // 注册到 live-run-registry
    const live: LiveAgentRun = {
      runId: snapshot.runId,
      agentId,
      pid: snapshot.pid,
      status: "running",
      output: "",
      exitCode: null,
      startedAt: snapshot.startedAt,
    };
    exitChain.preSpawn(snapshot.runId);
    exitChain.register(live);

    // resumeSessionId 非空且走到这里（没有在宽限期内被判定为失败），说明这次
    // 是一次成功的 session resume——Claude Code 自己已经恢复了上次的对话
    // 上下文，不需要再靠 restart-summary 的文字摘要重复一遍（见方案文档
    // "跟 restart-summary 的关系"一节：两者互斥，resume 成功就不注入摘要）。
    const didResume = resumeSessionId !== null;

    // 仿照 Hive `agent-run-starter.ts:144-164`：claude 启动后立即把系统提示
    // 和触发本次启动的用户消息合并成一条注入。postStartWriter 会等 ❯ 提示符就绪
    // 后再写。必须先等 termsAcceptDone，再开始为聊天输入框做就绪轮询——否则可能
    // 被误写进还开着的 Accept-Permissions 对话框，永久丢失。
    void (async () => {
      try {
        await termsAcceptDone;

        // resume 失败的真实耗时可能比宽限期检测更长（见上面 attemptSpawn
        // 里的宽限期注释——那个检测只覆盖 spawn 后的头几秒）。如果走到这里
        // 发现 run 已经死了，说明这次失败没被宽限期抓住，之前的代码会直接
        // 往一个空壳 PTY 里"写"bootstrap，消息静默丢失、没有任何重试或提示
        // （2026-07-16 真机验证时实测到：--resume 一个假 sessionId，PTY 在
        // "message dispatched" 日志之后才真正退出）。这里补一道检查：如果
        // 死于一次没重试过的 resume 尝试，清空坏掉的 sessionId 并整个重新
        // spawn 一次（不带 --resume），复用同一条触发消息，通过递归调用
        // attemptSpawn 完整地走一遍注册 + bootstrap 流程，而不是对着死掉的
        // runId 徒劳地写。
        const isDead = (): boolean => {
          const run = agentManager.getRun(snapshot.runId);
          return !run || run.status === "exited" || run.status === "error";
        };
        if (isDead()) {
          if (resumeSessionId && !isRetry) {
            console.warn(
              `[Runtime] @${agentName} run ${snapshot.runId.slice(0, 8)} was already dead by the time bootstrap ` +
                `was about to be written (--resume ${resumeSessionId.slice(0, 8)}... likely failed slower than the ` +
                `${getResumeGraceWindowMs()}ms grace window) — clearing saved session id and redelivering the ` +
                `message via a fresh spawn without --resume`,
            );
            clearSavedSessionId(runStore, agentId, agentName);
            await attemptSpawn(agentName, agentId, workspace, promptFile, env, initialUserMsg, null, true);
          } else {
            console.error(
              `[Runtime] @${agentName} run ${snapshot.runId.slice(0, 8)} died before bootstrap could be written; ` +
                `message was NOT delivered: "${initialUserMsg.slice(0, 100)}"`,
            );
          }
          return;
        }

        if (!existsSync(promptFile)) {
          console.warn(`[Runtime] @${agentName} system prompt file missing: ${promptFile}`);
          return;
        }
        const promptContent = readFileSync(promptFile, "utf-8");
        // 静态系统提示写入工作区 CLAUDE.md：Claude Code 每个会话（含 --resume）都会
        // 自动从 cwd 加载它，比 bootstrap 一次性 paste 更抗 /compact 压缩，也省掉
        // 每次 spawn 重复传输 ~3.5KB。bootstrap 只留身份 + 动态内容 + 一个
        // "去读 CLAUDE.md" 的指针——即使自动加载因故未生效，agent 也会被指引去读文件。
        writeFileSync(join(workspace, "CLAUDE.md"), promptContent, "utf-8");
        // 若之前有运行记录（daemon 重启或本次进程内曾崩溃重启）且这次不是靠
        // session resume 恢复的，注入恢复摘要，让 agent 知道自己不是"第一次"
        // 启动（仿照 Hive restart-policy.ts）。
        const priorRuns = runStore?.listAgentRuns(agentId) ?? [];
        const restartSummary = !didResume && priorRuns.length ? formatRestartSummary(agentName, priorRuns) : "";
        // 拼上身份标记 + 当前时间，让 agent 知道这是系统消息；末尾直接接上触发本次
        // 启动的用户消息，保证 Claude 先看到"我是谁/去哪读规则"，再看到"用户说了什么"
        const bootstrap = [
          `[Slock 系统消息：启动说明]`,
          ``,
          `你是 Slock 平台上的 @${agentName}（agentId: ${agentId}）。`,
          `当前工作区: ${workspace}`,
          ...(restartSummary ? ["", restartSummary] : []),
          ``,
          `你的完整系统提示已写入当前工作区的 CLAUDE.md（Claude Code 会自动加载；请先读一遍并严格遵守）。`,
          `[启动说明结束]`,
          ``,
          initialUserMsg,
        ].join("\n");
        turnTracker.clearBusyObserved(agentName);
        turnTracker.incPending(agentName);
        postStartWriter(snapshot.runId, bootstrap);
        console.log(`[Runtime] @${agentName} bootstrap+first message queued (${bootstrap.length} chars)`);
      } catch (err: any) {
        console.error(`[Runtime] @${agentName} bootstrap prompt failed:`, err?.message ?? err);
      }
    })();

    // Session 捕获（见 docs/2026-07-16/13-autostart-session-resume-plan.md
    // §3.1）：给 Claude Code 几秒时间在磁盘上把 session 文件落盘，再扫描一次
    // 拿最新的 sessionId 存进 runStore，供下次 spawn 时 `--resume`。跟上面的
    // "是否注入 --resume" 开关无关——捕获本身低风险，一直开着，即使从没被
    // 消费也无害；这样即使这次会话没打开 SLOCK_SESSION_RESUME，也能积累真实
    // 数据验证"捕获路径本身工作正常"，为将来打开消费端做铺垫。
    if (runStore) {
      setTimeout(() => {
        const prev = runStore.loadRuntimeState(agentId);
        const sessionId = captureSessionId("claude", workspace);
        runStore.saveRuntimeState({
          agentId,
          agentName,
          status: stateMachine.getState(agentName) ?? "working",
          lastTransitionAt: Date.now(),
          totalRuns: (prev?.totalRuns ?? 0) + 1,
          currentRunId: snapshot.runId,
          lastSessionId: sessionId ?? prev?.lastSessionId ?? null,
          lastSessionUpdatedAt: sessionId ? Date.now() : (prev?.lastSessionUpdatedAt ?? null),
        });
        if (sessionId) {
          console.log(`[Runtime] @${agentName} captured session id ${sessionId.slice(0, 8)}... for future --resume`);
        }
      }, getSessionCaptureDelayMs()).unref?.();
    }

    return snapshot.runId;
  };

  return async (
    agentName: string,
    agentId: string,
    workspace: string,
    promptFile: string,
    env: Record<string, string>,
    initialUserMsg: string,
  ): Promise<string> => {
    const lastSessionId = isSessionResumeEnabled()
      ? (runStore?.loadRuntimeState(agentId)?.lastSessionId ?? null)
      : null;
    return attemptSpawn(agentName, agentId, workspace, promptFile, env, initialUserMsg, lastSessionId, false);
  };
};
