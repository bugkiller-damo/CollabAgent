<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Input from "../components/ui/Input.vue";
import { channelPath } from "../lib/nav";
import { hasOwnServer, useAuthStore, useServerStore } from "../stores";

/**
 * 新注册强制向导：给「自己的服务器」命名后落地其 #general。
 * 实现：GET /api/orgs 会惰性建 personal server——向导 = 找到 personal org
 * 并 PATCH 改名；找不到（异常态）才走 POST /api/orgs 新建。
 * 受邀注册用户不经此页（InviteAcceptPage 直接落地被邀 server，顶部引导条
 * 稍后再来建自己的 server）；存量用户手动进来时若已有自有 server 直接放行。
 */

const router = useRouter();
const authStore = useAuthStore();
const serverStore = useServerStore();

const name = ref("");
const error = ref("");
const busy = ref(false);
const checking = ref(true);

onMounted(async () => {
  try {
    await serverStore.fetchOrgs();
  } catch {
    /* 列表拉失败不挡向导，提交时再兜底 */
  }
  // 已有自有 server（向导已完成/手动建过/存量非 personal owner）→ 不再走向导。
  // 不能用 role==='owner' 单判：personal server 用户天然 owner，会把新用户直接放行
  if (hasOwnServer(serverStore.orgs, authStore.user?.handle)) {
    const target = serverStore.orgs.find((o) => o.role === "owner") ?? serverStore.orgs[0];
    if (target) void router.replace(channelPath(target.id, "general"));
    return;
  }
  const personal = serverStore.orgs.find((o) => o.personal);
  // 预填：personal server 现名（默认 "<handle> 的私有空间"）或 handle 兜底
  name.value = personal?.name?.trim() || `${authStore.user?.handle ?? "我"} 的服务器`;
  checking.value = false;
});

async function submit() {
  const n = name.value.trim();
  if (!n) {
    error.value = "请输入服务器名称";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    let orgs = serverStore.orgs;
    if (orgs.length === 0) orgs = await serverStore.fetchOrgs();
    const personal = orgs.find((o) => o.personal);
    let serverId: string;
    if (personal) {
      await serverStore.renameServer(personal.id, n);
      serverId = personal.id;
    } else {
      const created = await serverStore.createServer(n);
      serverId = created.id;
    }
    serverStore.setActive(serverId);
    void router.replace(channelPath(serverId, "general"));
  } catch (e: any) {
    error.value = e?.message || "创建失败，请重试";
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
    <Card padding="lg" class="w-full max-w-md space-y-6">
      <div class="text-center">
        <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white">
          {{ (name.trim() || "服").charAt(0).toUpperCase() }}
        </div>
        <h1 class="text-xl font-bold text-ink">创建你的服务器</h1>
        <p class="mt-1 text-sm text-muted">频道、成员和 Agent 都在服务器中。之后还可以再建别的服务器、或加入别人的。</p>
      </div>

      <div v-if="checking" class="py-6 text-center text-sm text-muted">准备中…</div>

      <form v-else class="space-y-4" @submit.prevent="submit">
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">服务器名称</label>
          <Input
            type="text"
            :value="name"
            maxlength="100"
            placeholder="例如：产品组、我的工作室"
            @input="name = ($event.target as HTMLInputElement).value"
          />
        </div>
        <Button type="submit" :loading="busy" class="w-full">创建并进入</Button>
        <p v-if="error" class="text-center text-sm text-red-500">{{ error }}</p>
      </form>
    </Card>
  </div>
</template>
