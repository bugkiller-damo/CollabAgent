import type { FastifyInstance } from "fastify";
import { canAccessChannel } from "./access.js";
import { UUID_RE } from "./tenant.js";

/**
 * 2026-09-17 审计 F1（高危）：附件绑定所有权/可访问性校验。
 *
 * 此前 /send（人类与 agent 两侧）对 body.attachmentIds 直接 INSERT
 * message_attachments，不校验发送者与附件的关系——他人私信/私有频道的附件
 * ID 被重新绑进公开频道消息后，读 ACL（上传者或任一挂载频道可访问者）即放行，
 * 私有文件被全站可读化。
 *
 * 规则：发送者须满足其一：
 *   - 是该附件的上传者（uploaderIds：人类=本人；agent=[agentId, 属主 user_id]，
 *     agent 经 /internal/agent/:agentId/upload 上传的行 uploader_id 是 agentId）；
 *   - 附件已挂载的消息频道中存在一个其可访问的（canAccessChannel，按
 *     accessUserId 判定——人类=本人；agent=属主 user_id）。
 * 非 UUID / 不存在的 id / 无权的 id 一律过滤——响应 attachments 列表自然只剩
 * 成功绑定的行，不额外区分错误形态（幂等重放安全）。
 */
export async function filterAuthorizedAttachmentIds(
  app: FastifyInstance,
  accessUserId: string,
  ids: unknown[],
  uploaderIds: string[] = [accessUserId],
): Promise<string[]> {
  const clean = [...new Set(ids.filter((v): v is string => typeof v === "string" && UUID_RE.test(v)))];
  if (clean.length === 0) return [];
  const uploaders = new Set(uploaderIds.map((v) => String(v)));
  const rows = await app.pg.query<{ id: string; uploader_id: string }>(
    "SELECT id::text AS id, uploader_id::text AS uploader_id FROM attachments WHERE id = ANY($1::uuid[])",
    [clean],
  );
  const ok = new Set<string>();
  for (const row of rows.rows) {
    if (uploaders.has(String(row.uploader_id))) {
      ok.add(String(row.id));
      continue;
    }
    // 非上传者：须对附件已挂载的某个频道有访问权（即当前本就读得到它）
    const links = await app.pg.query<{ channel_id: string }>(
      `SELECT m.channel_id FROM message_attachments ma
        JOIN messages m ON m.id = ma.message_id
       WHERE ma.attachment_id = $1`,
      [row.id],
    );
    for (const link of links.rows) {
      if (await canAccessChannel(app, String(link.channel_id), String(accessUserId))) {
        ok.add(String(row.id));
        break;
      }
    }
  }
  return clean.filter((id) => ok.has(id));
}
