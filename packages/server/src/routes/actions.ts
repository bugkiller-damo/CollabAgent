import type { FastifyInstance } from "fastify";
import { canAccessChannel } from "../lib/access.js";
import { resolveChannel } from "../lib/channel.js";
import { resolveTenant } from "../lib/tenant.js";

/**
 * 操作审批卡片（action_cards）。
 *
 * 现状（P0.8，2026-08-30）：全仓零调用方、无读取/裁决端点，属「半成品冻结」状态——
 * 写入口保留但已加固（频道访问校验 + type 白名单 + target 必解析），不新增读/完成端点。
 * 产品化重启时需补：卡片列表读取、approve/reject 裁决端点、WS 通知。
 * type 白名单取自历史设计（agents/slock-backend 分析文档）：channel:create / agent:create。
 */
const ACTION_TYPES = new Set(["channel:create", "agent:create"]);

export async function actionRoutes(app: FastifyInstance) {
  app.post("/prepare", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { target, action } = req.body as { target?: string; action?: { type: string } };
    if (!action?.type) return reply.status(400).send({ error: "action type required" });
    // P0.8：action_type 白名单（原实现任意字符串入库，污染未来裁决端的类型假设）
    if (!ACTION_TYPES.has(action.type)) {
      return reply.status(400).send({ error: "unsupported action type" });
    }
    if (!target) return reply.status(400).send({ error: "target required" });
    // O3：显式租户下频道名解析限定在租户 server 内
    const tenant = await resolveTenant(app, req);
    const ch = await resolveChannel(app, target, "id", tenant.explicit ? tenant.serverId : undefined);
    // P0.8：解析失败必须 404——原实现 ch?.id || null 会撞 channel_id NOT NULL 约束必 500
    if (!ch) return reply.status(404).send({ error: "channel not found" });
    // P0.8：往频道投卡片前必须能访问该频道（原实现无校验，可向任意私有频道写入）
    const accessOpts = {
      serverId: tenant.explicit ? tenant.serverId : undefined,
      enforceServerMembership: tenant.explicit,
    };
    if (!(await canAccessChannel(app, ch.id, req.user.sub, accessOpts))) {
      return reply.status(403).send({ error: "no access to this channel" });
    }
    // action_data 体积兜底（JSONB 入库，防异常大对象）
    const data = JSON.stringify(action);
    if (data.length > 8192) return reply.status(400).send({ error: "action too large" });
    const result = await app.pg.query(
      `INSERT INTO action_cards (channel_id, created_by, target_user, action_type, action_data)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ch.id, req.user.sub, req.user.sub, action.type, data],
    );
    return { cardId: result.rows[0].id };
  });
}
