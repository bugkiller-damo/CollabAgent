import "fastify";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    pg: {
      query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    };
    jwt: {
      sign: (payload: Record<string, unknown>) => string;
    };
  }

  interface FastifyRequest {
    file?: () => Promise<{
      filename: string;
      mimetype: string;
      toBuffer: () => Promise<Buffer>;
    }>;
    user?: {
      sub: string;
      handle: string;
    };
  }
}
