// ============================================================
// 告警规则引擎 — 定时评估指标 → 生成告警
// ============================================================

import type { FastifyInstance } from "fastify";

const EVALUATION_INTERVAL_MS = 30_000;

interface MetricSnapshot { name: string; value: number; timestamp: Date }

export class AlertEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFired = new Map<string, number>();

  constructor(private app: FastifyInstance) {}

  start(): void {
    if (this.timer) return;
    console.log("[AlertEngine] started (interval: 30s)");
    this.timer = setInterval(() => void this.evaluate(), EVALUATION_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.lastFired.clear();
  }

  private async evaluate(): Promise<void> {
    try {
      const rules = await this.app.pg.query("SELECT * FROM alert_rules WHERE enabled = true ORDER BY severity DESC");
      if (rules.rows.length === 0) return;
      const metrics = await this.collectMetrics();
      for (const rule of rules.rows as any[]) await this.evaluateRule(rule, metrics);
    } catch (err: any) { console.error("[AlertEngine] error:", err?.message); }
  }

  private async collectMetrics(): Promise<MetricSnapshot[]> {
    const snapshots: MetricSnapshot[] = []; const now = new Date();
    const mem = process.memoryUsage();
    snapshots.push({ name: "memory.heapUsedMb", value: Math.round(mem.heapUsed / 1048576), timestamp: now });
    snapshots.push({ name: "memory.heapTotalMb", value: Math.round(mem.heapTotal / 1048576), timestamp: now });
    snapshots.push({ name: "memory.rssMb", value: Math.round(mem.rss / 1048576), timestamp: now });
    try {
      const r1 = await this.app.pg.query("SELECT count(*)::int as c FROM penetration_tasks WHERE status = 'running'");
      snapshots.push({ name: "tasks.running", value: Number(r1.rows[0]?.c ?? 0), timestamp: now });
      const r2 = await this.app.pg.query("SELECT count(*)::int as c FROM penetration_tasks WHERE status = 'failed' AND completed_at > now() - interval '1 hour'");
      snapshots.push({ name: "tasks.failed_last_hour", value: Number(r2.rows[0]?.c ?? 0), timestamp: now });
      const r3 = await this.app.pg.query("SELECT count(*)::int as c FROM alerts WHERE created_at > now() - interval '5 minutes'");
      snapshots.push({ name: "alerts.recent_5min", value: Number(r3.rows[0]?.c ?? 0), timestamp: now });
    } catch { /* ignore */ }
    return snapshots;
  }

  private async evaluateRule(rule: any, metrics: MetricSnapshot[]): Promise<void> {
    const cond = typeof rule.condition === "string" ? JSON.parse(rule.condition) : rule.condition;
    if (!cond?.operator || cond?.threshold === undefined) return;
    const matched = metrics.filter((m) => m.name === rule.metric);
    if (matched.length === 0) return;
    const value = matched[matched.length - 1].value;
    const triggered = this.compare(value, cond.operator, cond.threshold);
    if (!triggered) return;
    const interval = (rule.notify_interval_min || 30) * 60 * 1000;
    const last = this.lastFired.get(rule.id);
    if (last && Date.now() - last < interval) return;
    this.lastFired.set(rule.id, Date.now());
    try {
      await this.app.pg.query(
        `INSERT INTO alerts (rule_id, subsidiary_id, severity, title, detail, source, status) VALUES ($1,$2,$3,$4,$5,$6,'unacknowledged')`,
        [rule.id, rule.subsidiary_id, rule.severity, `[${rule.severity}] ${rule.name}`, `指标 ${rule.metric}=${value}, 阈值 ${cond.operator} ${cond.threshold}`, "alert-engine"]
      );
      console.log(`[AlertEngine] fired: ${rule.name} (${rule.metric}=${value})`);
    } catch (err: any) { console.error("[AlertEngine] insert failed:", err?.message); }
  }

  private compare(value: number, operator: string, threshold: number): boolean {
    switch (operator) { case ">": return value > threshold; case ">=": return value >= threshold; case "<": return value < threshold; case "<=": return value <= threshold; case "==": return value === threshold; default: return false; }
  }
}
