<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGet, apiPost } from "../api";
import PageHeader from "../components/layout/PageHeader.vue";
import Button from "../components/ui/Button.vue";
import Input from "../components/ui/Input.vue";
import { useChannelStore } from "../stores";
import { toast } from "../stores/toastStore";

interface Task {
  id: string;
  content: string;
  task_number: number;
  task_status: string;
  task_assignee: string | null;
  assignee_handle: string | null;
  creator_name: string;
}

const COLUMNS: { status: string; label: string; tint: string }[] = [
  { status: "todo", label: "待办", tint: "border-t-gray-400" },
  { status: "in_progress", label: "进行中", tint: "border-t-blue-500" },
  { status: "in_review", label: "审查中", tint: "border-t-amber-500" },
  { status: "done", label: "已完成", tint: "border-t-green-500" },
];

const route = useRoute();
const router = useRouter();
const channelStore = useChannelStore();

const channels = computed(() => channelStore.channels);
const activeChannelName = computed(() => channelStore.activeChannelName);
const channelName = computed(() => {
  const p = route.params.channelName;
  return typeof p === "string" ? p : undefined;
});

const channel = ref("");
const tasks = ref<Task[]>([]);
const loading = ref(false);
const newTitle = ref("");
const dragNum = ref<number | null>(null);
const dragOverCol = ref<string | null>(null);

// 对齐 React useEffect：channelName || activeChannelName || channels[0]?.name 择优选择当前频道
watch(
  [channelName, activeChannelName, channels, channel],
  () => {
    const first = channels.value[0]?.name || "";
    const pick = channelName.value || activeChannelName.value || first || "";
    if (pick && pick !== channel.value) channel.value = pick;
  },
  { immediate: true },
);

function load() {
  if (!channel.value) return;
  loading.value = true;
  apiGet<{ tasks: Task[] }>("/api/tasks", { channel: "#" + channel.value })
    .then((d) => {
      tasks.value = d.tasks || [];
      loading.value = false;
    })
    .catch(() => {
      tasks.value = [];
      loading.value = false;
    });
}

// 对齐 React useEffect(() => { load(); }, [load])
watch(channel, () => load(), { immediate: true });

async function createTask() {
  const t = newTitle.value.trim();
  if (!t || !channel.value) return;
  newTitle.value = "";
  try {
    await apiPost("/api/tasks", { channel: "#" + channel.value, tasks: [{ title: t }] });
    load();
  } catch (err: any) {
    toast.error(err?.message || "创建失败");
  }
}

async function claim(num: number) {
  try {
    await apiPost("/api/tasks/claim", { channel: "#" + channel.value, task_numbers: [num] });
    load();
  } catch (err: any) {
    toast.error(err?.message || "认领失败");
  }
}

async function moveTo(num: number, status: string) {
  try {
    await apiPost("/api/tasks/update-status", { channel: "#" + channel.value, number: num, status });
    load();
  } catch (err: any) {
    toast.error(err?.message || "移动失败");
  }
}

function onDrop(status: string) {
  dragOverCol.value = null;
  if (dragNum.value == null) return;
  const num = dragNum.value;
  const task = tasks.value.find((t) => t.task_number === num);
  dragNum.value = null;
  if (task && task.task_status !== status) moveTo(num, status);
}

function onDragLeave(e: DragEvent) {
  if (e.currentTarget === e.target) dragOverCol.value = null;
}

function onChannelSelect(e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  channel.value = val;
  router.push("/tasks/" + val);
}

function colTasks(status: string) {
  return tasks.value.filter((t) => t.task_status === status);
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader
      title="任务看板"
      :back-to="`/channels/${channel}`"
      :breadcrumb="channel ? [{ label: '#' + channel, to: '/channels/' + channel }, { label: '任务看板' }] : undefined"
    >
      <div class="flex flex-wrap items-center gap-2">
        <select
          :value="channel"
          @change="onChannelSelect"
          class="rounded-md border border-gray-300 bg-gray-100 px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          <option v-for="c in channels" :key="c.id" :value="c.name">#{{ c.name }}</option>
        </select>
        <Input
          :value="newTitle"
          @input="newTitle = ($event.target as HTMLInputElement).value"
          @keydown.enter="createTask"
          placeholder="新建任务标题…"
          class="w-56"
        />
        <Button size="sm" :disabled="!newTitle.trim()" @click="createTask">+ 新建</Button>
      </div>
    </PageHeader>

    <div class="grid flex-1 grid-cols-1 content-start gap-4 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-4">
      <div
        v-for="col in COLUMNS"
        :key="col.status"
        @dragover.prevent="dragOverCol = col.status"
        @dragleave="onDragLeave"
        @drop="onDrop(col.status)"
        :class="[
          'min-w-0 rounded-lg border-t-4 bg-gray-100 p-3 dark:bg-gray-800',
          col.tint,
          dragOverCol === col.status ? 'ring-2 ring-blue-400' : '',
        ]"
      >
        <h3 class="mb-3 flex items-center justify-between font-semibold text-gray-700 dark:text-gray-300">
          {{ col.label }}
          <span class="text-xs text-gray-400">{{ colTasks(col.status).length }}</span>
        </h3>
        <div class="min-h-[40px] space-y-2">
          <div
            v-for="t in colTasks(col.status)"
            :key="t.id"
            draggable="true"
            @dragstart="dragNum = t.task_number"
            @dragend="dragNum = null; dragOverCol = null"
            class="cursor-grab rounded border border-gray-200 bg-white p-2.5 shadow-sm active:cursor-grabbing dark:border-gray-600 dark:bg-gray-700"
          >
            <div class="flex items-start gap-2">
              <span class="shrink-0 text-xs text-gray-400">#{{ t.task_number }}</span>
              <p class="flex-1 text-sm text-gray-800 dark:text-gray-200">{{ t.content }}</p>
            </div>
            <div class="mt-2 flex items-center justify-between">
              <span v-if="t.assignee_handle" class="text-[11px] text-blue-600 dark:text-blue-400">@{{ t.assignee_handle }}</span>
              <button v-else @click="claim(t.task_number)" class="text-[11px] text-gray-500 hover:text-blue-500">认领</button>
              <select
                :value="t.task_status"
                @change="moveTo(t.task_number, ($event.target as HTMLSelectElement).value)"
                class="rounded border border-gray-200 bg-transparent px-1 text-[11px] text-gray-500 dark:border-gray-600 dark:text-gray-400"
              >
                <option v-for="c in COLUMNS" :key="c.status" :value="c.status">{{ c.label }}</option>
                <option value="closed">已关闭</option>
              </select>
            </div>
          </div>
          <p v-if="!loading && colTasks(col.status).length === 0" class="py-2 text-center text-xs text-gray-400">
            拖到此处
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
