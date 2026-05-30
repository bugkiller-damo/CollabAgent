import { WebSocket } from "ws";
import { ApiClient } from "./client.js";
import type { AgentContext } from "./auth.js";
import { claudePrint } from "./claude-print.js";
import { PersistentClaude } from "./drivers/persistent-claude.js";
import { generateRelaySystemPrompt, generateSystemPrompt } from "./system-prompt.js";

export interface DaemonConfig {
  serverUrl: string;
  apiKey: string;
  dataDir?: string;
}

export class DaemonCore {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private apiKey: string;
  private slockDir: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private client: ApiClient;
  private agentId = "00000000-0000-0000-0000-000000000001";
  // 已知 agent 名注册表（值未使用，仅作存在性判断）
  private agentDrivers = new Map<string, boolean>();
  private agentSessions = new Map<string, string>();
  private lastCh = new Map<string, string>();
  private agentNameToId = new Map<string, string>();
  private agentInfo = new Map<string, { displayName?: string; description?: string }>();
  private persistentSessions = new Map<string, PersistentClaude>();
  private usePersistent = process.env.SLOCK_PERSISTENT_CLAUDE !== "0";

  constructor(private config: DaemonConfig) {
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;
    const ctx: AgentContext = {
      agentId: this.agentId,
      serverUrl: config.serverUrl,
      serverId: null,
      token: config.apiKey,
      clientMode: "legacy-machine",
      secretSource: "legacy-token-env",
      activeCapabilities: null,
    };
    this.client = new ApiClient(ctx);
  }

  start(): void {
    console.log(`[Daemon] Starting with server ${this.config.serverUrl}`);
    this.setupSlockWrapper();
    this.connect();
    this.loadExistingAgents();
  }

  private async setupSlockWrapper() {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const slockDir = path.join(process.cwd(), ".slock");
    fs.mkdirSync(slockDir, { recursive: true });

    // cli.ts 与本文件同目录（src/）；按源码位置解析，避免依赖 cwd（pnpm --filter 时 cwd 是包目录）
    const srcDir = path.dirname(url.fileURLToPath(import.meta.url));
    const cliPath = path.join(srcDir, "cli.ts");

    // 预打包 CLI 为单文件 JS，让 slock 用 `node` 直接跑（避免每次 npx tsx 的编译开销，大幅提速）
    let runCmd = `npx tsx "${cliPath}" %*`;
    try {
      const esbuild = await import("esbuild");
      const bundlePath = path.join(slockDir, "slock-cli.cjs");
      await esbuild.build({
        entryPoints: [cliPath],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node18",
        outfile: bundlePath,
        logLevel: "silent",
      });
      runCmd = `node "${bundlePath}" %*`;
      console.log(`[Daemon] CLI bundled -> ${bundlePath} (slock runs via node)`);
    } catch (err: any) {
      console.warn(`[Daemon] CLI bundle failed, falling back to npx tsx: ${err?.message}`);
    }

    // slock.bat — Windows wrapper。SLOCK_AGENT_ID/TOKEN 用 "if not defined" 仅作兜底，
    // 这样 daemon 为每个 agent 启动 Claude 时注入的 per-agent 身份（环境变量）会优先生效。
    const batContent = [
      `@echo off`,
      `if not defined SLOCK_AGENT_ID set SLOCK_AGENT_ID=${this.agentId}`,
      `if not defined SLOCK_SERVER_URL set SLOCK_SERVER_URL=${this.serverUrl}`,
      `if not defined SLOCK_AGENT_TOKEN set SLOCK_AGENT_TOKEN=${this.apiKey}`,
      `if not defined SLOCK_AGENT_ACTIVE_CAPABILITIES set SLOCK_AGENT_ACTIVE_CAPABILITIES=send,read,mentions,tasks,reactions,server,channels`,
      runCmd
    ].join("\r\n");
    fs.writeFileSync(path.join(slockDir, "slock.bat"), batContent);
    console.log(`[Daemon] slock wrapper written to ${slockDir}/slock.bat`);

    // Add .slock to PATH for spawned processes
    const currentPath = process.env.PATH || "";
    if (!currentPath.includes(slockDir)) {
      process.env.PATH = `${slockDir};${currentPath}`;
    }
    this.slockDir = slockDir;
  }

