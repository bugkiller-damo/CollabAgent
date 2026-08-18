<script setup lang="ts">
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Input from "../components/ui/Input.vue";
import { useAuthStore } from "../stores/authStore";

const authStore = useAuthStore();
const router = useRouter();

const login = ref("");
const password = ref("");
const rememberMe = ref(false);
const error = ref("");
const loading = ref(false);

async function handleLogin() {
  error.value = "";
  loading.value = true;
  try {
    await authStore.login(login.value, password.value, rememberMe.value);
    router.push("/channels/general");
  } catch (err: any) {
    error.value = err.message || "登录失败";
  } finally {
    loading.value = false;
  }
}

function handleDevBypass() {
  fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "dev", password: "dev", remember: true }),
  })
    .then((r) => r.json())
    .then((d) => {
      if (d.user) {
        localStorage.setItem("user", JSON.stringify(d.user));
        authStore.user = d.user as any;
        authStore.isAuthenticated = true;
        router.push("/channels/general");
      }
    })
    .catch(() => {});
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
    <Card padding="lg" class="w-full max-w-sm space-y-5">
      <div class="text-center">
        <div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600 text-white">
          <span class="font-bold">C</span>
        </div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">CollabAgent</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">登录到工作区</p>
      </div>

      <form class="space-y-4" @submit.prevent="handleLogin">
        <Input
          type="text"
          placeholder="用户名或邮箱"
          :value="login"
          @input="login = ($event.target as HTMLInputElement).value"
          autocomplete="username"
        />
        <Input
          type="password"
          placeholder="密码"
          :value="password"
          @input="password = ($event.target as HTMLInputElement).value"
          autocomplete="current-password"
        />
        <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            :checked="rememberMe"
            @change="rememberMe = ($event.target as HTMLInputElement).checked"
            class="rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
          />
          记住我（30 天免登录）
        </label>
        <Button type="submit" :loading="loading" class="w-full">登录</Button>
        <p v-if="error" class="text-center text-sm text-red-500">{{ error }}</p>
      </form>

      <p class="text-center text-sm text-gray-500 dark:text-gray-400">
        <RouterLink to="/forgot-password" class="text-blue-500 hover:underline">忘记密码</RouterLink>
        <span class="mx-2">·</span>
        <RouterLink to="/register" class="text-blue-500 hover:underline">注册</RouterLink>
      </p>

      <Button type="button" variant="secondary" class="w-full" @click="handleDevBypass">
        开发模式：跳过登录
      </Button>
    </Card>
  </div>
</template>
