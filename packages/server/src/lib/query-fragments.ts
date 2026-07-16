/**
 * 可复用的 SQL 子查询片段（JSON 聚合），消除重复的 reactions / attachments correlated subqueries。
 *
 * 外层表别名为 m（FROM messages m），直接拼入 SELECT 列：
 *   SELECT m.id, ${reactionsJson()} FROM messages m
 */
export function reactionsJson(): string {
  return `(SELECT COALESCE(json_agg(json_build_object('emoji', emoji, 'userIds', user_ids)), '[]'::json)
            FROM (SELECT mr.emoji, array_agg(mr.user_id::text) as user_ids
                    FROM message_reactions mr WHERE mr.message_id = m.id GROUP BY mr.emoji) r) as reactions`;
}

export function attachmentsJson(): string {
  return `(SELECT COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mimeType', a.mime_type, 'sizeBytes', a.size_bytes, 'url', a.storage_url)), '[]')
            FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id
             WHERE ma.message_id = m.id) as attachments`;
}
