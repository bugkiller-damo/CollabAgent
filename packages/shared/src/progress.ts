/**
 * T4/D4 进度呈现：工具名中文化 + 观察帧聚合 + 频道进度文案。
 * 不从 index 回引（避免循环）。ObservationFrame 形状与线协议一致。
 */

export interface ProgressFrame {
  kind: string;
  payload: {
    text?: string;
    toolName?: string;
    toolUseId?: string;
  };
}

/** 频道内进度消息前缀（D1 过滤 / web 样式 / 结束消与改写判定） */
export const PROGRESS_PREFIX = "⏳ ";

export const isProgressContent = (content: string | null | undefined): boolean =>
  String(content ?? "")
    .trimStart()
    .startsWith(PROGRESS_PREFIX.trimEnd());

const TOOL_LABELS: Record<string, string> = {
  Read: "读文件",
  Write: "写文件",
  Edit: "改文件",
  Bash: "运行命令",
  Glob: "搜文件名",
  Grep: "搜内容",
  WebFetch: "访问网页",
  WebSearch: "搜索网页",
  Task: "启动子任务",
  NotebookEdit: "编辑笔记本",
  TodoWrite: "更新待办",
  Skill: "调用技能",
  EnterPlanMode: "进入计划",
  ExitPlanMode: "结束计划",
};

/** MCP / CLI 工具名 → 非技术用户可读短标签 */
export const labelTool = (name: string | undefined | null): string => {
  if (!name) return "工具";
  if (name.includes("send_message") || name.includes("message send")) return "发消息";
  if (name.includes("dispatch")) return "派单";
  if (name.includes("read_history")) return "读历史";
  if (name.includes("create_task") || name.includes("list_task")) return "任务";
  const short = name.replace(/^mcp__[^_]+__/, "");
  return TOOL_LABELS[name] || TOOL_LABELS[short] || short || name;
};

export interface ProgressToolItem {
  name: string;
  label: string;
  done: boolean;
  /** 输入摘要（已截断） */
  detail?: string;
}

export interface ProgressSnapshot {
  headline: string;
  tools: ProgressToolItem[];
  thinking?: string;
}

const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + "…" : s);

const toolDetail = (inputText: string | undefined, name: string): string | undefined => {
  if (!inputText) return undefined;
  const raw = inputText.trim();
  if (!raw || raw === "{}") return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const pick = obj.file_path ?? obj.path ?? obj.command ?? obj.pattern ?? obj.query ?? obj.url ?? obj.target;
    if (typeof pick === "string" && pick.trim()) {
      const v = pick.trim();
      if (name === "Bash" || name.toLowerCase().includes("bash")) {
        return truncate(v.replace(/\s+/g, " "), 48);
      }
      const base = v.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? v;
      return truncate(base, 40);
    }
  } catch {
    /* 非 JSON，当纯文本 */
  }
  return truncate(raw.replace(/\s+/g, " "), 40);
};

/**
 * 把一回合（或 replay 窗口）的观察帧聚合成用户向快照。
 * tool_use / tool_result 按 toolUseId 配对；无 id 则按出现顺序。
 * 只看最近一次 turn_end 之后的帧，避免第二回合顶栏仍钉在上一轮最后的工具上。
 */
export const summarizeProgress = (frames: ProgressFrame[]): ProgressSnapshot => {
  let start = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].kind === "turn_end") start = i + 1;
  }
  const window = start > 0 ? frames.slice(start) : frames;
  if (window.length === 0) {
    return { headline: "", tools: [], thinking: undefined };
  }

  const tools: ProgressToolItem[] = [];
  const byId = new Map<string, ProgressToolItem>();
  let thinking: string | undefined;

  for (const f of window) {
    if (f.kind === "thinking" && f.payload.text?.trim()) {
      thinking = truncate(f.payload.text.replace(/\s+/g, " ").trim(), 80);
    }
    if (f.kind === "tool_use") {
      const name = f.payload.toolName ?? "?";
      const item: ProgressToolItem = {
        name,
        label: labelTool(name),
        done: false,
        detail: toolDetail(f.payload.text, name),
      };
      tools.push(item);
      if (f.payload.toolUseId) byId.set(f.payload.toolUseId, item);
    }
    if (f.kind === "tool_result") {
      const card = f.payload.toolUseId ? byId.get(f.payload.toolUseId) : undefined;
      if (card) card.done = true;
      else if (tools.length > 0 && !tools[tools.length - 1].done) {
        tools[tools.length - 1].done = true;
      }
    }
  }

  const running = [...tools].reverse().find((t) => !t.done);
  const last = tools.length > 0 ? tools[tools.length - 1] : undefined;
  let headline = "思考";
  if (running) headline = running.detail ? `${running.label} ${running.detail}` : running.label;
  else if (last) headline = last.detail ? `${last.label} ${last.detail}` : last.label;

  return { headline, tools, thinking };
};

/** 频道内原地更新的进度正文（含 ⏳ 前缀） */
export const formatProgressMessage = (snap: ProgressSnapshot, maxChars = 500): string => {
  const lines = [`${PROGRESS_PREFIX}正在${snap.headline}…`];
  const recent = snap.tools.slice(-4);
  for (const t of recent) {
    const mark = t.done ? "✅" : "⏳";
    const extra = t.detail ? ` \`${t.detail}\`` : "";
    lines.push(`- ${mark} ${t.label}${extra}`);
  }
  if (snap.thinking && recent.length === 0) {
    lines.push(`💭 ${snap.thinking}`);
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…";
  return text;
};

export const DEFAULT_PROGRESS_THROTTLE_MS = 2000;

export const channelProgressEnabled = (env?: Record<string, string | undefined>): boolean =>
  (env ?? {})["SLOCK_CHANNEL_PROGRESS"] !== "0";

export const readProgressThrottleMs = (env?: Record<string, string | undefined>): number => {
  const n = Number((env ?? {})["SLOCK_PROGRESS_THROTTLE_MS"]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PROGRESS_THROTTLE_MS;
};
