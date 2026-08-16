<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import MessageRow from "./MessageRow.vue";
import PendingRow from "./PendingRow.vue";
import type { ListItem } from "./types";

const props = defineProps<{
  items: ListItem[];
  channelName?: string;
  highlightMsgId?: string;
}>();

const emit = defineEmits<{
  retry: [tempId: string];
  discard: [tempId: string];
}>();

const parentRef = ref<HTMLDivElement | null>(null);
const prevCount = ref(props.items.length);
const didInitialScroll = ref(false);
const didHighlight = ref<string | undefined>(undefined);

// count / getItemKey 等读取 props.items，包一层 computed 使其随 items 变化而重算（对齐 React 每次重渲染传入最新 options 的语义）
const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>(
  computed(() => ({
    count: props.items.length,
    getScrollElement: () => parentRef.value,
    estimateSize: () => 72,
    overscan: 10,
    getItemKey: (index: number) => {
      const it = props.items[index];
      return it.kind === "msg" ? it.data.id : it.data.tempId;
    },
  })),
);

// 初次渲染滚动到底部（React 版在 useEffect 内执行，等价于挂载后 + 空列表变非空后的首次滚动）
function maybeInitialScroll(len: number) {
  if (!didInitialScroll.value && len > 0) {
    didInitialScroll.value = true;
    virtualizer.scrollToIndex(len - 1, { align: "end" });
  }
}

onMounted(() => maybeInitialScroll(props.items.length));

// 新消息到达时：先补一次"首次滚动"，再在已接近底部时自动滚到底。
// flush:'post' 保证在组件重新渲染（totalSize 已更新）之后再读 scrollHeight。
watch(
  () => props.items.length,
  (len) => {
    maybeInitialScroll(len);
    const el = parentRef.value;
    if (el && len > prevCount.value) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
      if (nearBottom) virtualizer.scrollToIndex(len - 1, { align: "end" });
    }
    prevCount.value = len;
  },
  { flush: "post" },
);

// 高亮消息：滚动到目标并标记
watch(
  [() => props.highlightMsgId, () => props.items],
  ([hid, items]) => {
    if (!hid || didHighlight.value === hid) return;
    if (items.length === 0) return;
    const idx = items.findIndex((it) => it.kind === "msg" && it.data.id === hid);
    if (idx >= 0) {
      didHighlight.value = hid;
      virtualizer.scrollToIndex(idx, { align: "center" });
    }
  },
  { flush: "post" },
);
</script>

<template>
  <div ref="parentRef" class="min-h-0 flex-1 overflow-y-auto">
    <div :style="{ height: virtualizer.getTotalSize() + 'px', width: '100%', position: 'relative' }">
      <div
        v-for="vi in virtualizer.getVirtualItems()"
        :key="vi.key"
        :data-index="vi.index"
        :ref="virtualizer.measureElement"
        :style="{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${vi.start}px)`,
        }"
        class="px-4 py-0.5"
      >
        <MessageRow
          v-if="items[vi.index].kind === 'msg'"
          :msg="items[vi.index].data"
          :channel-name="channelName"
          :prev-msg="vi.index > 0 && items[vi.index - 1].kind === 'msg' ? items[vi.index - 1].data : undefined"
          :is-highlighted="
            highlightMsgId !== undefined &&
            items[vi.index].data.id === highlightMsgId &&
            didHighlight === highlightMsgId
          "
        />
        <PendingRow
          v-else
          :item="items[vi.index].data"
          @retry="emit('retry', $event)"
          @discard="emit('discard', $event)"
        />
      </div>
    </div>
  </div>
</template>
