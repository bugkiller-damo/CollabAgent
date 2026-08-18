<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { apiGet, apiPost } from "../api";
import Button from "../components/ui/Button.vue";
import Card from "../components/ui/Card.vue";
import Input from "../components/ui/Input.vue";

interface Agent {
  id: string;
  name: string;
  display_name?: string;
  isOnline: boolean;
  avatar_url?: string;
}

type Step = 1 | 2 | 3;

const step = ref<Step>(1);
const error = ref("");

const token = ref("");
const generating = ref(false);
const copied = ref(false);
const daemonConnected = ref(false);

const name = ref("");
const displayName = ref("");
const description = ref("");
const model = ref("sonnet");
const creating = ref(false);
const createdAgent = ref<Agent | null>(null);

const agentOnline = ref(false);

const serverUrl = window.location.origin;

const command = computed(() =>
  token.value ? `pnpm --filter @collabagent/daemon dev -- --server-url ${serverUrl} --api-key ${token.value}` : "",
);

async function generateToken() {
  generating.value = true;
  error.value = "";
  try {
    const r = await apiPost<{ token: string }>("/api/profile/machine-token", {});
    token.value = r.token;
  } catch (err: any) {
    error.value = err?.message || "生成令牌失败";
  } finally {
    generating.value = false;
  }
}

async function copyCommand() {
  if (!command.value) return;
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    error.value = "复制失败，请手动选择命令复制";
  }
}

async function pollDaemon() {
  try {
    const d = await apiGet<{ connected: boolean }>("/api/daemon/status");
    if (d.connected) daemonConnected.value = true;
  } catch {
    /* ignore */
  }
}

async function createAgent() {
  const n = name.value.trim();
  if (!n) return;
  creating.value = true;
  error.value = "";
  try {
    const r = await apiPost<{ agent: Agent }>("/api/agents", {
      name: n,
      displayName: displayName.value.trim() || n,
      description: description.value.trim(),
      runtime: "claude",
      model: model.value,
    });
    createdAgent.value = r.agent;
    step.value = 3;
  } catch (err: any) {
    error.value = err?.message || "创建失败";
  } finally {
    creating.value = false;
  }
}

async function pollAgent() {
  if (!createdAgent.value) return;
  try {
    const d = await apiGet<{ agents: Agent[] }>("/api/agents");
    const me = (d.agents || []).find((a) => a.id === createdAgent.value!.id);
    if (me?.isOnline) agentOnline.value = true;
  } catch {
    /* ignore */
  }
}

// 第 1 步：token 生成后轮询 daemon 连接状态，直到连上或离开第 1 步
let daemonTimer: ReturnType<typeof setInterval> | null = null;
watch([step, token, daemonConnected], () => {
  if (step.value !== 1 || !token.value || daemonConnected.value) {
    if (daemonTimer !== null) {
      clearInterval(daemonTimer);
      daemonTimer = null;
    }
    return;
  }
  void pollDaemon();
  if (daemonTimer !== null) clearInterval(daemonTimer);
  daemonTimer = setInterval(pollDaemon, 3000);
});

// 第 3 步：创建 Agent 后轮询上线状态，直到上线或离开第 3 步
let agentTimer: ReturnType<typeof setInterval> | null = null;
watch([step, agentOnline], () => {
  if (step.value !== 3 || agentOnline.value) {
    if (agentTimer !== null) {
      clearInterval(agentTimer);
      agentTimer = null;
    }
    return;
  }
  void pollAgent();
  if (agentTimer !== null) clearInterval(agentTimer);
  agentTimer = setInterval(pollAgent, 3000);
});

