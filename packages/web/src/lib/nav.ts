/**
 * guild 化导航/缓存键工具（纯函数，不依赖 store）。
 *
 * 频道类本地 target key 统一为 "<serverId>:#<name>"——跨 server 同名频道
 * （两边都有 general）在消息缓冲区/未读计数/离线队列里必须消歧；
 * DM target（dm:<uuid>）全局唯一，不加前缀。
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPED_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/is;

/** 频道路由：/s/:serverId/channels/:name */
export function channelPath(serverId: string, channelName: string): string {
  return `/s/${serverId}/channels/${encodeURIComponent(channelName)}`;
}

/** 线程路由：/s/:serverId/channels/:name/:threadId */
export function threadPath(serverId: string, channelName: string, threadId: string): string {
  return `${channelPath(serverId, channelName)}/${encodeURIComponent(threadId)}`;
}

/** 任务看板：/s/:serverId/tasks[/:channelName] */
export function tasksPath(serverId: string, channelName?: string): string {
  return channelName ? `/s/${serverId}/tasks/${encodeURIComponent(channelName)}` : `/s/${serverId}/tasks`;
}

/** 频道 target 的本地 key：<serverId>:#<name>；无 serverId 时退化为 #name */
export function scopedChannelKey(serverId: string | null | undefined, channelName: string): string {
  const name = channelName.startsWith("#") ? channelName : `#${channelName}`;
  return serverId ? `${serverId}:${name}` : name;
}

/** 解析本地 target key → { serverId, name }；dm:/未加前缀的 key 原样返回 name */
export function parseScopedTarget(key: string): { serverId: string | null; name: string } {
  const m = SCOPED_RE.exec(key);
  return m ? { serverId: m[1], name: m[2] } : { serverId: null, name: key };
}

export interface ChannelRouteParts {
  serverId?: string;
  channelName: string;
  threadId?: string;
}

/** 解析新旧频道路径：/s/:sid/channels/:name[/:tid] 与旧 /channels/:name[/:tid] */
export function parseChannelRoute(path: string): ChannelRouteParts | null {
  let m = /^\/s\/([^/]+)\/channels\/([^/]+)(?:\/([^/]+))?/.exec(path);
  if (m) {
    return {
      serverId: decodeURIComponent(m[1]),
      channelName: decodeURIComponent(m[2]),
      threadId: m[3] ? decodeURIComponent(m[3]) : undefined,
    };
  }
  m = /^\/channels\/([^/]+)(?:\/([^/]+))?/.exec(path);
  if (m) {
    return {
      channelName: decodeURIComponent(m[1]),
      threadId: m[2] ? decodeURIComponent(m[2]) : undefined,
    };
  }
  return null;
}

/** 解析任务看板路径：/s/:sid/tasks[/:name] 与旧 /tasks[/:name] */
export function parseTasksRoute(path: string): { serverId?: string; channelName?: string } | null {
  let m = /^\/s\/([^/]+)\/tasks(?:\/([^/]+))?/.exec(path);
  if (m) {
    return {
      serverId: decodeURIComponent(m[1]),
      channelName: m[2] ? decodeURIComponent(m[2]) : undefined,
    };
  }
  m = /^\/tasks(?:\/([^/]+))?/.exec(path);
  if (m) return { channelName: m[1] ? decodeURIComponent(m[1]) : undefined };
  return null;
}

/** 每个 server 记忆的「最后打开频道」localStorage key */
export function lastChannelKey(serverId: string): string {
  return `slock.lastChannel.${serverId}`;
}
