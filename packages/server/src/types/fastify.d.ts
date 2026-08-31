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
    // P1.15：双 namespace——access=浏览器 access token（JWT_SECRET）、refresh=刷新
    // 令牌（独立 REFRESH_SECRET）。声明后 fastify.jwt 类型变为
    // Record<"access" | "refresh", JWT>，运行时即 fastify.jwt.access / .refresh，
    // 取代 jsonwebtoken 直验的双库并存。
    namespaces: "access" | "refresh";
  }
}
