/**
 * 全局 WS 发送器：AppLayout 建立连接后注入，任何组件都可以通过 wsSend 发消息
 * （终端观察的 watch/unwatch 等浏览器→server 消息走这里）。
 */
let sender: ((msg: Record<string, unknown>) => void) | null = null;

export function setWsSender(fn: ((msg: Record<string, unknown>) => void) | null): void {
  sender = fn;
}

export function wsSend(msg: Record<string, unknown>): void {
  sender?.(msg);
}
