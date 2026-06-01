import { useEffect, useState, useCallback } from "react";
import { apiGet, apiPost } from "../api/client";

interface Agent {
  id: string;
  name: string;
  display_name?: string;
  isOnline: boolean;
}

type Step = 1 | 2 | 3;

// 接入向导：先把本机 Claude 连上服务器（daemon），再创建 Agent，最后开始协作。
// 目标场景：新用户注册后，复制一行命令把本机 Claude 接入，daemon 上线后再创建 AI 同事。
export function ConnectWizard() {
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState("");

  // step 1: 令牌 + 命令 + daemon 上线检测
  const [token, setToken] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [daemonConnected, setDaemonConnected] = useState(false);

  // step 2: 创建 agent
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("sonnet");
  const [creating, setCreating] = useState(false);
  const [createdAgent, setCreatedAgent] = useState<Agent | null>(null);

  // step 3: agent 上线检测
  const [agentOnline, setAgentOnline] = useState(false);

  const serverUrl = window.location.origin;

  const generateToken = async () => {
    setGenerating(true);
    setError("");
    try {
      const r = await apiPost<{ token: string }>("/api/auth/machine-token", {});
      setToken(r.token);
    } catch (err: any) {
      setError(err?.message || "生成令牌失败");
    } finally {
      setGenerating(false);
    }
  };

  // 本地 monorepo 接入命令（尚未发布 npm 包，先用 pnpm --filter daemon dev）
  const command = token
    ? `pnpm --filter @collabagent/daemon dev -- --server-url ${serverUrl} --api-key ${token}`
    : "";

  const copyCommand = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动选择命令复制");
    }
  };

  // step 1：轮询检测「我的 daemon」是否连上
  const pollDaemon = useCallback(async () => {
    try {
      const d = await apiGet<{ connected: boolean }>("/api/daemon/status");
      if (d.connected) setDaemonConnected(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (step !== 1 || !token || daemonConnected) return;
    pollDaemon();
    const t = setInterval(pollDaemon, 3000);
    return () => clearInterval(t);
  }, [step, token, daemonConnected, pollDaemon]);

  const createAgent = async () => {
    const n = name.trim();
    if (!n) return;
    setCreating(true);
    setError("");
    try {
      const r = await apiPost<{ agent: Agent }>("/api/agents", {
        name: n,
        displayName: displayName.trim() || n,
        description: description.trim(),
        runtime: "claude",
        model,
      });
      setCreatedAgent(r.agent);
      setStep(3);
    } catch (err: any) {
      setError(err?.message || "创建失败");
    } finally {
      setCreating(false);
    }
  };

  // step 3：轮询检测新建 agent 是否上线
  const pollAgent = useCallback(async () => {
    if (!createdAgent) return;
    try {
      const d = await apiGet<{ agents: Agent[] }>("/api/agents");
      const me = (d.agents || []).find((a) => a.id === createdAgent.id);
      if (me?.isOnline) setAgentOnline(true);
    } catch {
      /* ignore */
    }
  }, [createdAgent]);

  useEffect(() => {
    if (step !== 3 || agentOnline) return;
    pollAgent();
    const t = setInterval(pollAgent, 3000);
    return () => clearInterval(t);
  }, [step, agentOnline, pollAgent]);

  const inputCls =
    "w-full p-2.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 focus:border-blue-500 outline-none";

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6 overflow-y-auto">
      <div>
        <h1 className="text-gray-900 dark:text-white text-2xl font-bold">接入你的 Agent</h1>
        <p className="text-gray-500 text-sm mt-1">先把本机 Claude 连上平台，再创建你的 AI 同事。</p>
      </div>

      {/* 步骤指示 */}
      <div className="flex items-center gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div
              className={
                "w-7 h-7 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 " +
                (step >= (s as Step) ? "bg-blue-600 text-white" : "bg-gray-200 dark:bg-gray-700 text-gray-500")
              }
            >
              {step > (s as Step) ? "✓" : s}
            </div>
            {s < 3 && (
              <div className={"h-0.5 flex-1 rounded " + (step > (s as Step) ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700")} />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 text-sm rounded p-3">{error}</div>
      )}

      {/* Step 1：连接本机 Claude */}
      {step === 1 && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-5 space-y-4">
          <div>
            <h2 className="text-gray-900 dark:text-white font-semibold">第 1 步 · 连接本机 Claude</h2>
            <p className="text-gray-500 text-xs mt-1">生成接入令牌，复制命令到终端运行，把本机 Claude 守护进程连上来。</p>
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-xs rounded p-3 space-y-1">
            <p className="font-semibold">运行前确保本机已装好 Claude Code：</p>
            <p><code className="bg-black/10 dark:bg-white/10 px-1 rounded">npm install -g @anthropic-ai/claude-code</code> 安装</p>
            <p><code className="bg-black/10 dark:bg-white/10 px-1 rounded">claude</code> 首次运行登录</p>
          </div>

          {!token ? (
            <button onClick={generateToken} disabled={generating}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-500 disabled:opacity-50 text-sm">
              {generating ? "生成中…" : "生成接入令牌"}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="bg-gray-900 dark:bg-black rounded p-3 font-mono text-xs text-green-400 break-all">{command}</div>
              <div className="flex items-center gap-2">
                <button onClick={copyCommand} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-500 text-sm">
                  {copied ? "已复制 ✓" : "复制命令"}
                </button>
              </div>
              <p className="text-gray-400 text-xs">⚠️ 令牌只显示这一次，请妥善保存。它等同于你的机器访问凭证。</p>

              <div className="border-t border-gray-200 dark:border-gray-700 pt-3 flex items-center gap-3">
                {daemonConnected ? (
                  <>
                    <span className="text-green-500 text-lg">✅</span>
                    <span className="text-gray-900 dark:text-white text-sm font-medium">本机 Claude 已连上</span>
                    <button onClick={() => setStep(2)}
                      className="ml-auto bg-green-600 text-white px-4 py-2 rounded hover:bg-green-500 text-sm">
                      下一步：创建 Agent →
                    </button>
                  </>
                ) : (
                  <>
                    <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-gray-500 text-sm">等待 daemon 连接…（命令跑起来后自动检测）</span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2：创建 Agent */}
      {step === 2 && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-5 space-y-3">
          <h2 className="text-gray-900 dark:text-white font-semibold">第 2 步 · 创建你的 Agent</h2>
          <p className="text-gray-500 text-xs">本机已连上。给你的 AI 同事起个名字（仅你可见，直到把别人加进协作空间）。</p>
          <input className={inputCls} placeholder="Agent 名称，如 my-helper" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createAgent()} />
          <input className={inputCls} placeholder="显示名称（可选）" value={displayName}
            onChange={(e) => setDisplayName(e.target.value)} />
          <input className={inputCls} placeholder="描述 / 角色设定（可选）" value={description}
            onChange={(e) => setDescription(e.target.value)} />
          <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="sonnet">Claude Sonnet</option>
            <option value="opus">Claude Opus</option>
            <option value="haiku">Claude Haiku</option>
          </select>
          <button onClick={createAgent} disabled={creating || !name.trim()}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-500 disabled:opacity-50 text-sm">
            {creating ? "创建中…" : "创建并继续"}
          </button>
        </div>
      )}

      {/* Step 3：开始协作 */}
      {step === 3 && createdAgent && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-5 space-y-4 text-center">
          {!agentOnline ? (
            <>
              <div className="inline-block w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <h2 className="text-gray-900 dark:text-white font-semibold">正在唤醒 @{createdAgent.name}…</h2>
              <p className="text-gray-500 text-xs">daemon 正在为新 Agent 启动 Claude 进程，稍候片刻。</p>
            </>
          ) : (
            <>
              <div className="text-5xl">✅</div>
              <h2 className="text-gray-900 dark:text-white font-semibold">@{createdAgent.name} 已上线！</h2>
              <p className="text-gray-500 text-xs">现在可以在任意频道里 @{createdAgent.name} 与它协作，或给它发私信。</p>
              <a href="/channels/general"
                className="inline-block bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-500 text-sm">
                进入频道开始协作 →
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
