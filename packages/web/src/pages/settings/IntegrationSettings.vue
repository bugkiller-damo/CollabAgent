<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiClient, apiGet } from "../../api";
import PageHeader from "../../components/layout/PageHeader.vue";
import Button from "../../components/ui/Button.vue";
import Card from "../../components/ui/Card.vue";
import { toast } from "../../stores/toastStore";

interface MachineToken {
  id: string;
  prefix: string;
  expires_at?: string;
  revoked_at?: string;
  created_at: string;
}

const tokens = ref<MachineToken[]>([]);
const newToken = ref<string | null>(null);
// P1-11：加载失败原因——失败不再伪装成「暂无令牌」
const loadError = ref("");

async function loadTokens() {
  try {
    const data = await apiGet<{ tokens: MachineToken[] }>("/api/profile/tokens");
    tokens.value = data.tokens || [];
    loadError.value = "";
  } catch (err: any) {
    loadError.value = err?.message || "网络错误";
  }
}
onMounted(loadTokens);

async function createToken() {
  try {
    const data = await apiClient<{ token: string; prefix: string }>("/api/profile/machine-token", {
      method: "POST",
      body: {},
    });
    newToken.value = data.token;
    toast.success("令牌已生成，请立即复制保存（仅显示一次）");
    loadTokens();
  } catch (err: any) {
    toast.error(err?.message || "生成失败");
  }
}

async function revokeToken(id: string) {
  try {
    await apiClient(`/api/profile/tokens/${id}`, { method: "DELETE" });
    toast.success("令牌已撤销");
    loadTokens();
  } catch (err: any) {
    toast.error(err?.message || "撤销失败");
  }
}

async function copyNewToken() {
  if (!newToken.value) return;
  await navigator.clipboard.writeText(newToken.value);
  toast.success("已复制");
}

const DAY_MS = 86_400_000;

// P1.12（90 天滚动过期）前端化：展示 expires_at 让用户感知闲置令牌将到期
function expiryLabel(t: MachineToken): string {
  if (!t.expires_at) return "永不过期";
  const exp = new Date(t.expires_at);
  const date = exp.toLocaleDateString("zh-CN");
  const days = Math.ceil((exp.getTime() - Date.now()) / DAY_MS);
  if (days <= 0) return `已于 ${date} 过期`;
  return `有效期至 ${date}（${days} 天后过期）`;
}

function expiryClass(t: MachineToken): string {
  if (!t.expires_at) return "";
  const days = Math.ceil((new Date(t.expires_at).getTime() - Date.now()) / DAY_MS);
  if (days <= 0) return "text-red-500";
  if (days <= 14) return "text-amber-600 dark:text-amber-400";
  return "";
}

const activeTokens = computed(() => tokens.value.filter((t) => !t.revoked_at));
</script>

<template>
  <div class="w-full space-y-6">
    <PageHeader title="集成" back-to="/settings" />
    <p class="text-sm text-gray-500">管理 API 令牌，用于连接外部工具和 daemon</p>

    <Card class="space-y-3">
      <h3 class="text-sm font-semibold text-ink">机器令牌</h3>
      <p class="text-xs text-gray-500">令牌用于 daemon 鉴权。创建后请立即复制——令牌仅显示一次。</p>
      <Button @click="createToken" size="sm">+ 生成新令牌</Button>

      <div v-if="newToken" class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
        <p class="mb-1 text-xs font-bold text-amber-800 dark:text-amber-300">⚠️ 新令牌（仅显示一次）</p>
        <code class="block break-all rounded bg-white p-2 font-mono text-sm text-gray-900 dark:bg-gray-900 dark:text-white">{{ newToken }}</code>
        <div class="mt-2 flex gap-2">
          <Button @click="copyNewToken" size="sm" variant="secondary">📋 复制</Button>
          <Button @click="newToken = null" size="sm" variant="ghost">关闭</Button>
        </div>
      </div>
    </Card>

    <div>
      <h3 class="mb-2 text-sm font-semibold text-ink">当前令牌（{{ activeTokens.length }}）</h3>
      <!-- P1-11：加载失败显示错误态 + 重试，不再伪装成「暂无令牌」 -->
      <p v-if="loadError && activeTokens.length === 0" class="text-sm text-red-500">
        令牌加载失败：{{ loadError }}
        <button type="button" class="ml-1 text-blue-600 hover:underline dark:text-blue-400" @click="loadTokens">重试</button>
      </p>
      <p v-else-if="activeTokens.length === 0" class="text-sm text-gray-500">暂无令牌</p>
      <div v-else class="grid grid-cols-1 gap-2 lg:grid-cols-2">
        <Card v-for="t in activeTokens" :key="t.id" padding="sm" class="flex items-center justify-between">
          <div>
            <code class="font-mono text-sm text-ink">{{ t.prefix }}...****</code>
            <p class="mt-0.5 text-xs text-gray-500">
              创建于 {{ new Date(t.created_at).toLocaleDateString("zh-CN") }} ·
              <span :class="expiryClass(t)">{{ expiryLabel(t) }}</span>
            </p>
          </div>
          <Button @click="revokeToken(t.id)" variant="ghost" size="sm" class="text-red-500 hover:text-red-600">撤销</Button>
        </Card>
      </div>
    </div>
  </div>
</template>
