// navigator.clipboard 仅在安全上下文（HTTPS / localhost）可用；
// 局域网 IP 走 HTTP 时为 undefined，退回 execCommand 兜底。
export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // native 调用被拒（权限/焦点等）：有 document 就走 execCommand 兜底；
      // 连 document 都没有（非浏览器环境）则原样抛出 native 错误。
      if (typeof document === "undefined") throw err;
    }
  } else if (typeof document === "undefined") {
    throw new Error("clipboard unavailable");
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    ta.remove();
  }
}