  private async loadExistingAgents() {
    try {
      const res = await fetch(this.serverUrl + '/api/agents', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const data = await res.json() as any;
      for (const agent of (data.agents || [])) {
        const name = agent.name as string;
        if (agent.id) this.agentNameToId.set(name, agent.id as string);
        this.agentInfo.set(name, { displayName: agent.display_name, description: agent.description });
        if (!this.agentDrivers.has(name)) {
          console.log('[Daemon] Registered (lazy): @' + name + ' -> ' + (agent.id || '?').slice(0, 8));
          this.agentDrivers.set(name, true);
        }
      }
    } catch (err: any) {
      console.log('[Daemon] Could not load agents:', err.message);
    }
  }

private connect(): void {
    const url = new URL("/ws", this.config.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    this.ws.on("open", () => {
      console.log("[Daemon] Connected to server");
      this.reconnectDelay = 1000;
      this.ws?.send(JSON.stringify({
        type: "ready", capabilities: ["send", "read"],
        runtimes: ["daemon-cli"],
        hostname: process.env.COMPUTERNAME || "unknown",
        daemonVersion: "0.1.0",
      }));
    });
    this.ws.on("message", (data) => {
      try { this.handleMessage(JSON.parse(data.toString())); } catch {}
    });
    this.ws.on("close", () => {
      console.log("[Daemon] Disconnected, reconnecting...");
      this.scheduleReconnect();
    });
    this.ws.on("error", (err) => console.error("[Daemon] WebSocket error:", err.message));
  }

  // 按已知 agent 名直接匹配 @<name>，支持中文等非 ASCII 名（避免正则只认 ASCII 的问题）
  private mentionedAgentNames(content: string): string[] {
    const found: string[] = [];
    // 名字长的优先，避免短名是长名前缀时误匹配
    const names = Array.from(this.agentDrivers.keys()).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (content.includes("@" + name) && !found.includes(name)) found.push(name);
    }
    return found;
  }

  private findMentionedAgent(content: string): string | null {
    return this.mentionedAgentNames(content)[0] || null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  // 解析 agent 名 → 真实 agentId；未知则回退到任意已知 agent
  private resolveAgentId(agentName: string): string | null {
    if (this.agentNameToId.has(agentName)) return this.agentNameToId.get(agentName)!;
    // agentName 可能本身就是 UUID
    if (/^[0-9a-f-]{36}$/i.test(agentName)) return agentName;
    const first = this.agentNameToId.values().next().value;
    return first || null;
  }

  // 每个 agent 的持久工作区目录；首次创建时种入 MEMORY.md 模板
  private async agentWorkspace(agentName: string): Promise<string> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = path.join(process.cwd(), ".slock", "workspaces", safe);
    fs.mkdirSync(dir, { recursive: true });
    const memFile = path.join(dir, "MEMORY.md");
    if (!fs.existsSync(memFile)) {
      const info = this.agentInfo.get(agentName) || {};
      const seed = [
        `# ${info.displayName || agentName} 的记忆`,
        ``,
        `## 角色`,
        info.description?.trim() || `@${agentName}，CollabAgent 平台上的 AI Agent。`,
        ``,
        `## 关于用户 / 团队`,
        `（在这里记录长期有用的信息：人的偏好、称呼、约定等）`,
        ``,
        `## 频道与长期任务`,
        `（各频道在聊什么、有哪些进行中的长期事项）`,
        ``,
        `## 近期上下文`,
        `（最近发生了什么、聊到哪了）`,
        ``,
      ].join("\n");
      fs.writeFileSync(memFile, seed, "utf-8");
    }
    return dir;
  }

  // 为某个 agent 生成并落盘其系统提示（autonomous = 自主模式，让 agent 自己用 slock CLI）
  private async writeAgentPrompt(agentName: string, channelName: string, autonomous: boolean): Promise<string> {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const info = this.agentInfo.get(agentName) || {};
    const identity = { name: agentName, displayName: info.displayName, description: info.description };
    const prompt = autonomous
      ? generateSystemPrompt(identity, channelName)
      : generateRelaySystemPrompt(identity, channelName);
    const dir = path.join(process.cwd(), ".slock");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `sysprompt-${agentName.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`);
    fs.writeFileSync(file, prompt, "utf-8");
    return file;
  }

