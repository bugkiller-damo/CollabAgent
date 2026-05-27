import type { WebSocket } from "ws";

const clients = new Map<string, Set<WebSocket>>();

export function wsHandler(connection: WebSocket, _req: any) {
  const userId = "anon";
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(connection);

  connection.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("WS message:", msg.type);
    } catch { /* ignore malformed frames */ }
  });

  connection.on("close", () => {
    clients.get(userId)?.delete(connection);
  });

  connection.send(JSON.stringify({ type: "connected", time: new Date().toISOString() }));
}

export function broadcast(_channelId: string, event: any) {
  for (const [, sockets] of clients) {
    for (const ws of sockets) {
      try { ws.send(JSON.stringify(event)); } catch { /* ignore */ }
    }
  }
}
