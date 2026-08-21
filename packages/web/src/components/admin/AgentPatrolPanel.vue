<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiClient, apiGet, apiPost } from "../../api";
import { toast } from "../../stores/toastStore";
import EmptyState from "../EmptyState.vue";
import Button from "../ui/Button.vue";
import Card from "../ui/Card.vue";
import Input from "../ui/Input.vue";

// T2 定时巡检最小管理面板（设计:docs/2026-08-19/02-t2-agent-patrol-design.md §T2.5）
// 复用 /internal/agent/:id/reminders 路由族(kind=patrol)——owner 浏览器会话与
// agent 凭证都过 requireOwnAgent,与 CLI `slock patrol` 同一数据源。

interface PatrolJob {
  id: string;
  title: string;
  instructions: string | null;
  repeat: string | null;
  channel: string | null;
  status: string;
  paused: boolean;
  fireCount: number;
  consecutiveSilent: number;
  maxConsecutiveSilent: number;
  lastFiredAt: string | null;
  fireAt: string;
}
interface PatrolEvent {
  event_type: string;
  detail: { outcome?: string; next?: string; consecutiveSilent?: number } | null;
  created_at: string;
}

const props = defineProps<{ agent: { id: string; name: string } }>();
const emit = defineEmits<{ close: [] }>();

const jobs = ref<PatrolJob[]>([]);
const loading = ref(true);
const logFor = ref<string | null>(null);
const events = ref<PatrolEvent[]>([]);

const showCreate = ref(false);
const cTitle = ref("");
const cInstructions = ref("");
const cEvery = ref("");
const cChannel = ref("");

