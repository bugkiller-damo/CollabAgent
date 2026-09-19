<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Input from "../components/ui/Input.vue";
import { channelPath } from "../lib/nav";
import { hasOwnServer, useAuthStore, useChannelStore, useServerStore } from "../stores";

/**
 * 新注册强制向导：给「自己的服务器」命名后落地其首个频道（新建 server
 * 只有私有 onboarding-owner 频道）。
 * 实现：2026-09-19 personal 特例取消后 GET /api/orgs 不再懒建空间——
 * 向导恒走 POST /api/orgs 新建。
 * 受邀注册用户不经此页（InviteAcceptPage 直接落地被邀 server，顶部引导条
 * 稍后再来建自己的 server）；存量用户手动进来时若已有自有 server 直接放行。
 */

const router = useRouter();
const authStore = useAuthStore();
const serverStore = useServerStore();
const channelStore = useChannelStore();

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
  // 已有自有 server（向导已完成/手动建过/受邀后被擢升 owner）→ 不再走向导。
  // hasOwnServer = owns 非公共 server——广场 owner（实例 admin）不算自有。
  if (hasOwnServer(serverStore.orgs)) {
    const target = serverStore.orgs.find((o) => o.role === "owner" && !o.is_public) ?? serverStore.orgs[0];
    // 落点按真实频道列表解析：新建 server 无 general（只有私有 onboarding-owner）
    if (target) void router.replace(channelPath(target.id, await channelStore.resolveLandingChannel(target.id)));
    return;
  }
  name.value = `${authStore.user?.handle ?? "我"} 的服务器`;
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
    const created = await serverStore.createServer(n);
    serverStore.setActive(created.id);
    // 新建 server 落点是私有 onboarding-owner，不是 general
    const ch = await channelStore.resolveLandingChannel(created.id);
    void router.replace(channelPath(created.id, ch));
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
