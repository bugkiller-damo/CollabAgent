const BASE = "http://localhost:3001";
const { WebSocket } = await import("ws");
let n = 0;
const uniq = () => `zzp${Date.now().toString(36)}${n++}`;
async function reg() {
  const h = uniq();
  const r = await fetch(BASE + "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${h}@probe.local`, handle: h, password: "Test1234" }),
  });
  const d = await r.json();
  if (!d.user) {
    console.log("REG FAIL", r.status, JSON.stringify(d).slice(0, 300));
    process.exit(1);
  }
  return {
    handle: h,
    userId: d.user.id,
    cookie: r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}
const a = await reg();
const b = await reg();
// B connect
const ws = new WebSocket(BASE.replace("http", "ws") + "/ws", { headers: { Cookie: b.cookie } });
const events = [];
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  events.push([Date.now(), m.type, m.notification?.body || m.message?.content || ""]);
});
await new Promise((res) => ws.on("open", res));
await new Promise((res) => setTimeout(res, 300));
// A sends DM to B (CSRF: extract from cookie like helpers.api)
const csrf = (s) => decodeURIComponent((s.match(/csrf_token=([^;]+)/) || [])[1] || "");
await fetch(BASE + "/api/messages/send", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: a.cookie, "x-csrf-token": csrf(a.cookie) },
  body: JSON.stringify({ target: `dm:@${b.handle}`, content: "probe dm 1" }),
});
await new Promise((res) => setTimeout(res, 800));
console.log("EVENT ORDER:", JSON.stringify(events, null, 1));
// REST list field check
const list = await fetch(BASE + "/api/notifications", { headers: { cookie: b.cookie } }).then((r) => r.json());
console.log("REST notification keys:", Object.keys(list.notifications[0] || {}).join(","));
console.log("REST actor_name:", list.notifications[0]?.actor_name, "| type:", list.notifications[0]?.type);
ws.close();
