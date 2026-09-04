<script setup lang="ts">
import { defineComponent, h, onMounted, onUnmounted, type PropType, type Ref, ref, watch } from "vue";
import { apiGet } from "../../api";
import PageHeader from "../../components/layout/PageHeader.vue";

interface DaemonInfo {
  hostname: string;
  daemonVersion: string;
  runtimes: string[];
  connectedAt: number;
}
interface Metrics {
  uptimeSec: number;
  startedAt: string;
  counters: { messagesSent: number; dmSent: number; remindersFired: number; errors: number; logins: number };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  online: { daemons: number; agents: number; agentsOnline: number };
  daemons: DaemonInfo[];
}

const POLL_MS = 3000;
const HISTORY = 30; // sparkline 保留最近 30 个采样点

function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400),
    hh = Math.floor((sec % 86400) / 3600),
    mm = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  if (d > 0) return `${d}天 ${hh}时`;
  if (hh > 0) return `${hh}时 ${mm}分`;
  if (mm > 0) return `${mm}分 ${s}秒`;
  return `${s}秒`;
}

// 数字滚动动画：从旧值缓动到新值（对齐 React 版 useCountUp，useEffect([target]) → watch(targetFn)）
function useCountUp(targetFn: () => number, duration = 600): Ref<number> {
  const val = ref(targetFn());
  let from = targetFn();
  let rafId: number | undefined;
  watch(targetFn, (target) => {
    if (from === target) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3; // easeOutCubic
      val.value = Math.round(from + (target - from) * eased);
      if (t < 1) rafId = requestAnimationFrame(tick);
      else from = target;
    };
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  });
  onUnmounted(() => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
  });
  return val;
}

