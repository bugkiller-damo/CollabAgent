<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { apiGet } from "../../api";
import { wsSend } from "../../lib/wsManager";
import { useTerminalStore } from "../../stores/terminalStore";

interface AgentOption {
  name: string;
  display_name?: string;
  isOnline: boolean;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  working: { text: "工作中", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  starting: { text: "启动中", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  idle: { text: "空闲", cls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  offline: { text: "未运行", cls: "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400" },
  stopped: { text: "已停止", cls: "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400" },
};

const props = defineProps<{
  agentName: string;
  onSelectAgent: (name: string) => void;
  onClose: () => void;
}>();

const MIN_W = 300;
const MAX_W = 1000;
const MIN_FS = 10;
const MAX_FS = 20;

const terminalStore = useTerminalStore();
const frame = computed(() => terminalStore.frames[props.agentName]);
const history = computed(() => terminalStore.histories[props.agentName]);

const tab = ref<"live" | "log">("live");
const agents = ref<AgentOption[]>([]);
const livePreRef = ref<HTMLPreElement | null>(null);
const logPreRef = ref<HTMLPreElement | null>(null);

// 面板宽度（可拖拽，localStorage 记忆）
const savedW = Number(localStorage.getItem("terminal_panel_w"));
const width = ref(savedW >= MIN_W && savedW <= MAX_W ? savedW : 420);
// 终端字号（localStorage 记忆）
const savedFs = Number(localStorage.getItem("terminal_panel_fs"));
const fontSize = ref(savedFs >= MIN_FS && savedFs <= MAX_FS ? savedFs : 12);

// 拖拽调宽：按住面板左边缘拖动
let dragState: { startX: number; startW: number } | null = null;
function onDragStart(e: MouseEvent) {
  e.preventDefault();
  dragState = { startX: e.clientX, startW: width.value };
  const onMove = (ev: MouseEvent) => {
    if (!dragState) return;
    // 面板在屏幕右缘：鼠标越往左拖，面板越宽
    const next = dragState.startW + (dragState.startX - ev.clientX);
    width.value = Math.min(MAX_W, Math.max(MIN_W, Math.round(next)));
  };
  const onUp = () => {
    dragState = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    localStorage.setItem("terminal_panel_w", String(width.value));
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function changeFontSize(delta: number) {
  const next = Math.min(MAX_FS, Math.max(MIN_FS, fontSize.value + delta));
  localStorage.setItem("terminal_panel_fs", String(next));
  fontSize.value = next;
}

// 观看/取消观看 + 拉一次历史日志（打开或切换 agent 时）
watch(
  () => props.agentName,
  (name, _old, onCleanup) => {
    wsSend({ type: "terminal:watch", agentName: name });
    wsSend({ type: "terminal:history", agentName: name });
    onCleanup(() => wsSend({ type: "terminal:unwatch", agentName: name }));
  },
  { immediate: true },
);

// 尺寸协商（真改比例）：面板宽度/字号变化时，按可视区算出期望的 cols/rows
// 发给 daemon 实时 resize PTY（Claude Code 收 SIGWINCH 重排画面）。防抖 300ms，
// 拖拽结束时只发最终值，不会在拖动过程中刷一串 resize。
function scheduleResize(): ReturnType<typeof setTimeout> | undefined {
  const el = livePreRef.value;
  if (!el) return undefined;
  return setTimeout(() => {
    const charW = fontSize.value * 0.6; // 等宽字体近似字宽
    const lineH = fontSize.value * 1.5; // 与 pre 的 lineHeight 对齐
    const cols = Math.max(20, Math.floor((el.clientWidth - 24) / charW));
    const rows = Math.max(5, Math.floor((el.clientHeight - 24) / lineH));
    wsSend({ type: "terminal:resize", agentName: props.agentName, cols, rows });
  }, 300);
}

watch([width, fontSize, () => props.agentName], (_v, _o, onCleanup) => {
  const t = scheduleResize();
  if (t !== undefined) onCleanup(() => clearTimeout(t));
});
onMounted(() => {
  scheduleResize();
});

// 面板顶部的 agent 选择器数据
onMounted(() => {
  apiGet<{ agents: AgentOption[] }>("/api/agents")
    .then((d) => {
      agents.value = d.agents || [];
    })
    .catch(() => {});
});

// 新帧/新日志到达时滚到底部
function scrollToBottom() {
  const el = tab.value === "live" ? livePreRef.value : logPreRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}
watch([() => frame.value?.screen, history, tab], scrollToBottom);
onMounted(scrollToBottom);

const includesCurrent = computed(() => agents.value.some((a) => a.name === props.agentName));
const status = computed(() => frame.value?.status || "offline");
const st = computed(() => STATUS_LABEL[status.value] || STATUS_LABEL.offline);
</script>

<template>
  <aside
    :style="{ width: width + 'px' }"
    class="relative flex shrink-0 flex-col border-l border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
  >
    <!-- 拖拽调宽把手（左边缘） -->
    <div
      @mousedown="onDragStart"
      class="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-blue-400/40 active:bg-blue-500/50"
      title="拖拽调整宽度"
    />

    <div class="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
      <select
        :value="agentName"
        @change="onSelectAgent(($event.target as HTMLSelectElement).value)"
        class="min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-100 px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
      >
        <option v-if="!includesCurrent" :value="agentName">@{{ agentName }}</option>
        <option v-for="a in agents" :key="a.name" :value="a.name">
          {{ a.isOnline ? "🟢" : "⚪" }} @{{ a.name }}{{ a.display_name && a.display_name !== a.name ? `（${a.display_name}）` : "" }}
        </option>
      </select>
      <span :class="`shrink-0 rounded px-1.5 py-0.5 text-xs ${st.cls}`">{{ st.text }}</span>
      <button @click="onClose" class="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" aria-label="关闭终端面板">✕</button>
    </div>

    <div class="flex items-center border-b border-gray-200 text-sm dark:border-gray-700">
      <button
        @click="tab = 'live'"
        :class="`flex-1 py-1.5 ${tab === 'live' ? 'border-b-2 border-blue-500 font-medium text-gray-900 dark:text-white' : 'text-gray-500'}`"
      >
        实时画面
      </button>
      <button
        @click="tab = 'log'"
        :class="`flex-1 py-1.5 ${tab === 'log' ? 'border-b-2 border-blue-500 font-medium text-gray-900 dark:text-white' : 'text-gray-500'}`"
      >
        历史日志
      </button>
      <!-- 字号调节 -->
      <div class="flex shrink-0 items-center gap-0.5 px-2">
        <button
          @click="changeFontSize(-1)"
          class="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          title="缩小字号"
        >
          A-
        </button>
        <span class="w-6 text-center text-[11px] text-gray-400">{{ fontSize }}</span>
        <button
          @click="changeFontSize(1)"
          class="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          title="放大字号"
        >
          A+
        </button>
      </div>
    </div>

    <pre
      v-if="tab === 'live'"
      ref="livePreRef"
      :style="{ fontSize: fontSize + 'px', lineHeight: 1.5 }"
      class="flex-1 overflow-auto bg-gray-950 p-3 font-mono text-green-200 whitespace-pre"
    >{{ frame?.screen || "等待终端画面…（agent 未运行时无输出）" }}</pre>
    <div v-else class="flex min-h-0 flex-1 flex-col">
      <pre
        ref="logPreRef"
        :style="{ fontSize: fontSize + 'px', lineHeight: 1.5 }"
        class="flex-1 overflow-auto bg-gray-950 p-3 font-mono text-gray-300 whitespace-pre-wrap"
      >{{ history?.trim() || "暂无历史日志（agent 运行过并结束后会落盘保留）" }}</pre>
      <button
        @click="wsSend({ type: 'terminal:history', agentName })"
        class="border-t border-gray-200 py-1.5 text-xs text-blue-500 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700"
      >
        刷新日志
      </button>
    </div>

    <p class="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-400 dark:border-gray-700">
      <template v-if="tab === 'live'">
        画面每 0.4s 刷新，仅在观看时传输{{ frame?.time ? " · 最近更新 " + new Date(frame.time).toLocaleTimeString("zh-CN") : "" }}
      </template>
      <template v-else>日志在 agent 每次运行结束时落盘，含本次 run 的完整画面</template>
    </p>
  </aside>
</template>
