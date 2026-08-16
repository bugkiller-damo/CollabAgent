<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { apiGet } from "../../api";

interface Preview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const props = defineProps<{
  url: string;
}>();

// 模块级缓存，避免重复抓取同一 URL（对齐 React 版，保留缓存语义）
const cache = new Map<string, Preview | null>();

const data = ref<Preview | null>(cache.get(props.url) ?? null);
const done = ref(cache.has(props.url));

watch(
  () => props.url,
  (url, _prev, onCleanup) => {
    let alive = true;
    onCleanup(() => {
      alive = false;
    });

    if (cache.has(url)) {
      data.value = cache.get(url) ?? null;
      done.value = true;
      return;
    }
    apiGet<Preview>("/api/preview", { url })
      .then((d) => {
        cache.set(url, d);
        if (alive) {
          data.value = d;
          done.value = true;
        }
      })
      .catch(() => {
        cache.set(url, null);
        if (alive) {
          data.value = null;
          done.value = true;
        }
      });
  },
  { immediate: true },
);

const preview = computed<Preview | null>(() => {
  const d = data.value;
  if (!done.value || !d) return null;
  if (!d.title && !d.image && !d.description) return null;
  return d;
});
</script>

<template>
  <a
    v-if="preview"
    :href="preview.url"
    target="_blank"
    rel="noopener noreferrer"
    class="flex gap-3 mt-1.5 max-w-md border border-gray-200 dark:border-gray-700 rounded overflow-hidden hover:bg-gray-50 dark:hover:bg-gray-800"
  >
    <img
      v-if="preview.image"
      :src="preview.image"
      alt=""
      loading="lazy"
      class="w-20 h-20 object-cover shrink-0"
    />
    <div class="min-w-0 py-2 pr-2">
      <div v-if="preview.siteName" class="text-[11px] text-gray-400 truncate">{{ preview.siteName }}</div>
      <div v-if="preview.title" class="text-sm text-gray-800 dark:text-gray-200 font-medium truncate">{{ preview.title }}</div>
      <div v-if="preview.description" class="text-xs text-gray-500 line-clamp-2">{{ preview.description }}</div>
    </div>
  </a>
</template>
