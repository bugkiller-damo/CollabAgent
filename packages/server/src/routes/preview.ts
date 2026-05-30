import type { FastifyInstance } from "fastify";

// 阻止访问内网/本地地址，降低 SSRF 风险
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "0.0.0.0" || h === "::1") return true;
  return false;
}

function metaContent(html: string, ...names: string[]): string | undefined {
  for (const name of names) {
    // 兼容 property= 和 name=，属性顺序任意
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i"
    );
    const tag = html.match(re)?.[0];
    if (tag) {
      const c = tag.match(/content=["']([^"']*)["']/i)?.[1];
      if (c) return decodeEntities(c);
    }
  }
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

export async function previewRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { url } = req.query as Record<string, string>;
    if (!url) return reply.status(400).send({ error: "url required" });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reply.status(400).send({ error: "invalid url" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return reply.status(400).send({ error: "unsupported protocol" });
    }
    if (isBlockedHost(parsed.hostname)) {
      return reply.status(400).send({ error: "blocked host" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(parsed.toString(), {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "CollabAgent-LinkPreview/1.0" },
      });
      const ct = res.headers.get("content-type") || "";
      // 图片直链：直接当作图片预览
      if (ct.startsWith("image/")) {
        return { url: parsed.toString(), image: parsed.toString(), title: parsed.hostname };
      }
      if (!ct.includes("text/html")) {
        return { url: parsed.toString(), title: parsed.hostname };
      }
      // 仅读取前 256KB，避免大页面
      const buf = await res.arrayBuffer();
      const html = Buffer.from(buf.slice(0, 256 * 1024)).toString("utf8");
      const title =
        metaContent(html, "og:title", "twitter:title") ||
        decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "") ||
        parsed.hostname;
      const description = metaContent(html, "og:description", "twitter:description", "description");
      let image = metaContent(html, "og:image", "twitter:image");
      if (image && image.startsWith("/")) image = parsed.origin + image;
      const siteName = metaContent(html, "og:site_name") || parsed.hostname;
      return { url: parsed.toString(), title, description, image, siteName };
    } catch {
      return reply.status(502).send({ error: "failed to fetch preview" });
    } finally {
      clearTimeout(timer);
    }
  });
}