async function load() {
  try {
    const data = await apiGet<{ reminders: PatrolJob[] }>(
      `/internal/agent/${encodeURIComponent(props.agent.id)}/reminders?kind=patrol&status=all`,
    );
    jobs.value = data.reminders || [];
  } catch (err: any) {
    toast.error(err?.message || "加载巡检任务失败");
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function create() {
  if (!cTitle.value.trim() || !cInstructions.value.trim()) return;
  try {
    const body: Record<string, unknown> = {
      title: cTitle.value.trim(),
      instructions: cInstructions.value.trim(),
      kind: "patrol",
    };
    if (cEvery.value.trim()) body.repeat = `every:${cEvery.value.trim()}`;
    if (cChannel.value.trim()) body.channel = cChannel.value.trim();
    await apiPost(`/internal/agent/${encodeURIComponent(props.agent.id)}/reminders`, body);
    showCreate.value = false;
    cTitle.value = cInstructions.value = cEvery.value = cChannel.value = "";
    load();
  } catch (err: any) {
    toast.error(err?.message || "创建失败(周期最小 5m,如 every:30m)");
  }
}

async function act(j: PatrolJob, action: "pause" | "resume") {
  try {
    await apiPost(`/internal/agent/${encodeURIComponent(props.agent.id)}/reminders/${j.id}/${action}`);
    load();
  } catch (err: any) {
    toast.error(err?.message || "操作失败");
  }
}

async function cancel(j: PatrolJob) {
  try {
    await apiClient(`/internal/agent/${encodeURIComponent(props.agent.id)}/reminders/${j.id}`, { method: "DELETE" });
    if (logFor.value === j.id) logFor.value = null;
    load();
  } catch (err: any) {
    toast.error(err?.message || "取消失败");
  }
}

async function toggleLog(j: PatrolJob) {
  if (logFor.value === j.id) {
    logFor.value = null;
    return;
  }
  try {
    const data = await apiGet<{ events: PatrolEvent[] }>(
      `/internal/agent/${encodeURIComponent(props.agent.id)}/reminders/${j.id}/log`,
    );
    events.value = data.events || [];
    logFor.value = j.id;
  } catch (err: any) {
    toast.error(err?.message || "加载日志失败");
  }
}

function fmt(t: string | null) {
  return t ? new Date(t).toLocaleString() : "—";
}
function eventLabel(e: PatrolEvent): { text: string; cls: string } {
  const outcome = e.detail?.outcome;
  if (e.event_type === "fired" && outcome === "posted") return { text: "已报告", cls: "text-green-600" };
  if (e.event_type === "fired" && outcome === "silent") return { text: "沉默", cls: "text-gray-400" };
  if (e.event_type === "auto_paused") return { text: "自动暂停", cls: "text-red-500" };
  if (e.event_type === "paused") return { text: "暂停", cls: "text-yellow-600" };
  if (e.event_type === "resumed") return { text: "恢复", cls: "text-blue-500" };
  return { text: e.event_type, cls: "text-gray-500" };
}
</script>

<template>
  <Card padding="md" class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="font-semibold text-gray-900 dark:text-white">定时巡检 — @{{ agent.name }}</h3>
      <div class="flex gap-2">
        <Button size="sm" @click="showCreate = !showCreate">{{ showCreate ? "收起" : "+ 新建巡检" }}</Button>
        <Button variant="ghost" size="sm" @click="emit('close')">关闭</Button>
      </div>
    </div>

    <div v-if="showCreate" class="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <Input type="text" placeholder="标题(如:告警频道巡检)" :value="cTitle" @input="cTitle = ($event.target as HTMLInputElement).value" />
      <Input
        type="text"
        placeholder="任务指令:检查什么 / 什么情况报告 / 无异常则沉默"
        :value="cInstructions"
        @input="cInstructions = ($event.target as HTMLInputElement).value"
      />
      <div class="flex gap-2">
        <Input type="text" placeholder="周期(如 30m / 2h / 1d,最小 5m)" :value="cEvery" @input="cEvery = ($event.target as HTMLInputElement).value" />
        <Input type="text" placeholder="报告频道(如 #security,可选)" :value="cChannel" @input="cChannel = ($event.target as HTMLInputElement).value" />
      </div>
      <Button size="sm" @click="create">创建</Button>
    </div>

    <div v-if="!loading && jobs.length === 0">
      <EmptyState icon="⏰" title="还没有巡检任务" description="创建后 agent 会按周期自主醒来检查,有异常才报告,无异常保持沉默" />
    </div>

    <div v-for="j in jobs" :key="j.id" class="rounded-md border border-gray-200 p-3 dark:border-gray-700">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium text-gray-900 dark:text-white">{{ j.title }}</span>
        <span v-if="j.status === 'canceled'" class="rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700">已取消</span>
        <span
          v-else-if="j.paused"
          class="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300"
        >
          已暂停{{ j.consecutiveSilent >= j.maxConsecutiveSilent ? "(空转自动暂停)" : "" }}
        </span>
        <span v-else class="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900 dark:text-green-300">运行中</span>
        <span class="text-xs text-gray-400">{{ j.repeat || "一次性" }}<template v-if="j.channel"> → {{ j.channel }}</template></span>
      </div>
      <p class="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">{{ j.instructions }}</p>
      <p class="mt-1 text-xs text-gray-400">
        已触发 {{ j.fireCount }} 次 · 连续沉默 {{ j.consecutiveSilent }}/{{ j.maxConsecutiveSilent }} · 上次 {{ fmt(j.lastFiredAt) }} · 下次 {{ fmt(j.fireAt) }}
      </p>
      <div class="mt-2 flex gap-2" v-if="j.status !== 'canceled'">
        <Button v-if="!j.paused" variant="secondary" size="sm" @click="act(j, 'pause')">暂停</Button>
        <Button v-else variant="secondary" size="sm" @click="act(j, 'resume')">恢复</Button>
        <Button variant="secondary" size="sm" @click="toggleLog(j)">{{ logFor === j.id ? "收起日志" : "日志" }}</Button>
        <Button variant="ghost" size="sm" class="text-red-500 hover:text-red-600" @click="cancel(j)">取消</Button>
      </div>
      <div v-if="logFor === j.id" class="mt-2 space-y-1 border-t border-gray-100 pt-2 dark:border-gray-800">
        <p v-if="events.length === 0" class="text-xs text-gray-400">暂无事件</p>
        <p v-for="(e, i) in events" :key="i" class="text-xs">
          <span class="text-gray-400">{{ fmt(e.created_at) }}</span>
          <span class="ml-2" :class="eventLabel(e).cls">{{ eventLabel(e).text }}</span>
        </p>
      </div>
    </div>
  </Card>
</template>
