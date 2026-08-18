import "fastify";
import "@fastify/jwt";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    pg: {
      query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
      transaction: <T = unknown>(
        fn: (tx: {
          query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
        }) => Promise<T>,
      ) => Promise<T>;
    };
  }

  interface FastifyRequest {
    file?: () => Promise<{
      filename: string;
      mimetype: string;
      toBuffer: () => Promise<Buffer>;
      file?: { truncated: boolean };
    }>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: { sub: string; handle?: string; sid?: string; display_name?: string; scope?: any };
  }
}