  // 统一派发：把一条用户消息交给 agent 处理。
  // 默认走常驻 Claude 进程（进程温热、回合快）；SLOCK_PERSISTENT_CLAUDE=0 时退回一次性 --print。
  private async dispatchToAgent(agentName: string, channelName: string, userMsg: string): Promise<void> {
    const agentId = this.resolveAgentId(agentName);
    if (!agentId) { console.error(`[Daemon] No agent id for @${agentName}, skip`); return; }
    const env = {
      SLOCK_AGENT_ID: agentId,
      SLOCK_AGENT_TOKEN: this.apiKey,
      SLOCK_SERVER_URL: this.serverUrl,
    };
    try {
      const promptFile = await this.writeAgentPrompt(agentName, channelName, true);
      const workspace = await this.agentWorkspace(agentName);
      if (this.usePersistent) {
        let session = this.persistentSessions.get(agentName);
        if (!session) {
          session = new PersistentClaude({ cwd: workspace, systemPromptFile: promptFile, env, label: "@" + agentName });
          this.persistentSessions.set(agentName, session);
        }
        session.send(userMsg); // 串行入队，进程不在则自动重启
        console.log(`[Daemon] @${agentName} message dispatched (persistent)`);
      } else {
        const sid = this.agentSessions.get(agentName);
        const claude = await claudePrint(userMsg, sid, promptFile, env, workspace);
        if (claude.sessionId) this.agentSessions.set(agentName, claude.sessionId);
        console.log(`[Daemon] @${agentName} turn finished (one-shot)`);
      }
    } catch (err: any) {
      console.error("[Daemon] dispatchToAgent failed:", err?.message);
    }
  }

  // 被 @ 时回复（自主模式：agent 用 slock 自行回复，daemon 不转发文本）
  private async runAgent(agentName: string, channelName: string, replyTarget: string, senderName: string, content: string): Promise<void> {
    const inThread = replyTarget.includes(":");
    const where = inThread ? `#${channelName} 的一个线程里` : `#${channelName} 频道`;
    const userMsg = `你在 ${where}被 @ 了。来自 @${senderName} 的消息：${content}\n\n请用 \`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）${inThread ? "在该线程内" : "在该频道"}回复。注意 target 必须严格用 "${replyTarget}"。`;
    await this.dispatchToAgent(agentName, channelName, userMsg);
  }

  // 收到私信时回复（DM 无需被 @，点对点定向即视为被指名）
  private async runAgentDm(agentName: string, replyTarget: string, senderName: string, content: string): Promise<void> {
    const userMsg = `你收到了一条来自 @${senderName} 的私信（DM）：${content}\n\n请用 \`slock message send --target "${replyTarget}"\`（内容从 stdin 传入）直接回复。注意 target 必须严格用 "${replyTarget}"。私信是一对一的，无需被 @ 也应当回应。`;
    await this.dispatchToAgent(agentName, replyTarget, userMsg);
  }

