<script setup lang="ts">
import type { PendingItem } from "./types";

defineProps<{
  item: PendingItem;
}>();

const emit = defineEmits<{
  retry: [tempId: string];
  discard: [tempId: string];
}>();
</script>

<template>
  <div class="flex gap-3 p-2 rounded animate-slide-in-up">
    <div class="w-8 h-8 rounded bg-blue-600 shrink-0 flex items-center justify-center text-xs text-white">我</div>
    <div class="min-w-0 flex-1">
      <p
        :class="[
          'text-sm whitespace-pre-wrap',
          item.status === 'failed' ? 'text-gray-500' : 'text-gray-700 dark:text-gray-300',
        ]"
      >
        {{ item.content }}
      </p>
      <div class="text-xs mt-0.5">
        <span v-if="item.status === 'sending'" class="text-gray-400">发送中…</span>
        <span v-else-if="item.status === 'queued'" class="text-amber-500">
          ⏳ 离线，恢复网络后自动发送
          <button @click="emit('discard', item.tempId)" class="ml-2 underline text-gray-400 hover:text-gray-300">删除</button>
        </span>
        <span v-else-if="item.status === 'failed'" class="text-red-500">
          ⚠️ 发送失败
          <button @click="emit('retry', item.tempId)" class="ml-2 underline hover:text-red-400">重试</button>
          <button @click="emit('discard', item.tempId)" class="ml-2 underline text-gray-400 hover:text-gray-300">删除</button>
        </span>
      </div>
    </div>
  </div>
</template>
