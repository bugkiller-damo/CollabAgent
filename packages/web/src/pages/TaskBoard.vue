<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiGet, apiPost } from "../api";
import PageHeader from "../components/layout/PageHeader.vue";
import TaskDetailModal from "../components/task/TaskDetailModal.vue";
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
  sender_id: string;
  sender_type: string;
  created_at: string;
}

const COLUMNS: { status: string; label: string; tint: string }[] = [
  { status: "todo", label: "待办", tint: "border-t-gray-400" },
  { status: "in_progress", label: "进行中", tint: "border-t-blue-500" },
  { status: "in_review", label: "审查中", tint: "border-t-amber-500" },
  { status: "done", label: "已完成", tint: "border-t-green-500" },
];

const STATUS_META: Record<string, { label: string; badge: string }> = {
  todo: { label: "待办", badge: "bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200" },
  in_progress: { label: "进行中", badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300" },
  in_review: { label: "审查中", badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300" },
  done: { label: "已完成", badge: "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-300" },
  closed: { label: "已关闭", badge: "bg-gray-300 text-gray-600 dark:bg-gray-700 dark:text-gray-400" },
};

const VIEW_MODE_KEY = "slock-task-view";

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

// 创建者 / 负责人筛选（空串 = 全部；负责人筛选用 "none" 表示未分配）
const creatorFilter = ref("");
const assigneeFilter = ref("");

// 看板 / 列表视图切换（持久化到 localStorage）
const viewMode = ref<"board" | "list">("board");

// 任务详情抽屉
const selectedTask = ref<Task | null>(null);

const creatorOptions = computed(() => {
  const map = new Map<string, string>();
  for (const t of tasks.value) {
    if (t.sender_id && !map.has(t.sender_id)) map.set(t.sender_id, t.creator_name || "User");
  }
  return [...map.entries()].map(([id, name]) => ({ id, name }));
});

const assigneeOptions = computed(() => {
  const map = new Map<string, string>();
  for (const t of tasks.value) {
    if (t.task_assignee && t.assignee_handle && !map.has(t.task_assignee)) map.set(t.task_assignee, t.assignee_handle);
  }
  return [...map.entries()].map(([id, name]) => ({ id, name }));
});

const filteredTasks = computed(() =>
  tasks.value.filter((t) => {
    if (creatorFilter.value && t.sender_id !== creatorFilter.value) return false;
    if (assigneeFilter.value === "none") {
      if (t.task_assignee) return false;
    } else if (assigneeFilter.value && t.task_assignee !== assigneeFilter.value) {
      return false;
    }
    return true;
  }),
);

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

onMounted(() => {
  const v = localStorage.getItem(VIEW_MODE_KEY);
  if (v === "list" || v === "board") viewMode.value = v;
});

function setViewMode(v: "board" | "list") {
  viewMode.value = v;
  localStorage.setItem(VIEW_MODE_KEY, v);
}

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
  return filteredTasks.value.filter((t) => t.task_status === status);
}

function openTask(t: Task) {
  selectedTask.value = t;
}

function statusLabel(s: string): string {
  return STATUS_META[s]?.label || s;
}

function statusBadge(s: string): string {
  return STATUS_META[s]?.badge || STATUS_META.todo!.badge;
}

function fmtTime(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleDateString();
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
        <!-- 视图切换 -->
        <div class="flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600">
          <button
            type="button"
            :class="[
              'px-2.5 py-1.5 text-xs',
              viewMode === 'board'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600',
            ]"
            @click="setViewMode('board')"
          >
            看板
          </button>
          <button
            type="button"
            :class="[
              'px-2.5 py-1.5 text-xs',
              viewMode === 'list'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600',
            ]"
            @click="setViewMode('list')"
          >
            列表
          </button>
        </div>
        <select
          :value="channel"
          @change="onChannelSelect"
          class="rounded-md border border-gray-300 bg-gray-100 px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          <option v-for="c in channels" :key="c.id" :value="c.name">#{{ c.name }}</option>
        </select>
        <select
          v-model="creatorFilter"
          class="max-w-36 rounded-md border border-gray-300 bg-gray-100 px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          <option value="">创建者：全部</option>
          <option v-for="o in creatorOptions" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
        <select
          v-model="assigneeFilter"
          class="max-w-36 rounded-md border border-gray-300 bg-gray-100 px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          <option value="">负责人：全部</option>
          <option value="none">未分配</option>
          <option v-for="o in assigneeOptions" :key="o.id" :value="o.id">@{{ o.name }}</option>
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

    <!-- 看板视图 -->
    <div
      v-if="viewMode === 'board'"
      class="grid flex-1 grid-cols-1 content-start gap-4 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-4"
    >
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
            @click="openTask(t)"
            class="cursor-grab rounded border border-gray-200 bg-white p-2.5 shadow-sm active:cursor-grabbing hover:border-blue-300 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-blue-500"
          >
            <div class="flex items-start gap-2">
              <span class="shrink-0 text-xs text-gray-400">#{{ t.task_number }}</span>
              <p class="line-clamp-3 flex-1 break-words text-sm text-gray-800 dark:text-gray-200">{{ t.content }}</p>
            </div>
            <div class="mt-2 flex items-center justify-between">
              <span v-if="t.assignee_handle" class="text-[11px] text-blue-600 dark:text-blue-400">@{{ t.assignee_handle }}</span>
              <button v-else @click.stop="claim(t.task_number)" class="text-[11px] text-gray-500 hover:text-blue-500">认领</button>
              <select
                :value="t.task_status"
                @click.stop
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

    <!-- 列表视图 -->
    <div v-else class="flex-1 overflow-y-auto p-4">
      <div class="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
        <div
          class="grid grid-cols-[3.5rem_minmax(0,1fr)_5rem_7rem_7rem_6rem] items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
        >
          <span>#</span>
          <span>标题</span>
          <span>状态</span>
          <span>负责人</span>
          <span>创建人</span>
          <span>创建时间</span>
        </div>
        <div
          v-for="t in filteredTasks"
          :key="t.id"
          @click="openTask(t)"
          class="grid cursor-pointer grid-cols-[3.5rem_minmax(0,1fr)_5rem_7rem_7rem_6rem] items-center gap-2 border-b border-gray-100 px-3 py-2 text-xs last:border-b-0 hover:bg-gray-50 dark:border-gray-700/60 dark:hover:bg-gray-800"
        >
          <span class="text-gray-400">#{{ t.task_number }}</span>
          <span class="truncate text-sm text-gray-800 dark:text-gray-200" :title="t.content">{{ t.content }}</span>
          <span>
            <span :class="['inline-block rounded-full px-2 py-0.5 text-[11px] font-medium', statusBadge(t.task_status)]">
              {{ statusLabel(t.task_status) }}
            </span>
          </span>
          <span v-if="t.assignee_handle" class="truncate text-blue-600 dark:text-blue-400">@{{ t.assignee_handle }}</span>
          <span v-else class="text-gray-400">未分配</span>
          <span class="truncate text-gray-600 dark:text-gray-400">{{ t.creator_name }}</span>
          <span class="text-gray-400">{{ fmtTime(t.created_at) }}</span>
        </div>
        <p v-if="!loading && filteredTasks.length === 0" class="py-8 text-center text-xs text-gray-400">暂无任务</p>
      </div>
    </div>

    <!-- 任务详情弹窗 -->
    <TaskDetailModal
      v-if="selectedTask"
      :task="selectedTask"
      :channel="channel"
      @close="selectedTask = null"
      @changed="load()"
    />
  </div>
</template>
