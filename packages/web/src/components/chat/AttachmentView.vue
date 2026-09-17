<script setup lang="ts">
import { FileText, Music, X } from "@lucide/vue";
import { ref, watch } from "vue";
import { previewKind, textPreviewable } from "../../lib/attachment-preview";
import type { Attachment } from "./types";

const props = defineProps<{
  attachments: Attachment[];
}>();

const lightbox = ref<Attachment | null>(null);
const textPreview = ref("");
const textLoading = ref(false);
const textError = ref("");

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/**
 * F7：附件 url 已是 /api/attachments/<id>（ACL 端点，默认 Content-Disposition: attachment
 * 强制下载）——<img>/<video>/<audio>/PDF iframe 直显需要 ?inline=1（server 侧对安全
 * MIME 放行 inline，F14 扩到音视频/PDF/文本）。下载链接保持裸 url（强制下载 + 带文件名
 * 正是想要的行为）。
 * F11：列表优先用 thumbnailUrl（server 生成的 ≤400px webp，inline 直出，省带宽/弱网友好）；
 * 无缩略图（非图片/F11 前存量/生成失败降级）回落原图 inline；lightbox 始终用原图。
 */
function inlineUrl(url: string): string {
  return url + (url.includes("?") ? "&" : "?") + "inline=1";
}

function listUrl(a: Attachment): string {
  return a.thumbnailUrl || inlineUrl(a.url);
}

/**
 * F14 文本预览：打开 text 类附件的 lightbox 时经 cookie fetch 读字节渲染代码块
 * （≤256KB，textPreviewable 已闸）。GET 不需要 CSRF；用 id 比对防快速开关的乱序回包。
 */
watch(lightbox, async (a) => {
  textPreview.value = "";
  textError.value = "";
  if (!a || previewKind(a.mimeType) !== "text") return;
  textLoading.value = true;
  try {
    const res = await fetch(a.url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (lightbox.value?.id === a.id) textPreview.value = body;
  } catch (e) {
    if (lightbox.value?.id === a.id) textError.value = e instanceof Error ? e.message : String(e);
  } finally {
    textLoading.value = false;
  }
});
</script>

<template>
  <div v-if="props.attachments && props.attachments.length > 0" class="flex flex-wrap gap-2 mt-1.5">
    <template v-for="a in props.attachments" :key="a.id">
      <!-- 图片：缩略图直显 + lightbox 看原图 -->
      <img
        v-if="previewKind(a.mimeType) === 'image'"
        :src="listUrl(a)"
        :alt="a.filename"
        loading="lazy"
        @click="lightbox = a"
        class="max-h-48 max-w-xs rounded border border-line cursor-zoom-in object-cover"
      />
      <!-- F14 视频：原生播放器（F9 Range 就绪，进度条拖动/续播可用） -->
      <video
        v-else-if="previewKind(a.mimeType) === 'video'"
        :src="inlineUrl(a.url)"
        controls
        preload="metadata"
        class="max-h-48 max-w-xs rounded border border-line bg-black"
      ></video>
      <!-- F14 音频：文件卡 + 原生播放条 -->
      <div
        v-else-if="previewKind(a.mimeType) === 'audio'"
        class="flex items-center gap-2 p-2 rounded-lg border border-line bg-gray-50 dark:bg-gray-800 max-w-xs"
      >
        <Music class="h-6 w-6 shrink-0 text-gray-500" />
        <span class="min-w-0">
          <span class="block text-sm text-gray-800 dark:text-gray-200 truncate">{{ a.filename }}</span>
          <audio controls :src="inlineUrl(a.url)" class="mt-1 h-8 w-48"></audio>
        </span>
      </div>
      <!-- F14 PDF/可预览文本：卡内「预览」（lightbox）+「下载」并列 -->
      <div
        v-else-if="previewKind(a.mimeType) === 'pdf' || textPreviewable(a.mimeType, a.sizeBytes)"
        class="flex items-center gap-2 p-2 rounded-lg border border-line bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 max-w-xs"
      >
        <FileText class="h-6 w-6 shrink-0" />
        <span class="min-w-0">
          <span class="block text-sm text-gray-800 dark:text-gray-200 truncate">{{ a.filename }}</span>
          <span class="block text-xs text-muted">
            {{ formatSize(a.sizeBytes) }} ·
            <button class="underline hover:text-gray-700 dark:hover:text-gray-300" @click="lightbox = a">预览</button>
            ·
            <a :href="a.url" :download="a.filename" class="underline hover:text-gray-700 dark:hover:text-gray-300">下载</a>
          </span>
        </span>
      </div>
      <!-- 其余：纯下载卡 -->
      <a
        v-else
        :href="a.url"
        :download="a.filename"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-2 p-2 rounded-lg border border-line bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 max-w-xs"
      >
        <FileText class="h-6 w-6 shrink-0" />
        <span class="min-w-0">
          <span class="block text-sm text-gray-800 dark:text-gray-200 truncate">{{ a.filename }}</span>
          <span class="block text-xs text-muted">{{ formatSize(a.sizeBytes) }} · 下载</span>
        </span>
      </a>
    </template>

    <!-- F14：lightbox 扩容——图片 / PDF（浏览器内建阅读器）/ 文本代码块 -->
    <div
      v-if="lightbox"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      @click.self="lightbox = null"
    >
      <img
        v-if="previewKind(lightbox.mimeType) === 'image'"
        :src="inlineUrl(lightbox.url)"
        :alt="lightbox.filename"
        class="max-h-full max-w-full rounded shadow-lg"
      />
      <iframe
        v-else-if="previewKind(lightbox.mimeType) === 'pdf'"
        :src="inlineUrl(lightbox.url)"
        :title="lightbox.filename"
        class="h-[85vh] w-full max-w-4xl rounded bg-white shadow-lg"
      ></iframe>
      <pre
        v-else-if="previewKind(lightbox.mimeType) === 'text'"
        class="max-h-[85vh] w-full max-w-3xl overflow-auto rounded bg-gray-900 p-4 text-xs leading-5 text-gray-100 shadow-lg whitespace-pre-wrap break-all"
      >{{ textLoading ? "加载中…" : textError ? "加载失败：" + textError : textPreview }}</pre>

      <button
        class="absolute top-4 right-4 text-white/80 hover:text-white"
        aria-label="关闭预览"
        @click="lightbox = null"
      >
        <X class="h-5 w-5" />
      </button>
    </div>
  </div>
</template>
