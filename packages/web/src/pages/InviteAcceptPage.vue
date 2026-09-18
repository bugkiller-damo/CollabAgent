<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGet } from "../api";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import { channelPath } from "../lib/nav";
import { useAuthStore, useServerStore } from "../stores";

/**
 * /invite/:token 邀请落地页。
 * - 未登录：转 /register?invite=<token>（注册链路消费邀请并入组）
 * - 已登录：显示邀请信息 → 点击加入 → POST /invites/:token/accept →
 *   刷新 orgs → 落地被邀 server 的 #general
 * 失效（吊销/过期/耗尽）显示对应错误文案。
 */

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const serverStore = useServerStore();

const token = computed(() => String(route.params.token || ""));
const loading = ref(true);
const busy = ref(false);
const serverName = ref("");
const error = ref("");

onMounted(async () => {
  if (!authStore.isAuthenticated) {
    void router.replace({ path: "/register", query: { invite: token.value } });
    return;
  }
  try {
    const d = await apiGet<{ valid: boolean; alreadyMember?: boolean; serverId?: string; serverName: string }>(
      `/api/invites/${encodeURIComponent(token.value)}`,
    );
    // 已是成员（如受邀注册后 invite 已耗尽）：不再要用户点「加入」，直接落地
    if (d.alreadyMember && d.serverId) {
      await serverStore.fetchOrgs().catch(() => []);
      serverStore.setActive(d.serverId);
      void router.replace(channelPath(d.serverId, "general"));
      return;
    }
    serverName.value = d.serverName;
  } catch (e: any) {
    error.value = e?.message || "邀请链接无效";
  } finally {
    loading.value = false;
  }
});

async function accept() {
  busy.value = true;
  error.value = "";
  try {
    const r = await serverStore.acceptInvite(token.value);
    serverStore.setActive(r.serverId);
    void router.replace(channelPath(r.serverId, "general"));
  } catch (e: any) {
    error.value = e?.message || "加入失败";
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
    <Card padding="lg" class="w-full max-w-sm space-y-5 text-center">
      <div v-if="loading" class="py-6 text-sm text-muted">校验邀请中…</div>

      <template v-else-if="serverName">
        <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600 text-2xl font-bold text-white">
          {{ serverName.charAt(0).toUpperCase() }}
        </div>
        <div>
          <h1 class="text-lg font-bold text-ink">加入「{{ serverName }}」</h1>
          <p class="mt-1 text-sm text-muted">加入后即可访问该服务器的频道与成员。</p>
        </div>
        <Button class="w-full" :loading="busy" @click="accept">加入服务器</Button>
        <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
      </template>

      <template v-else>
        <h1 class="text-lg font-bold text-ink">无法加入</h1>
        <p class="text-sm text-muted">{{ error || "邀请链接无效" }}</p>
        <Button class="w-full" @click="router.replace('/')">回到首页</Button>
      </template>
    </Card>
  </div>
</template>
