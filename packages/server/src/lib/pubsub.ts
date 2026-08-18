/**
 * 跨实例 WS 广播 pub/sub 层（O1）。
 *
 * 现状：WS 连接态（browserClients / daemonClients / terminalWatchers）是单进程内存 Map，
 * 消息广播不经过 Valkey —— 多实例部署时实例间互相看不见对方连的 socket，进程重启丢连接态。
 *
 * 本模块提供统一的 pub/sub 抽象：
 * - `VALKEY_URL` 配置时：走 Redis pub/sub（ioredis，与 Valkey 协议兼容）；
 * - 未配置时：退化为进程内 EventEmitter（单实例 / 测试环境，行为与旧版一致）。
 *
 * 关键语义：发布者实例「本地直投 + PUBLISH」，远端实例经 SUBSCRIBE 接收后本地直投。
 * Redis pub/sub 不会回环给发布者自身，所以每个实例恰好收到一次，无重复投递。
 *
 * 故障降级：Redis 不可用时发布/订阅均静默失败（本地直投仍然生效），
 * 不会因 Valkey 抖动影响单实例的消息投递；错误只打一次日志，避免刷屏。
 */
import { EventEmitter } from "node:events";

// ESM 下动态加载 ioredis（与 rate-limit.ts 一致）；未配置 VALKEY_URL 时该依赖不会被实例化。
const { default: Redis } = await import("ioredis");

type Handler = (payload: unknown) => void;

export interface PubSub {
  /** 向 channel 投递一条消息：本地订阅者立即收到，远端实例经 Redis 收到。 */
  publish(channel: string, payload: unknown): void;
  /** 订阅 channel。返回取消订阅函数（测试/收尾用）。 */
  subscribe(channel: string, handler: Handler): () => void;
  /** 关闭底层连接。 */
  close(): Promise<void>;
}

// ---------- 进程内回退（单实例 / 无 VALKEY_URL / 测试） ----------
class InProcessPubSub implements PubSub {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(channel: string, payload: unknown): void {
    this.emitter.emit(channel, payload);
  }

  subscribe(channel: string, handler: Handler): () => void {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

// ---------- Redis/Valkey 后端（ioredis） ----------
class RedisPubSub implements PubSub {
  private emitter = new EventEmitter();
  private pub: any;
  private sub: any;
  private channels = new Set<string>();
  private warned = new Set<string>();

  constructor(url: string) {
    const opts = {
      maxRetriesPerRequest: 1,
      // 有界重连：最多 ~4.6s 内退避，之后继续尝试但不指数爆炸
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    };
    this.pub = new Redis(url, opts);
    this.sub = new Redis(url, opts);

    this.pub.on("error", (e: Error) => this.warnOnce("publish", e));
    this.sub.on("error", (e: Error) => this.warnOnce("subscribe", e));

    // 远端消息 → 本地订阅者。JSON 解析失败（脏数据）直接丢弃。
    this.sub.on("message", (channel: string, message: string) => {
      try {
        this.emitter.emit(channel, JSON.parse(message));
      } catch {
        /* ignore malformed payload */
      }
    });

    // 重连后重订阅（ioredis 不保证断线自动恢复订阅状态）
    this.sub.on("connect", () => {
      for (const ch of this.channels) this.sub.subscribe(ch).catch(() => {});
    });
  }

  private warnOnce(kind: "publish" | "subscribe", e: Error): void {
    const key = `${kind}:${e.message}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[PubSub] ${kind} error (suppressed future repeats): ${e.message}`);
  }

  publish(channel: string, payload: unknown): void {
    // 本地直投（发布者自身也订阅了该 channel，因此本实例的 socket 在这里收到）
    this.emitter.emit(channel, payload);
    // 广播给其它实例
    this.pub.publish(channel, JSON.stringify(payload)).catch(() => {});
  }

  subscribe(channel: string, handler: Handler): () => void {
    this.emitter.on(channel, handler);
    this.channels.add(channel);
    this.sub.subscribe(channel).catch(() => {});
    return () => this.emitter.off(channel, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
    try {
      await this.pub.quit();
    } catch {
      /* ignore */
    }
    try {
      await this.sub.quit();
    } catch {
      /* ignore */
    }
  }
}

/** 按配置选择后端。url 为空时回退进程内。 */
export function createPubSub(url: string | null | undefined): PubSub {
  return url ? new RedisPubSub(url) : new InProcessPubSub();
}
