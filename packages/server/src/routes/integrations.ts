import type { FastifyInstance } from "fastify";

export async function integrationRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async () => {
    const services = await app.pg.query("SELECT id, service_id, name, provider FROM integrations");
    return { services: services.rows, logins: [] };
  });

  app.post("/login", { preHandler: [app.authenticate] }, async (req) => {
    const { service } = req.body as any;
    const result = await app.pg.query(
      "SELECT * FROM integrations WHERE service_id = $1 OR name = $1", [service]
    );
    if (result.rows.length === 0) return { error: "service not found" };
    return { status: "Agent login ready", service: result.rows[0].name };
  });
}