const Sparkline = defineComponent({
  name: "Sparkline",
  props: {
    data: { type: Array as PropType<number[]>, required: true },
    color: { type: String, required: true },
  },
  setup(props) {
    return () => {
      const { data, color } = props;
      if (data.length < 2) return h("div", { class: "h-8" });
      const max = Math.max(...data, 1),
        min = Math.min(...data);
      const range = max - min || 1;
      const w = 100,
        hh = 32;
      const pts = data.map((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = hh - ((v - min) / range) * (hh - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      const area = `0,${hh} ${pts.join(" ")} ${w},${hh}`;
      return h("svg", { viewBox: `0 0 ${w} ${hh}`, preserveAspectRatio: "none", class: "w-full h-8" }, [
        h("polygon", { points: area, fill: color, opacity: 0.12 }),
        h("polyline", {
          points: pts.join(" "),
          fill: "none",
          stroke: color,
          "stroke-width": 1.5,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
          "vector-effect": "non-scaling-stroke",
        }),
      ]);
    };
  },
});

const CountUpText = defineComponent({
  name: "CountUpText",
  props: {
    value: { type: Number, required: true },
    className: { type: String, default: undefined },
  },
  setup(props) {
    const animated = useCountUp(() => props.value);
    return () => h("span", { class: props.className }, animated.value.toLocaleString());
  },
});

const MetricCard = defineComponent({
  name: "MetricCard",
  props: {
    label: { type: String, required: true },
    value: { type: Number, required: true },
    sub: { type: String, default: undefined },
    history: { type: Array as PropType<number[]>, default: undefined },
    color: { type: String, required: true },
  },
  setup(props) {
    const animated = useCountUp(() => props.value);
    return () =>
      h(
        "div",
        {
          class:
            "relative bg-gray-50 dark:bg-gray-800 rounded-xl p-4 overflow-hidden border border-gray-100 dark:border-gray-700/50",
        },
        [
          h("p", { class: "text-gray-500 text-xs" }, props.label),
          h("p", { class: "text-ink text-3xl font-bold mt-1 tabular-nums" }, animated.value.toLocaleString()),
          props.sub ? h("p", { class: "text-gray-400 text-xs mt-0.5" }, props.sub) : null,
          props.history
            ? h("div", { class: "mt-2 -mx-1" }, [h(Sparkline, { data: props.history, color: props.color })])
            : null,
        ],
      );
  },
});

const MemoryBar = defineComponent({
  name: "MemoryBar",
  props: {
    used: { type: Number, required: true },
    total: { type: Number, required: true },
    rss: { type: Number, required: true },
  },
  setup(props) {
    const animatedUsed = useCountUp(() => props.used);
    return () => {
      const pct = props.total > 0 ? Math.min(100, Math.round((props.used / props.total) * 100)) : 0;
      const barColor = pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500";
      return h(
        "div",
        { class: "bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700/50" },
        [
          h("div", { class: "flex items-baseline justify-between" }, [
            h("p", { class: "text-gray-500 text-xs" }, "堆内存使用"),
            h("p", { class: "text-gray-400 text-xs tabular-nums" }, `${pct}%`),
          ]),
          h("p", { class: "text-ink text-2xl font-bold mt-1 tabular-nums" }, [
            String(animatedUsed.value),
            h("span", { class: "text-gray-400 text-base font-normal" }, ` / ${props.total} MB`),
          ]),
          h("div", { class: "mt-2 h-2 rounded-full bg-raised overflow-hidden" }, [
            h("div", {
              class: `h-full rounded-full transition-all duration-700 ease-out ${barColor}`,
              style: { width: `${pct}%` },
            }),
          ]),
          h("p", { class: "text-gray-400 text-xs mt-1.5" }, `RSS 常驻 ${props.rss} MB`),
        ],
      );
    };
  },
});

const LivePulse = defineComponent({
  name: "LivePulse",
  setup() {
    return () =>
      h("span", { class: "relative flex h-2.5 w-2.5" }, [
        h("span", { class: "animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" }),
        h("span", { class: "relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" }),
      ]);
  },
});

// 实时跳秒的连接时长
const ConnectedFor = defineComponent({
  name: "ConnectedFor",
  props: { since: { type: Number, required: true } },
  setup(props) {
    const tick = ref(0);
    let timer: ReturnType<typeof setInterval> | undefined;
    onMounted(() => {
      timer = setInterval(() => {
        tick.value += 1;
      }, 1000);
    });
    onUnmounted(() => {
      if (timer) clearInterval(timer);
    });
    return () => {
      void tick.value; // 每秒触发重渲染
      return h(
        "span",
        { class: "tabular-nums" },
        fmtDuration(Math.max(0, Math.floor((Date.now() - props.since) / 1000))),
      );
    };
  },
});

const m = ref<Metrics | null>(null);
const err = ref("");
// 客户端累积采样，驱动 sparkline；首次加载从 DB 历史初始化，之后实时追加
const hist = ref<{ messages: number[]; dm: number[]; errors: number[] }>({ messages: [], dm: [], errors: [] });

let alive = true;
let pollTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  // 从持久化历史加载初始 sparkline 数据（跨重启趋势）
  apiGet<{ samples: { messages_sent: number; dm_sent: number; errors: number }[] }>("/api/metrics/history?range=1h")
    .then((d) => {
      if (!alive || d.samples.length === 0) return;
      hist.value = {
        messages: d.samples.map((s) => s.messages_sent).slice(-HISTORY),
        dm: d.samples.map((s) => s.dm_sent).slice(-HISTORY),
        errors: d.samples.map((s) => s.errors).slice(-HISTORY),
      };
    })
    .catch(() => {
      /* 历史数据非关键，静默 */
    });

  const load = () =>
    apiGet<Metrics>("/api/metrics")
      .then((d) => {
        if (!alive) return;
        err.value = ""; // 瞬断恢复后清除错误态
        m.value = d;
        hist.value = {
          messages: [...hist.value.messages, d.counters.messagesSent].slice(-HISTORY),
          dm: [...hist.value.dm, d.counters.dmSent].slice(-HISTORY),
          errors: [...hist.value.errors, d.counters.errors].slice(-HISTORY),
        };
      })
      .catch((e) => {
        if (!alive) return;
        err.value = e?.message || "加载失败";
        // W-A4：403（admin 门禁）停轮询——不再每 3s 重试同一失效请求；瞬断仍续试
        if ((e as any)?.status === 403 && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = undefined;
        }
      });

  load();
  pollTimer = setInterval(load, POLL_MS);
});

onUnmounted(() => {
  alive = false;
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div v-if="err" class="p-6 text-red-400 text-sm">{{ err }}</div>

  <div v-else-if="!m" class="p-6 space-y-3 animate-pulse">
    <div class="h-6 w-32 bg-raised rounded" />
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div v-for="i in 4" :key="i" class="h-28 bg-gray-100 dark:bg-gray-800 rounded-xl" />
    </div>
  </div>

  <div v-else class="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
    <PageHeader title="运行指标" back-to="/admin" :breadcrumb="[{ label: '管理后台', to: '/admin' }, { label: '运行指标' }]">
      <div class="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
        <LivePulse /> 实时 · 每 {{ POLL_MS / 1000 }} 秒刷新
      </div>
    </PageHeader>

    <p class="text-xs text-muted">
      启动于 {{ new Date(m.startedAt).toLocaleString() }} · 已运行 {{ fmtDuration(m.uptimeSec) }}
    </p>

    <!-- 实时概览 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="relative bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/30 dark:to-emerald-800/10 rounded-xl p-4 border border-emerald-100 dark:border-emerald-800/40">
        <div class="flex items-center gap-2">
          <LivePulse v-if="m.online.daemons > 0" />
          <p class="text-gray-600 dark:text-gray-300 text-xs">在线 Daemon</p>
        </div>
        <CountUpText :value="m.online.daemons" class="text-ink text-3xl font-bold mt-1 tabular-nums block" />
      </div>
      <MetricCard label="在线 Agent" :value="m.online.agentsOnline" :sub="`共 ${m.online.agents} 个注册`" color="#3b82f6" />
      <div class="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700/50">
        <p class="text-gray-500 text-xs">运行时长</p>
        <p class="text-ink text-2xl font-bold mt-1">{{ fmtDuration(m.uptimeSec) }}</p>
      </div>
      <MemoryBar :used="m.memory.heapUsedMb" :total="m.memory.heapTotalMb" :rss="m.memory.rssMb" />
    </div>

    <!-- 累计计数 + 走势 -->
    <div>
      <h3 class="text-gray-500 text-xs font-semibold uppercase mb-2">累计计数（自进程启动）</h3>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        <MetricCard label="频道消息" :value="m.counters.messagesSent" :history="hist.messages" color="#3b82f6" />
        <MetricCard label="私信" :value="m.counters.dmSent" :history="hist.dm" color="#8b5cf6" />
        <MetricCard label="错误" :value="m.counters.errors" :history="hist.errors" color="#ef4444" />
        <MetricCard label="提醒触发" :value="m.counters.remindersFired" color="#f59e0b" />
        <MetricCard label="登录次数" :value="m.counters.logins" color="#10b981" />
      </div>
    </div>

    <!-- 逐个 daemon 明细 -->
    <div>
      <h3 class="text-gray-500 text-xs font-semibold uppercase mb-2">已连接 Daemon</h3>
      <div v-if="m.daemons.length === 0" class="bg-gray-50 dark:bg-gray-800 rounded-xl p-6 text-center text-gray-400 text-sm border border-dashed border-line">
        暂无 daemon 连接。在「计算机」页按引导启动本机连接器。
      </div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div v-for="(d, i) in m.daemons" :key="d.hostname + i" class="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700/50 flex items-center gap-3">
          <LivePulse />
          <div class="flex-1 min-w-0">
            <p class="text-ink text-sm font-medium truncate">💻 {{ d.hostname }}</p>
            <p class="text-gray-400 text-xs mt-0.5">已连接 <ConnectedFor :since="d.connectedAt" /> · v{{ d.daemonVersion }}</p>
          </div>
          <div class="flex flex-wrap gap-1 justify-end">
            <span v-for="r in d.runtimes" :key="r" class="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">{{ r }}</span>
          </div>
        </div>
      </div>
    </div>

    <p class="text-gray-400 text-xs">注：计数器为单进程内存值，进程重启后归零；多实例部署下各进程独立计数。走势图基于本页打开后的采样。</p>
  </div>
</template>
