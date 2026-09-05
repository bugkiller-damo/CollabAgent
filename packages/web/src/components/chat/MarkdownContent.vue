<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../../lib/markdown";

const props = defineProps<{
  content: string;
}>();

// 渲染安全链（markdown-it html:false + DOMPurify + hljs）抽至 lib/markdown.ts，
// 供 node 测试直测 XSS 回归网（#18）；组件只保留 props → 渲染的薄壳
const rendered = computed(() => renderMarkdown(props.content));
</script>

<template>
  <div class="md-content text-gray-700 dark:text-gray-300 text-sm" v-html="rendered" />
</template>