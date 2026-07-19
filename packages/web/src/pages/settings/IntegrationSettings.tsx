import { useEffect, useState } from "react";
import { apiGet, apiClient } from "../../api/client";
import { toast } from "../../stores/toastStore";
import { PageHeader } from "../../components/layout/PageHeader";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";

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
    <div className="w-full space-y-6">
      <PageHeader title="集成" backTo="/settings" />
      <p className="text-sm text-gray-500">管理 API 令牌，用于连接外部工具和 daemon</p>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">机器令牌</h3>
        <p className="text-xs text-gray-500">令牌用于 daemon 鉴权。创建后请立即复制——令牌仅显示一次。</p>
        <Button onClick={createToken} size="sm">+ 生成新令牌</Button>

        {newToken && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
            <p className="mb-1 text-xs font-bold text-amber-800 dark:text-amber-300">⚠️ 新令牌（仅显示一次）</p>
            <code className="block break-all rounded bg-white p-2 font-mono text-sm text-gray-900 dark:bg-gray-900 dark:text-white">{newToken}</code>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => { navigator.clipboard.writeText(newToken); toast.success("已复制"); }} size="sm" variant="secondary">📋 复制</Button>
              <Button onClick={() => setNewToken(null)} size="sm" variant="ghost">关闭</Button>
            </div>
          </div>
        )}
      </Card>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">当前令牌（{activeTokens.length}）</h3>
        {activeTokens.length === 0 ? (
          <p className="text-sm text-gray-500">暂无令牌</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {activeTokens.map((t) => (
              <Card key={t.id} padding="sm" className="flex items-center justify-between">
                <div>
                  <code className="font-mono text-sm text-gray-900 dark:text-white">{t.prefix}...****</code>
                  <p className="mt-0.5 text-xs text-gray-500">创建于 {new Date(t.created_at).toLocaleDateString("zh-CN")}</p>
                </div>
                <Button onClick={() => revokeToken(t.id)} variant="ghost" size="sm" className="text-red-500 hover:text-red-600">撤销</Button>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
