import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiPost } from "../api/client";
import { Card } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";

interface Agent {
  id: string;
  name: string;
  display_name?: string;
  isOnline: boolean;
  avatar_url?: string;
}

type Step = 1 | 2 | 3;

export function ConnectWizard() {
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState("");

  const [token, setToken] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [daemonConnected, setDaemonConnected] = useState(false);

  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("sonnet");
  const [creating, setCreating] = useState(false);
  const [createdAgent, setCreatedAgent] = useState<Agent | null>(null);

  const [agentOnline, setAgentOnline] = useState(false);

  const serverUrl = window.location.origin;

  const generateToken = async () => {
    setGenerating(true);
    setError("");
    try {
      const r = await apiPost<{ token: string }>("/api/profile/machine-token", {});
      setToken(r.token);
    } catch (err: any) {
      setError(err?.message || "生成令牌失败");
    } finally {
      setGenerating(false);
    }
  };

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

  const pollDaemon = useCallback(async () => {
    try {
      const d = await apiGet<{ connected: boolean }>("/api/daemon/status");
      if (d.connected) setDaemonConnected(true);
    } catch { /* ignore */ }
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

  const pollAgent = useCallback(async () => {
    if (!createdAgent) return;
    try {
      const d = await apiGet<{ agents: Agent[] }>("/api/agents");
      const me = (d.agents || []).find((a) => a.id === createdAgent.id);
      if (me?.isOnline) setAgentOnline(true);
    } catch { /* ignore */ }
  }, [createdAgent]);

  useEffect(() => {
    if (step !== 3 || agentOnline) return;
    pollAgent();
    const t = setInterval(pollAgent, 3000);
    return () => clearInterval(t);
  }, [step, agentOnline, pollAgent]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 overflow-y-auto p-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">接入你的 Agent</h1>
        <p className="mt-1 text-sm text-gray-500">先把本机 Claude 连上平台，再创建你的 AI 同事。</p>
      </div>

      {/* 步骤指示 */}
      <div className="flex items-center gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex flex-1 items-center gap-2">
            <div
              className={[
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                step >= (s as Step) ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-500 dark:bg-gray-700",
              ].join(" ")}
            >
              {step > (s as Step) ? "✓" : s}
            </div>
            {s < 3 && (
              <div className={["h-0.5 flex-1 rounded", step > (s as Step) ? "bg-blue-600" : "bg-gray-200 dark:bg-gray-700"].join(" ")} />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">{error}</div>
      )}

      {step === 1 && (
        <Card className="space-y-4">
          <div>
            <h2 className="font-semibold text-gray-900 dark:text-white">第 1 步 · 连接本机 Claude</h2>
            <p className="mt-1 text-xs text-gray-500">生成接入令牌，复制命令到终端运行，把本机 Claude 守护进程连上来。</p>
          </div>

          <div className="space-y-1 rounded bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
            <p className="font-semibold">运行前确保本机已装好 Claude Code：</p>
            <p><code className="rounded bg-black/10 px-1 dark:bg-white/10">npm install -g @anthropic-ai/claude-code</code> 安装</p>
            <p><code className="rounded bg-black/10 px-1 dark:bg-white/10">claude</code> 首次运行登录</p>
          </div>

          {!token ? (
            <Button onClick={generateToken} loading={generating}>生成接入令牌</Button>
          ) : (
            <div className="space-y-3">
              <div className="break-all rounded bg-gray-900 p-3 font-mono text-xs text-green-400 dark:bg-black">{command}</div>
              <div className="flex items-center gap-2">
                <Button onClick={copyCommand} variant="secondary" size="sm">{copied ? "已复制 ✓" : "复制命令"}</Button>
              </div>
              <p className="text-xs text-gray-400">⚠️ 令牌只显示这一次，请妥善保存。它等同于你的机器访问凭证。</p>

              <div className="flex items-center gap-3 border-t border-gray-200 pt-3 dark:border-gray-700">
                {daemonConnected ? (
                  <>
                    <span className="text-lg text-green-500">✅</span>
                    <span className="text-sm font-medium text-gray-900 dark:text-white">本机 Claude 已连上</span>
                    <Button onClick={() => setStep(2)} size="sm" className="ml-auto">下一步：创建 Agent →</Button>
                  </>
                ) : (
                  <>
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                    <span className="text-sm text-gray-500">等待 daemon 连接…（命令跑起来后自动检测）</span>
                  </>
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      {step === 2 && (
        <Card className="space-y-3">
          <h2 className="font-semibold text-gray-900 dark:text-white">第 2 步 · 创建你的 Agent</h2>
          <p className="text-xs text-gray-500">本机已连上。给你的 AI 同事起个名字（仅你可见，直到把别人加进协作空间）。</p>
          <Input placeholder="Agent 名称，如 my-helper" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createAgent()} />
          <Input placeholder="显示名称（可选）" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <Input placeholder="描述 / 角色设定（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          >
            <option value="sonnet">Claude Sonnet</option>
            <option value="opus">Claude Opus</option>
            <option value="haiku">Claude Haiku</option>
          </select>
          <Button onClick={createAgent} disabled={creating || !name.trim()} loading={creating}>创建并继续</Button>
        </Card>
      )}

      {step === 3 && createdAgent && (
        <Card className="space-y-4 text-center">
          {!agentOnline ? (
            <>
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
              <h2 className="font-semibold text-gray-900 dark:text-white">正在唤醒 @{createdAgent.name}…</h2>
              <p className="text-xs text-gray-500">daemon 正在为新 Agent 启动 Claude 进程，稍候片刻。</p>
            </>
          ) : (
            <>
              <div className="text-5xl">✅</div>
              <h2 className="font-semibold text-gray-900 dark:text-white">@{createdAgent.name} 已上线！</h2>
              <p className="text-xs text-gray-500">现在可以在任意频道里 @{createdAgent.name} 与它协作，或给它发私信。</p>
              <Link to="/channels/general"
                className="inline-block rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
              >
                进入频道开始协作 →
              </Link>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
