<script setup lang="ts">
import { ref } from "vue";
import { RouterLink } from "vue-router";
import { apiPost } from "../api";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Input from "../components/ui/Input.vue";

const email = ref("");
const code = ref("");
const newPw = ref("");
const step = ref<"email" | "reset">("email");
const msg = ref("");
const err = ref("");
const loading = ref(false);

async function handleSendCode() {
  err.value = "";
  msg.value = "";
  if (!email.value.includes("@")) {
    err.value = "请输入有效邮箱";
    return;
  }
  loading.value = true;
  try {
    const data = await apiPost<{ message: string; devCode?: string }>("/api/auth/forgot-password", {
      email: email.value,
    });
    msg.value = data.devCode ? `验证码（开发模式）: ${data.devCode}` : data.message;
    step.value = "reset";
  } catch (e: any) {
    err.value = e.message || "发送失败";
  } finally {
    loading.value = false;
  }
}

async function handleReset() {
  err.value = "";
  msg.value = "";
  if (newPw.value.length < 6) {
    err.value = "新密码至少 6 位";
    return;
  }
  loading.value = true;
  try {
    await apiPost("/api/auth/reset-password", { email: email.value, code: code.value, password: newPw.value });
    msg.value = "密码已重置！去登录吧。";
    step.value = "email";
  } catch (e: any) {
    err.value = e.message || "重置失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
    <Card padding="lg" class="w-full max-w-sm space-y-5">
      <div class="text-center">
        <h1 class="text-2xl font-bold text-ink">找回密码</h1>
      </div>

      <div v-if="step === 'email'" class="space-y-4">
        <Input
          type="email"
          placeholder="注册邮箱"
          :value="email"
          @input="email = ($event.target as HTMLInputElement).value"
        />
        <Button class="w-full" :loading="loading" @click="handleSendCode">发送验证码</Button>
      </div>
      <div v-else class="space-y-4">
        <Input
          type="text"
          placeholder="6 位验证码"
          :value="code"
          @input="code = ($event.target as HTMLInputElement).value"
          maxlength="6"
        />
        <Input
          type="password"
          placeholder="新密码（至少6位）"
          :value="newPw"
          @input="newPw = ($event.target as HTMLInputElement).value"
        />
        <Button class="w-full" :loading="loading" @click="handleReset">重置密码</Button>
      </div>

      <p v-if="msg" class="text-center text-sm text-green-600 dark:text-green-400">{{ msg }}</p>
      <p v-if="err" class="text-center text-sm text-red-500">{{ err }}</p>
      <p class="text-center text-sm text-muted">
        <RouterLink to="/login" class="text-blue-500 hover:underline">返回登录</RouterLink>
      </p>
    </Card>
  </div>
</template>
