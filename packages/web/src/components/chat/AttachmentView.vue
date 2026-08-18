<script setup lang="ts">
import { ref } from "vue";
import type { Attachment } from "./types";

const props = defineProps<{
  attachments: Attachment[];
}>();

const lightbox = ref<Attachment | null>(null);

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function isImage(mime: string): boolean {
  return mime?.startsWith("image/");
}
</script>

<template>
  <div v-if="props.attachments && props.attachments.length > 0" class="flex flex-wrap gap-2 mt-1.5">
    <template v-for="a in props.attachments" :key="a.id">
      <img
        v-if="isImage(a.mimeType)"
        :src="a.url"
        :alt="a.filename"
        loading="lazy"
        @click="lightbox = a"
        class="max-h-48 max-w-xs rounded border border-gray-200 dark:border-gray-700 cursor-zoom-in object-cover"
      />
      <a
        v-else
        :href="a.url"
        :download="a.filename"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-2 p-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 max-w-xs"
      >
        <span class="text-2xl shrink-0">📄</span>
        <span class="min-w-0">
          <span class="block text-sm text-gray-800 dark:text-gray-200 truncate">{{ a.filename }}</span>
          <span class="block text-xs text-gray-400">{{ formatSize(a.sizeBytes) }} · 下载</span>
        </span>
      </a>
    </template>

    <div
      v-if="lightbox"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      @click="lightbox = null"
    >
      <img :src="lightbox.url" :alt="lightbox.filename" class="max-h-full max-w-full rounded shadow-lg" />
      <button
        @click="lightbox = null"
        class="absolute top-4 right-4 text-white/80 hover:text-white text-2xl"
      >
        ✕
      </button>
    </div>
  </div>
</template>
