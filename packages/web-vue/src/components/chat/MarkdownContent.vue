<script setup lang="ts">
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import { computed } from "vue";

const props = defineProps<{
  content: string;
}>();

/**
 * React 版使用 react-markdown + remark-gfm + rehype-highlight，
 * 这里等价替换为 markdown-it（default preset 已含 table / strikethrough）。
 * - html:false  → 源文本里的原始 HTML 一律转义，不做透传（对齐 react-markdown 的默认安全行为）
 * - linkify:true → 自动识别裸链接并转 <a>
 * - highlight     → highlight.js 回调（与 React rehype-highlight 的着色行为一致，主题已由 main.ts 全局引入）
 */
// 与 markdown-it 的 utils.escapeHtml 等价（& < > " 四个字符），独立实现以避免在 md 初始化闭包内自引用
function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          "</code></pre>"
        );
      } catch {
        // 降级到转义输出
      }
    }
    return '<pre class="hljs"><code>' + escapeHtml(str) + "</code></pre>";
  },
});

// a 标签统一新窗口打开（对齐 React components.a 的 target/rel 覆写），并保留其蓝色样式
const defaultLinkOpen: NonNullable<typeof md.renderer.rules.link_open> =
  md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  tokens[idx].attrJoin("class", "text-blue-500 hover:underline");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// markdown-it 输出（含 highlight 注入的原始 HTML）统一过 DOMPurify 后再 v-html 渲染
const rendered = computed(() => DOMPurify.sanitize(md.render(props.content)));
</script>

<template>
  <div class="md-content text-gray-700 dark:text-gray-300 text-sm" v-html="rendered" />
</template>
