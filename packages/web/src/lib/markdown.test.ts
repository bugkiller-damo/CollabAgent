import { beforeEach, describe, expect, it, vi } from "vitest";

// DOMPurify 在 node 无 DOM → isSupported=false，sanitize 对输入恒等返回（库自身行为不经测，
// 库是久经考验的第三方）。这里 mock 为记录式透传：既保住 markdown-it 转义断言的输出形状，
// 又能断言「输出恒过 sanitize」的链路接线（有人删掉 sanitize 调用即红）。
vi.mock("dompurify", () => ({
  default: { sanitize: vi.fn((html: string) => html) },
}));

import DOMPurify from "dompurify";
import { renderMarkdown } from "./markdown";

const sanitizeMock = vi.mocked(DOMPurify.sanitize);

beforeEach(() => {
  sanitizeMock.mockClear();
});

// 审计 §2.2 安全链四环：html:false 转义 + escapeHtml 降级 + 链接 rel 强制 + DOMPurify 收口
describe("markdown 安全链（#18 XSS 回归网）", () => {
  it("html:false：裸 <script> 一律转义为文本，不透传执行", () => {
    const out = renderMarkdown("before <script>alert(1)</script> after");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("alert(1)"); // 内容以文本形态保留（转义而非删除）
  });

  it("<img onerror> 载荷转义为文本", () => {
    const out = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("javascript: 协议链接被 markdown-it 拒绝（无 href 透出）", () => {
    const out = renderMarkdown("[点我](javascript:alert(1))");
    expect(out).not.toContain('href="javascript:');
    expect(out).not.toContain("<a ");
  });

  it("显式与 linkify 裸链接统一注入 target=_blank + rel=noopener noreferrer", () => {
    const explicit = renderMarkdown("[示例](https://example.com/a)");
    const bare = renderMarkdown("看这个 https://example.com");
    for (const out of [explicit, bare]) {
      expect(out).toContain('target="_blank"');
      expect(out).toContain('rel="noopener noreferrer"');
    }
    expect(explicit).toContain('href="https://example.com/a"');
    expect(bare).toContain('href="https://example.com"'); // linkify 保持原文（无尾斜杠规范化）
  });

  it("已知语言代码块走 hljs 着色（pre.hljs 包裹 + token span）", () => {
    const out = renderMarkdown("```js\nconst x = 1;\n```");
    expect(out).toContain('<pre class="hljs"><code>');
    expect(out).toContain("hljs-keyword"); // const 关键字被 token 化
  });

  it("未知语言代码块走 escapeHtml 降级：内容转义不丢失（#17 拆包后的降级路径契约）", () => {
    const out = renderMarkdown("```notalang\n<b>raw</b>\n```");
    expect(out).toContain('<pre class="hljs"><code>');
    expect(out).not.toContain("<b>raw</b>");
    expect(out).toContain("&lt;b&gt;raw&lt;/b&gt;");
  });

  it("输出恒经 DOMPurify.sanitize（链路接线断言：断链即红）", () => {
    const out = renderMarkdown("hello **world**");
    expect(sanitizeMock).toHaveBeenCalledTimes(1);
    expect(sanitizeMock).toHaveBeenCalledWith(expect.stringContaining("<strong>world</strong>"));
    expect(out).toContain("<p>hello <strong>world</strong></p>"); // 透传 mock 下输出 = md.render 原文
  });
});
