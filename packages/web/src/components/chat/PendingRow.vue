<script setup lang="ts">
import { Hourglass, Paperclip, TriangleAlert } from "@lucide/vue";
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
        v-if="item.content"
        :class="[
          'text-sm whitespace-pre-wrap',
          item.status === 'failed' ? 'text-gray-500' : 'text-gray-700 dark:text-gray-300',
        ]"
      >
        {{ item.content }}
      </p>
      <!-- F5：附件随消息进离线队列——pending 只存已上传的 id（文件名不落盘），占位行给计数 -->
      <p
        v-if="item.attachmentIds && item.attachmentIds.length > 0"
        class="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400"
      >
        <Paperclip class="h-3.5 w-3.5" aria-hidden="true" /> {{ item.attachmentIds.length }} 个附件
      </p>
      <div class="text-xs mt-0.5">
        <span v-if="item.status === 'sending'" class="text-muted">发送中…</span>
        <span v-else-if="item.status === 'queued'" class="text-amber-500">
          <Hourglass class="mr-0.5 inline h-3.5 w-3.5" aria-hidden="true" /> 离线，恢复网络后自动发送
          <button @click="emit('discard', item.tempId)" class="ml-2 underline text-muted hover:text-gray-300">删除</button>
        </span>
        <span v-else-if="item.status === 'failed'" class="text-red-500">
          <TriangleAlert class="mr-0.5 inline h-3.5 w-3.5" aria-hidden="true" /> 发送失败<template v-if="item.failReason">：{{ item.failReason }}</template>
          <button @click="emit('retry', item.tempId)" class="ml-2 underline hover:text-red-400">重试</button>
          <button @click="emit('discard', item.tempId)" class="ml-2 underline text-muted hover:text-gray-300">删除</button>
        </span>
      </div>
    </div>
  </div>
</template>
