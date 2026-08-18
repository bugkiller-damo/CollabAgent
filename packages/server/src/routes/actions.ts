import type { FastifyInstance } from "fastify";
import { resolveChannel } from "../lib/channel.js";
import { resolveTenant } from "../lib/tenant.js";

export async function actionRoutes(app: FastifyInstance) {
  app.post("/prepare", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { target, action } = req.body as { target?: string; action?: { type: string } };
    if (!action?.type) return reply.status(400).send({ error: "action type required" });
    // O3：显式租户下频道名解析限定在租户 server 内
    const tenant = await resolveTenant(app, req);
    const ch = await resolveChannel(app, target || "", "id", tenant.explicit ? tenant.serverId : undefined);
    const result = await app.pg.query(
      `INSERT INTO action_cards (channel_id, created_by, target_user, action_type, action_data)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ch?.id || null, req.user.sub, req.user.sub, action.type, JSON.stringify(action)],
    );
    return { cardId: result.rows[0].id };
  });
}
