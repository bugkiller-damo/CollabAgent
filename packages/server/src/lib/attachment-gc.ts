import { createHash } from "node:crypto";
import { config } from "./config.js";
import { getStorage } from "./storage.js";
import { thumbKeyFor } from "./thumbnail.js";

/**
 * F1 附件孤儿 GC（方案：docs/2026-09-16/01-file-upload-refactor-plan.md 批次一）。
 *
 * 背景缺陷：删除消息只删 message_attachments 映射（routes/messages.ts），
 * attachments 行与对象字节永久残留；上传后未随消息发出的附件（用户放弃发送）
 * 同样无人回收。本模块周期清掉这两类孤儿。
 *
 * 孤儿判定：无 message_attachments 引用 且 created_at 早于宽限期（默认 24h）。
 * 宽限期覆盖「上传 → 随消息发出」的正常窗口——附件与消息在同一事务内挂载
 * （routes/messages.ts:269-280），超过 24h 仍未被引用的行不可能是正常在途上传。
 *
 * 删除顺序与 routes/channels.ts 频道删除同一语义：先删行（RETURNING storage_key），
 * 事务外 best-effort 删对象字节。字节删除失败仅告警不重试——极端残留（行没了字节
 * 还在）由运维侧按 storage_key 目录巡检兜底，为重试引入状态表不值得。
 *
 * 多实例安全：并发实例的 DELETE 在 READ COMMITTED 下对同一行串行化，后到的
 * 实例在锁释放后重检 WHERE 条件、行已删则跳过；RETURNING 只返回本实例实际删除的
 * 行，字节删除不会重复执行（storage.remove 本身也幂等）。
 *
 * 可测性：runGcSweep 与定时器解耦，测试直接调 sweep（假 app + 真库）。
 */

/** sweep 依赖的最小 app 形状（FastifyInstance 与测试假 app 都满足）。 */
interface GcApp {
  pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}

export interface GcSweepResult {
  /** 删除的附件行数 */
  rows: number;
  /** 对象字节删除成功数 */
  bytes: number;
  /** 对象字节删除失败数（best-effort，仅告警） */
  bytesFailed: number;
}

/**
 * 删「已无任何 attachments 行引用」的 storage_key 对应对象字节。
 * F10：去重后多行可共享同一 key——行删了不等于字节能删，逐 key 重检引用；
 * F11：缩略图与主对象同生命周期（派生键 <key>.thumb.webp，幂等删除）。
 * GC sweep / 频道删除 / server 删除共用：attachments 行删完之后调用，
 * best-effort——字节删除失败仅告警不重试，磁盘残留由目录巡检兜底。
 */
export async function removeUnreferencedAttachmentKeys(
  app: GcApp,
  keys: string[],
): Promise<{ bytes: number; bytesFailed: number }> {
  let bytes = 0;
  let bytesFailed = 0;
  for (const key of keys) {
    const ref = await app.pg.query("SELECT 1 FROM attachments WHERE storage_key = $1 LIMIT 1", [key]);
    if (ref.rows.length > 0) continue;
    try {
      await getStorage().remove(key);
      await getStorage()
        .remove(thumbKeyFor(key))
        .catch(() => {});
      bytes++;
    } catch (err) {
      bytesFailed++;
      app.log.warn({ err, key }, "[AttachmentGC] storage cleanup failed");
    }
  }
  return { bytes, bytesFailed };
}

/**
 * 单轮清扫：删一批孤儿附件行并 best-effort 清对象字节。
 * graceHours 宽限、batch 限量（防单次长事务/长删除阻塞）。
 */
export async function runGcSweep(
  app: GcApp,
  opts: { graceHours?: number; batch?: number } = {},
): Promise<GcSweepResult> {
  const graceHours = opts.graceHours ?? config.ATTACHMENT_GC_GRACE_HOURS;
  const batch = opts.batch ?? config.ATTACHMENT_GC_BATCH;
  // 先删行再删字节：行是引用事实源，行没了字节删除失败也只是磁盘残留，
  // 不会出现「字节没了行还在」的 404 附件（反向顺序的坑）。
  const removed = await app.pg.query(
    `DELETE FROM attachments
      WHERE id IN (
        SELECT a.id FROM attachments a
         WHERE NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = a.id)
           AND a.created_at < now() - make_interval(hours => $1)
         ORDER BY a.created_at ASC
         LIMIT $2
      )
      RETURNING storage_key`,
    [graceHours, batch],
  );
  const keys = removed.rows.map((r) => String((r as { storage_key: string }).storage_key));
  const { bytes, bytesFailed } = await removeUnreferencedAttachmentKeys(app, keys);
  return { rows: keys.length, bytes, bytesFailed };
}

/**
 * F10 老数据回填：sha256 为 NULL 的行（026 迁移前的存量）读字节算 hash 回写。
 * best-effort：字节缺失/读取失败仅告警跳过（GC sweep 迟早会把孤儿行清掉）；
 * 每 tick 小批量，避免大文件集中读内存。返回本轮回填行数。
 */
export async function backfillSha256(app: GcApp, batch = 20): Promise<number> {
  const rows = await app.pg.query(
    "SELECT id, storage_key FROM attachments WHERE sha256 IS NULL ORDER BY created_at ASC LIMIT $1",
    [batch],
  );
  let done = 0;
  for (const r of rows.rows as { id: string; storage_key: string }[]) {
    try {
      const buf = await getStorage().read(r.storage_key);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      await app.pg.query("UPDATE attachments SET sha256 = $1 WHERE id = $2", [sha256, r.id]);
      done++;
    } catch (err) {
      app.log.warn({ err, id: r.id }, "[AttachmentGC] sha256 backfill failed");
    }
  }
  return done;
}

/**
 * 启动周期 GC：listen 后立即跑一轮（覆盖停机期积压），之后按 intervalMs 周期执行。
 * 返回停止函数（优雅关闭/测试用）。
 */
export function startAttachmentGc(app: GcApp, intervalMs = config.ATTACHMENT_GC_INTERVAL_MS): () => void {
  const tick = async () => {
    try {
      // F10：sweep 前顺带小批量回填老行 sha256（回填后这些行才参与去重匹配）
      const backfilled = await backfillSha256(app);
      if (backfilled > 0) app.log.info(`[AttachmentGC] sha256 backfilled ${backfilled} rows`);
      const r = await runGcSweep(app);
      if (r.rows > 0) {
        const { inc } = await import("./metrics.js");
        inc("attachmentsGcRows", r.rows);
        if (r.bytesFailed > 0) inc("attachmentsGcBytesFailed", r.bytesFailed);
        app.log.info(`[AttachmentGC] swept ${r.rows} orphan rows, ${r.bytes} blobs removed, ${r.bytesFailed} failed`);
      }
    } catch (err) {
      app.log.error({ err: (err as Error).message }, "[AttachmentGC] sweep error");
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