onUnmounted(() => {
  if (daemonTimer !== null) clearInterval(daemonTimer);
  if (agentTimer !== null) clearInterval(agentTimer);
});
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6 overflow-y-auto p-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">接入你的 Agent</h1>
      <p class="mt-1 text-sm text-gray-500">先把本机 Claude 连上平台，再创建你的 AI 同事。</p>
    </div>

    <!-- 步骤指示 -->
    <div class="flex items-center gap-2">
      <div v-for="s in [1, 2, 3]" :key="s" class="flex flex-1 items-center gap-2">
        <div
          :class="['flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold', step >= s ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500 dark:bg-gray-700']"
        >
          {{ step > s ? "✓" : s }}
        </div>
        <div v-if="s < 3" :class="['h-0.5 flex-1 rounded', step > s ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700']" />
      </div>
    </div>

    <div v-if="error" class="rounded bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">{{ error }}</div>

    <Card v-if="step === 1" class="space-y-4">
      <div>
        <h2 class="font-semibold text-gray-900 dark:text-white">第 1 步 · 连接本机 Claude</h2>
        <p class="mt-1 text-xs text-gray-500">生成接入令牌，复制命令到终端运行，把本机 Claude 守护进程连上来。</p>
      </div>

      <div class="space-y-1 rounded bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
        <p class="font-semibold">运行前确保本机已装好 Claude Code：</p>
        <p><code class="rounded bg-black/10 px-1 dark:bg-white/10">npm install -g @anthropic-ai/claude-code</code> 安装</p>
        <p><code class="rounded bg-black/10 px-1 dark:bg-white/10">claude</code> 首次运行登录</p>
      </div>

      <Button v-if="!token" @click="generateToken" :loading="generating">生成接入令牌</Button>
      <div v-else class="space-y-3">
        <div class="break-all rounded bg-gray-900 p-3 font-mono text-xs text-green-400 dark:bg-black">{{ command }}</div>
        <div class="flex items-center gap-2">
          <Button @click="copyCommand" variant="secondary" size="sm">{{ copied ? "已复制 ✓" : "复制命令" }}</Button>
        </div>
        <p class="text-xs text-gray-400">⚠️ 令牌只显示这一次，请妥善保存。它等同于你的机器访问凭证。</p>

        <div class="flex items-center gap-3 border-t border-gray-200 pt-3 dark:border-gray-700">
          <template v-if="daemonConnected">
            <span class="text-lg text-green-500">✅</span>
            <span class="text-sm font-medium text-gray-900 dark:text-white">本机 Claude 已连上</span>
            <Button @click="step = 2" size="sm" class="ml-auto">下一步：创建 Agent →</Button>
          </template>
          <template v-else>
            <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            <span class="text-sm text-gray-500">等待 daemon 连接…（命令跑起来后自动检测）</span>
          </template>
        </div>
      </div>
    </Card>

    <Card v-if="step === 2" class="space-y-3">
      <h2 class="font-semibold text-gray-900 dark:text-white">第 2 步 · 创建你的 Agent</h2>
      <p class="text-xs text-gray-500">本机已连上。给你的 AI 同事起个名字（仅你可见，直到把别人加进协作空间）。</p>
      <Input placeholder="Agent 名称，如 my-helper" :value="name" @input="name = ($event.target as HTMLInputElement).value" @keydown.enter="createAgent" />
      <Input placeholder="显示名称（可选）" :value="displayName" @input="displayName = ($event.target as HTMLInputElement).value" />
      <Input placeholder="描述 / 角色设定（可选）" :value="description" @input="description = ($event.target as HTMLInputElement).value" />
      <select
        v-model="model"
        class="w-full rounded-md border border-gray-300 bg-gray-100 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
      >
        <option value="sonnet">Claude Sonnet</option>
        <option value="opus">Claude Opus</option>
        <option value="haiku">Claude Haiku</option>
      </select>
      <Button @click="createAgent" :disabled="creating || !name.trim()" :loading="creating">创建并继续</Button>
    </Card>

    <Card v-if="step === 3 && createdAgent" class="space-y-4 text-center">
      <template v-if="!agentOnline">
        <div class="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
        <h2 class="font-semibold text-gray-900 dark:text-white">正在唤醒 @{{ createdAgent?.name }}…</h2>
        <p class="text-xs text-gray-500">daemon 正在为新 Agent 启动 Claude 进程，稍候片刻。</p>
      </template>
      <template v-else>
        <div class="text-5xl">✅</div>
        <h2 class="font-semibold text-gray-900 dark:text-white">@{{ createdAgent?.name }} 已上线！</h2>
        <p class="text-xs text-gray-500">现在可以在任意频道里 @{{ createdAgent?.name }} 与它协作，或给它发私信。</p>
        <RouterLink
          to="/channels/general"
          class="inline-block rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
        >
          进入频道开始协作 →
        </RouterLink>
      </template>
    </Card>
  </div>
</template>
