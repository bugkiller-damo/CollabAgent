import { daemonClients } from "../ws/handler.js";

// 计算「当前有 daemon 在线的组织(server) id 集合」。
// 模型：一台机器一个 daemon，启动时按其令牌用户「可见组织内的全部 agent」接管路由，
// 被 @ 时用自己的机器令牌驱动任意一个。所以 agent 是否在线取决于「它所属组织里是否有成员的 daemon 连着」，
// 而非它的创建者本人是否在线。
export async function onlineOrgIds(
  pg: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }
): Promise<Set<string>> {
  const daemonUserIds = [...daemonClients.keys()];
  if (daemonUserIds.length === 0) return new Set();
  const r = await pg.query(
    "SELECT DISTINCT server_id FROM server_members WHERE user_id::text = ANY($1)",
    [daemonUserIds]
  );
  return new Set((r.rows as any[]).map((x) => String(x.server_id)));
}
