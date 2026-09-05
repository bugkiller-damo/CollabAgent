<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { apiGet, apiPost } from "../api";
import PasswordStrength from "../components/PasswordStrength.vue";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Input from "../components/ui/Input.vue";
import { useAuthStore } from "../stores/authStore";

const authStore = useAuthStore();
const router = useRouter();
const route = useRoute();

const handle = ref("");
const email = ref("");
const password = ref("");
const confirmPwd = ref("");
const showPwd = ref(false);
const error = ref("");
const loading = ref(false);

const invite = (route.query.invite as string) || "";
const inviteInfo = ref<{ serverName?: string; error?: string } | null>(null);

onMounted(() => {
  if (!invite) return;
  apiGet<{ valid: boolean; serverName: string }>(`/api/invites/${invite}`)
    .then((d) => {
      inviteInfo.value = { serverName: d.serverName };
    })
    .catch((e) => {
      inviteInfo.value = { error: e?.message || "邀请链接无效" };
    });
});

async function handleRegister() {
  error.value = "";

  if (password.value !== confirmPwd.value) {
    error.value = "两次密码不一致";
    return;
  }
  if (password.value.length < 8) {
    error.value = "密码至少 8 位";
    return;
  }
  if (!/[a-zA-Z]/.test(password.value) || !/[0-9]/.test(password.value)) {
    error.value = "密码需包含字母和数字";
    return;
  }

  loading.value = true;
  try {
    const data = await apiPost<{ token: string; user: { id: string; handle: string; displayName: string } }>(
      "/api/auth/register",
      {
        handle: handle.value,
        password: password.value,
        email: email.value,
        displayName: handle.value,
        invite: invite || undefined,
      },
    );
    localStorage.setItem("user", JSON.stringify(data.user));
    authStore.user = data.user as any;
    authStore.isAuthenticated = true;
    router.push("/channels/general");
  } catch (err) {
    error.value = (err as Error).message || "注册失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
    <Card padding="lg" class="w-full max-w-sm space-y-5">
      <div class="text-center">
        <h1 class="text-2xl font-bold text-ink">注册</h1>
      </div>

      <div
        v-if="invite && inviteInfo?.serverName"
        class="rounded-lg bg-green-50 p-3 text-center text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300"
      >
        你受邀加入工作区「{{ inviteInfo.serverName }}」，注册后自动入组。
      </div>
      <div
        v-if="invite && inviteInfo?.error"
        class="rounded-lg bg-amber-50 p-3 text-center text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
      >
        {{ inviteInfo.error }}（仍可正常注册，但不会自动入组）
      </div>

      <form class="space-y-4" @submit.prevent="handleRegister">
        <Input
          type="text"
          placeholder="用户名"
          :value="handle"
          @input="handle = ($event.target as HTMLInputElement).value"
          required
          minlength="2"
          maxlength="20"
        />
        <Input
          type="email"
          placeholder="邮箱（用于找回密码）"
          :value="email"
          @input="email = ($event.target as HTMLInputElement).value"
        />
        <div>
          <div class="relative">
            <Input
              :type="showPwd ? 'text' : 'password'"
              placeholder="密码（至少8位，含字母和数字）"
              :value="password"
              @input="password = ($event.target as HTMLInputElement).value"
              class="pr-10"
            />
            <button
              type="button"
              class="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-gray-600 dark:hover:text-gray-200"
              @click="showPwd = !showPwd"
            >
              {{ showPwd ? "🙈" : "👁" }}
            </button>
          </div>
          <PasswordStrength :password="password" />
        </div>
        <Input
          :type="showPwd ? 'text' : 'password'"
          placeholder="确认密码"
          :value="confirmPwd"
          @input="confirmPwd = ($event.target as HTMLInputElement).value"
        />
        <Button type="submit" :loading="loading" class="w-full">注册</Button>
        <p v-if="error" class="text-center text-sm text-red-500">{{ error }}</p>
      </form>

      <p class="text-center text-sm text-muted">
        已有账号？<RouterLink to="/login" class="text-blue-500 hover:underline">登录</RouterLink>
      </p>
    </Card>
  </div>
</template>
