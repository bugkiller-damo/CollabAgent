import type { FastifyInstance } from "fastify";

export async function actionRoutes(app: FastifyInstance) {
  app.post("/prepare", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { target, action } = req.body as any;
    if (!action?.type) return reply.status(400).send({ error: "action type required" });
    const ch = await app.pg.query("SELECT id FROM channels WHERE name = $1", [target ? target.slice(1) : ""]);
    const result = await app.pg.query(
      `INSERT INTO action_cards (channel_id, created_by, target_user, action_type, action_data)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ch.rows[0]?.id || null, (req as any).user.sub, (req as any).user.sub, action.type, JSON.stringify(action)]
    );
    return { cardId: result.rows[0].id };
  });
}
