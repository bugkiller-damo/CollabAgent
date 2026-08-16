import { useEffect, useRef, useState } from "react";
import { apiGet } from "../../api/client";
import { PageHeader } from "../../components/layout/PageHeader";

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
    h = Math.floor((sec % 86400) / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  if (d > 0) return `${d}天 ${h}时`;
  if (h > 0) return `${h}时 ${m}分`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}

// 数字滚动动画：从旧值缓动到新值
function useCountUp(target: number, duration = 600): number {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3; // easeOutCubic
      setVal(Math.round(from + (target - from) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);
  return val;
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return <div className="h-8" />;
  const max = Math.max(...data, 1),
    min = Math.min(...data);
  const range = max - min || 1;
  const w = 100,
    h = 32;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${h} ${pts.join(" ")} ${w},${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-8">
      <polygon points={area} fill={color} opacity={0.12} />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function CountUpText({ value, className }: { value: number; className?: string }) {
  const animated = useCountUp(value);
  return <span className={className}>{animated.toLocaleString()}</span>;
}

function MetricCard({
  label,
  value,
  sub,
  history,
  color,
}: {
  label: string;
  value: number;
  sub?: string;
  history?: number[];
  color: string;
}) {
  const animated = useCountUp(value);
  return (
    <div className="relative bg-gray-50 dark:bg-gray-800 rounded-xl p-4 overflow-hidden border border-gray-100 dark:border-gray-700/50">
      <p className="text-gray-500 text-xs">{label}</p>
      <p className="text-gray-900 dark:text-white text-3xl font-bold mt-1 tabular-nums">{animated.toLocaleString()}</p>
      {sub && <p className="text-gray-400 text-xs mt-0.5">{sub}</p>}
      {history && (
        <div className="mt-2 -mx-1">
          <Sparkline data={history} color={color} />
        </div>
      )}
    </div>
  );
}

function MemoryBar({ used, total, rss }: { used: number; total: number; rss: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const animatedUsed = useCountUp(used);
  const barColor = pct > 85 ? "bg-red-500" : pct > 60 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700/50">
      <div className="flex items-baseline justify-between">
        <p className="text-gray-500 text-xs">堆内存使用</p>
        <p className="text-gray-400 text-xs tabular-nums">{pct}%</p>
      </div>
      <p className="text-gray-900 dark:text-white text-2xl font-bold mt-1 tabular-nums">
        {animatedUsed}
        <span className="text-gray-400 text-base font-normal"> / {total} MB</span>
      </p>
      <div className="mt-2 h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div
          className={"h-full rounded-full transition-all duration-700 ease-out " + barColor}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-gray-400 text-xs mt-1.5">RSS 常驻 {rss} MB</p>
    </div>
  );
}

function LivePulse() {
  return (
    <span className="relative flex h-2.5 w-2.5">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
    </span>
  );
}

// 实时跳秒的连接时长
function ConnectedFor({ since }: { since: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular-nums">{fmtDuration(Math.max(0, Math.floor((Date.now() - since) / 1000)))}</span>;
}

export function MetricsDashboard() {
  const [m, setM] = useState<Metrics | null>(null);
  const [err, setErr] = useState("");
  // 客户端累积采样，驱动 sparkline；首次加载从 DB 历史初始化，之后实时追加
  const [hist, setHist] = useState<{ messages: number[]; dm: number[]; errors: number[] }>({
    messages: [],
    dm: [],
    errors: [],
  });

  useEffect(() => {
    let alive = true;

    // 从持久化历史加载初始 sparkline 数据（跨重启趋势）
    apiGet<{ samples: { messages_sent: number; dm_sent: number; errors: number }[] }>("/api/metrics/history?range=1h")
      .then((d) => {
        if (!alive || d.samples.length === 0) return;
        setHist({
          messages: d.samples.map((s) => s.messages_sent).slice(-HISTORY),
          dm: d.samples.map((s) => s.dm_sent).slice(-HISTORY),
          errors: d.samples.map((s) => s.errors).slice(-HISTORY),
        });
      })
      .catch(() => {
        /* 历史数据非关键，静默 */
      });

    const load = () =>
      apiGet<Metrics>("/api/metrics")
        .then((d) => {
          if (!alive) return;
          setM(d);
          setHist((h) => ({
            messages: [...h.messages, d.counters.messagesSent].slice(-HISTORY),
            dm: [...h.dm, d.counters.dmSent].slice(-HISTORY),
            errors: [...h.errors, d.counters.errors].slice(-HISTORY),
          }));
        })
        .catch((e) => alive && setErr(e?.message || "加载失败"));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (err) return <div className="p-6 text-red-400 text-sm">{err}</div>;
  if (!m)
    return (
      <div className="p-6 space-y-3 animate-pulse">
        <div className="h-6 w-32 bg-gray-200 dark:bg-gray-700 rounded" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-28 bg-gray-100 dark:bg-gray-800 rounded-xl" />
          ))}
        </div>
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="运行指标"
        backTo="/admin"
        breadcrumb={[{ label: "管理后台", to: "/admin" }, { label: "运行指标" }]}
      >
        <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
          <LivePulse /> 实时 · 每 {POLL_MS / 1000} 秒刷新
        </div>
      </PageHeader>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        启动于 {new Date(m.startedAt).toLocaleString()} · 已运行 {fmtDuration(m.uptimeSec)}
      </p>

      {/* 实时概览 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="relative bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/30 dark:to-emerald-800/10 rounded-xl p-4 border border-emerald-100 dark:border-emerald-800/40">
          <div className="flex items-center gap-2">
            {m.online.daemons > 0 && <LivePulse />}
            <p className="text-gray-600 dark:text-gray-300 text-xs">在线 Daemon</p>
          </div>
          <CountUpText
            value={m.online.daemons}
            className="text-gray-900 dark:text-white text-3xl font-bold mt-1 tabular-nums block"
          />
        </div>
        <MetricCard
          label="在线 Agent"
          value={m.online.agentsOnline}
          sub={`共 ${m.online.agents} 个注册`}
          color="#3b82f6"
        />
        <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700/50">
          <p className="text-gray-500 text-xs">运行时长</p>
          <p className="text-gray-900 dark:text-white text-2xl font-bold mt-1">{fmtDuration(m.uptimeSec)}</p>
        </div>
        <MemoryBar used={m.memory.heapUsedMb} total={m.memory.heapTotalMb} rss={m.memory.rssMb} />
      </div>

      {/* 累计计数 + 走势 */}
      <div>
        <h3 className="text-gray-500 text-xs font-semibold uppercase mb-2">累计计数（自进程启动）</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="频道消息" value={m.counters.messagesSent} history={hist.messages} color="#3b82f6" />
          <MetricCard label="私信" value={m.counters.dmSent} history={hist.dm} color="#8b5cf6" />
          <MetricCard label="错误" value={m.counters.errors} history={hist.errors} color="#ef4444" />
          <MetricCard label="提醒触发" value={m.counters.remindersFired} color="#f59e0b" />
          <MetricCard label="登录次数" value={m.counters.logins} color="#10b981" />
        </div>
      </div>

      {/* 逐个 daemon 明细 */}
      <div>
        <h3 className="text-gray-500 text-xs font-semibold uppercase mb-2">已连接 Daemon</h3>
        {m.daemons.length === 0 ? (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-xl p-6 text-center text-gray-400 text-sm border border-dashed border-gray-200 dark:border-gray-700">
            暂无 daemon 连接。在「接入 Agent」页按引导启动本机 daemon。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {m.daemons.map((d) => (
              <div
                key={d.hostname + ":" + d.connectedAt}
                className="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700/50 flex items-center gap-3"
              >
                <LivePulse />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-900 dark:text-white text-sm font-medium truncate">💻 {d.hostname}</p>
                  <p className="text-gray-400 text-xs mt-0.5">
                    已连接 <ConnectedFor since={d.connectedAt} /> · v{d.daemonVersion}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1 justify-end">
                  {d.runtimes.map((r) => (
                    <span
                      key={r}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-gray-400 text-xs">
        注：计数器为单进程内存值，进程重启后归零；多实例部署下各进程独立计数。走势图基于本页打开后的采样。
      </p>
    </div>
  );
}