  // 提醒触发：唤醒 agent 做相应跟进
  private async runAgentReminder(agentName: string, reminder: { title?: string; channel?: string }): Promise<void> {
    const channelName = (reminder.channel || "").replace(/^#/, "").split(":")[0] || "general";
    const where = reminder.channel
      ? `相关频道：${reminder.channel}。如需发消息，用 \`echo "内容" | slock message send --target "${reminder.channel}"\`。`
      : `没有指定频道；如需发消息，先用 \`slock server info\` 找到合适频道，或按你 MEMORY.md 里的约定。`;
    const userMsg = `⏰ 你之前设置的提醒触发了：「${reminder.title || "(无标题)"}」。\n${where}\n请据此完成相应跟进；处理完即结束本回合。`;
    await this.dispatchToAgent(agentName, channelName, userMsg);
  }

  private logStatus(status: string, detail?: string) {
    console.log(`[Daemon.Status] ${status}${detail ? " | " + detail.slice(0, 80) : ""}`);
  }


  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string | undefined;
    switch (type) {
      case "agent:start": {
        const agent = msg.agent as Record<string, unknown> | undefined;
        const config = (msg.config as Record<string, unknown> | undefined) || {};
        const agentId = (agent?.id as string) || (msg.agentId as string) || "";
        const agentName = (agent?.name as string) || (config.name as string) || "";
        const displayName = (agent?.displayName as string) || (config.displayName as string) || agentName;
        const description = (agent?.description as string) || (config.description as string) || "";
        if (!agentName) { console.log("[Daemon] agent:start without name, ignored"); break; }
        // 注册到路由表，使新 agent 被 @ 时可立即识别并回复
        this.agentDrivers.set(agentName, true);
        if (agentId) this.agentNameToId.set(agentName, agentId);
        this.agentInfo.set(agentName, { displayName, description });
        // 资料可能变了，重置常驻进程以便下次用新系统提示重启
        this.persistentSessions.get(agentName)?.stop();
        this.persistentSessions.delete(agentName);
        console.log(`[Daemon] agent:start registered @${agentName} -> ${(agentId || "?").slice(0, 8)} (replies on @mention)`);
        break;
      }
      case "agent:deliver": {
        const m = (msg.message || msg) as Record<string, unknown>;
        const content = m.content as string;
        // 防自回环/agent 互相触发：忽略 agent 自己发的消息
        if (m.senderType === "agent") break;
        if (!content || typeof content !== "string") break;
        if (content.startsWith("🤖 ")) break;

        // DM：点对点定向，被私信的本机 agent 无需 @ 也回复
        if (m.dm) {
          const recipients = (m.dmAgentRecipients as string[]) || [];
          const senderHandle = (m.senderHandle as string) || (m.senderName as string) || "unknown";
          const replyTarget = `dm:@${senderHandle}`;
          for (const name of recipients) {
            if (!this.agentDrivers.has(name)) continue; // 仅唤醒本机注册的 agent
            console.log(`[Daemon] DM -> @${name} (reply ${replyTarget})`);
            this.lastCh.set(name, replyTarget);
            try { await this.runAgentDm(name, replyTarget, senderHandle, content); }
            catch (err: any) { console.error("[Daemon] DM dispatch failed:", err?.message); }
          }
          break;
        }

        // Check for @mentions — only reply if the daemon's agent is @mentioned
        const mentionedAgent = this.findMentionedAgent(content || "");
        if (!mentionedAgent) break; // Only respond when @mentioned
        const rawChannel = (m.channelId as string) || "general";
        const channelName = rawChannel.replace(/^#/, "").split(":")[0];
        // 线程消息：被 @ 在某条消息的线程里，回复也应进入该线程（target = #channel:shortid）
        const threadId = (m.threadId as string) || (m.thread_id as string) || "";
        const replyTarget = threadId ? `#${channelName}:${threadId.slice(0, 8)}` : `#${channelName}`;
        const senderName = (m.senderName as string) || (m.senderId as string) || "unknown";
        console.log(`[Daemon] Message from @${senderName} in ${replyTarget}: ${content?.slice(0, 50)}`);

        if (m.senderId === this.agentId || !content || typeof content !== "string") break;
        // Skip our own status messages to avoid infinite loop
        if (content.startsWith("🤖 ")) break;

        // 被 @ 的已注册 agent（按名匹配，支持中文名）
        const mentionedAgents = this.mentionedAgentNames(content);

        try {
          const target = mentionedAgents[0];
          if (target) {
            console.log(`[Daemon] Routing to agent @${target} -> ${replyTarget}`);
            this.lastCh.set(target, channelName);
            await this.runAgent(target, channelName, replyTarget, senderName, content);
          }
        } catch (err: any) {
          console.error("[Daemon] Failed:", err.message);
        }
        break;
      }
      case "agent:stop": {
        const stoppedId = msg.agentId as string;
        // 按 id 找到对应名字并从路由表注销
        for (const [name, id] of this.agentNameToId.entries()) {
          if (id === stoppedId) {
            this.agentNameToId.delete(name);
            this.agentDrivers.delete(name);
            this.agentInfo.delete(name);
            this.agentSessions.delete(name);
            this.persistentSessions.get(name)?.stop();
            this.persistentSessions.delete(name);
            console.log(`[Daemon] agent:stop unregistered @${name}`);
          }
        }
        break;
      }
      case "reminder.fire": {
        const agentId = msg.agentId as string;
        const reminder = (msg.reminder as any) || {};
        let agentName = "";
        for (const [name, id] of this.agentNameToId.entries()) { if (id === agentId) { agentName = name; break; } }
        if (!agentName) { console.log("[Daemon] reminder.fire for unknown agent", agentId); break; }
        console.log(`[Daemon] reminder fired for @${agentName}: ${reminder.title}`);
        await this.runAgentReminder(agentName, reminder);
        break;
      }
      case "ping": this.ws?.send(JSON.stringify({ type: "pong" })); break;
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
    for (const s of this.persistentSessions.values()) s.stop();
    this.persistentSessions.clear();
    console.log("[Daemon] Stopped");
  }
}
