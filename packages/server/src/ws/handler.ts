import type { WebSocket } from "ws";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// Anonymous browser clients (keyed by userId)
const browserClients = new Map<string, Set<WebSocket>>();
// Daemon connections (keyed by userId — one per user machine)
export const daemonClients = new Map<string, WebSocket>();

function parseAuthToken(req: any): string | null {
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1] : null;
}

export function wsHandler(connection: WebSocket, req: any) {
  const token = parseAuthToken(req);
  let userId = "anon";

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; handle?: string };
      userId = decoded.sub;
    } catch {
      // Invalid token — treat as anonymous browser client
    }
  }

  // Check if this is a daemon connection (has api key auth)
  const isDaemon = token && token.startsWith("sk_machine_");

  if (isDaemon) {
    daemonClients.set(userId, connection);
    console.log(`[WS] Daemon connected: user=${userId}`);

    connection.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case "ready":
            console.log(`[WS] Daemon ready: runtimes=${msg.runtimes}`);
            break;
          case "agent:status":
            console.log(`[WS] Agent status: ${msg.status}`);
            break;
          case "agent:activity":
            console.log(`[WS] Agent activity: ${msg.activity}`);
            break;
          case "pong":
            break;
        }
      } catch { /* ignore */ }
    });

    connection.on("close", () => {
      daemonClients.delete(userId);
      console.log(`[WS] Daemon disconnected: user=${userId}`);
    });

    connection.send(JSON.stringify({ type: "connected", serverTime: new Date().toISOString() }));
  } else {
    // Browser client
    if (!browserClients.has(userId)) browserClients.set(userId, new Set());
    browserClients.get(userId)!.add(connection);

    connection.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") return;
      } catch { /* ignore */ }
    });

    connection.on("close", () => {
      browserClients.get(userId)?.delete(connection);
    });

    connection.send(JSON.stringify({ type: "connected", time: new Date().toISOString() }));
  }
}

/** Broadcast to all browser clients AND all daemons */
export function broadcast(_channelId: string, event: any) {
  const payload = JSON.stringify(event);
  for (const [, sockets] of browserClients) {
    for (const ws of sockets) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
  for (const [, ws] of daemonClients) {
    try { ws.send(payload); } catch { /* ignore */ }
  }
}

/** Send a message to a specific daemon */
export function sendToDaemon(userId: string, event: any) {
  const daemon = daemonClients.get(userId);
  if (daemon) {
    try { daemon.send(JSON.stringify(event)); } catch { /* ignore */ }
  }
}
