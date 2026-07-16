import { useEffect, useState } from "react";
import { apiGet, apiClient } from "../../api/client";
import { toast } from "../../stores/toastStore";

interface MachineToken {
  id: string;
  prefix: string;
  expires_at?: string;
  revoked_at?: string;
  created_at: string;
}

export function IntegrationSettings() {
  const [tokens, setTokens] = useState<MachineToken[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);

  const loadTokens = async () => {
    try {
      const data = await apiGet<{ tokens: MachineToken[] }>("/api/profile/tokens");
      setTokens(data.tokens || []);
    } catch { /* silent */ }
  };

  useEffect(() => { loadTokens(); }, []);

  const createToken = async () => {
    try {
      const data = await apiClient<{ token: string; prefix: string }>("/api/profile/machine-token", { method: "POST", body: {} });
      setNewToken(data.token);
      toast.success("令牌已生成，请立即复制保存（仅显示一次）");
      loadTokens();
    } catch (err: any) {
      toast.error(err?.message || "生成失败");
    }
  };

  const revokeToken = async (id: string) => {
    try {
      await apiClient(`/api/profile/tokens/${id}`, { method: "DELETE" });
      toast.success("令牌已撤销");
      loadTokens();
    } catch (err: any) {
      toast.error(err?.message || "撤销失败");
    }
  };

  const activeTokens = tokens.filter((t) => !t.revoked_at);

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h2 className="text-gray-900 dark:text-white text-xl font-bold">集成设置</h2>
      <p className="text-gray-500 text-sm">管理 API 令牌，用于连接外部工具和 daemon</p>

      <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700/50">
        <h3 className="text-gray-900 dark:text-white font-semibold text-sm mb-3">机器令牌</h3>
        <p className="text-gray-500 text-xs mb-3">令牌用于 daemon 鉴权。创建后请立即复制——令牌仅显示一次。</p>
        <button onClick={createToken}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">+ 生成新令牌</button>

        {newToken && (
          <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
            <p className="text-amber-800 dark:text-amber-300 text-xs font-bold mb-1">⚠️ 新令牌（仅显示一次）</p>
            <code className="block p-2 bg-white dark:bg-gray-900 rounded text-sm font-mono break-all text-gray-900 dark:text-white">{newToken}</code>
            <button onClick={() => { navigator.clipboard.writeText(newToken); toast.success("已复制"); }} className="mt-2 text-blue-600 dark:text-blue-400 text-xs hover:underline">📋 复制</button>
            <button onClick={() => setNewToken(null)} className="ml-2 text-gray-500 text-xs hover:underline">关闭</button>
          </div>
        )}
      </div>

      <div>
        <h3 className="text-gray-900 dark:text-white font-semibold text-sm mb-2">当前令牌（{activeTokens.length}）</h3>
        {activeTokens.length === 0 ? (
          <p className="text-gray-500 text-sm">暂无令牌</p>
        ) : (
          <div className="space-y-2">
            {activeTokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700/50">
                <div>
                  <code className="text-gray-900 dark:text-white text-sm font-mono">{t.prefix}...****</code>
                  <p className="text-gray-500 text-xs mt-0.5">创建于 {new Date(t.created_at).toLocaleDateString("zh-CN")}</p>
                </div>
                <button onClick={() => revokeToken(t.id)}
                  className="text-red-500 hover:text-red-600 text-xs px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30">撤销</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
