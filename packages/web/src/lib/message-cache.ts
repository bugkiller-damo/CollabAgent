/**
 * 消息缓存 localStorage 口径单点（审计 §4.4 #19）。
 *
 * 口径定稿：明文缓存 = 「切频道/刷新不丢消息」的 UX 权衡——缓存的是本浏览器已对该
 * 账号展示过的消息，信任域 = 浏览器 profile 本地存储（与 httpOnly cookie 会话同域同
 * 浏览器，不新增暴露面）。上限已内置：频道缓存每 target 尾部 50 条（messageStore
 * CACHE_LIMIT 50/频道）、离线队列仅落 queued/failed（sending 落盘归 queued）。
 *
 * 跨账号残留不属权衡内：登出必须清空——否则换账号登录会读到旧账号的消息缓存，且
 * 旧账号的离线草稿会以新账号身份被 flush 发出。SPA 登出不整页刷新，store 单例跨
 * 登录存活，故清盘走回调联动（authStore 不 import messageStore，store 互 import 纪律）：
 * authStore.logout() → clearMessageCaches() → onMessageCachesCleared 注册的回调清
 * messageStore 内存态，防止 in-flight flush 失败经 persistPending 把旧账号草稿重写回
 * localStorage（清了等于没清）。
 */
export const CACHE_PREFIX = "msgs_";
export const PENDING_CACHE_KEY = "pending_msgs_v1";

type ClearedCallback = () => void;
const clearedCallbacks: ClearedCallback[] = [];

/**
 * 登出清盘联动注册点（messageStore 在 store 创建时注册，同步清内存态；
 * 回调异常不阻断清盘与其余回调）。
 */
export function onMessageCachesCleared(cb: ClearedCallback): void {
  clearedCallbacks.push(cb);
}

/** 登出清空消息类 localStorage 缓存并联动清内存态。UI 偏好键（theme/sidebar 等）不在口径内。 */
export function clearMessageCaches(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
    localStorage.removeItem(PENDING_CACHE_KEY);
  } catch {
    // quota exceeded / unavailable — ignore（对齐 messageStore saveCache 风格）
  }
  for (const cb of clearedCallbacks) {
    try {
      cb();
    } catch {
      // 回调异常不阻断清盘
    }
  }
}
