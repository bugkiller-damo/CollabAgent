<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onMounted, ref, watch } from "vue";
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
const stickToBottom = ref(true);

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

// measureElement 在 vue-tsc 下参数被收窄为 TItemElement（HTMLDivElement），
// 与 Vue 模板 :ref 回调期望的 Element|ComponentPublicInstance|null 不兼容，
// 包一层 unknown 桥接后转回 HTMLDivElement，交给 virtualizer 测量。
function measureElement(el: unknown) {
  virtualizer.value.measureElement(el as HTMLDivElement | null);
}

function scrollToEnd() {
  const len = props.items.length;
  if (len === 0) return;
  virtualizer.value.scrollToIndex(len - 1, { align: "end" });
  nextTick(() => {
    const el = parentRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function maybeInitialScroll(len: number) {
  if (!didInitialScroll.value && len > 0) {
    didInitialScroll.value = true;
    stickToBottom.value = true;
    nextTick(() => {
      scrollToEnd();
      requestAnimationFrame(scrollToEnd);
    });
  }
}

onMounted(() => maybeInitialScroll(props.items.length));

watch(
  () => props.channelName,
  () => {
    didInitialScroll.value = false;
    stickToBottom.value = true;
    maybeInitialScroll(props.items.length);
  },
);

watch(
  () => props.items.length,
  (len) => {
    maybeInitialScroll(len);
    if (len > prevCount.value && stickToBottom.value) {
      nextTick(() => {
        scrollToEnd();
        requestAnimationFrame(scrollToEnd);
      });
    }
    prevCount.value = len;
  },
  { flush: "post" },
);

function onParentScroll() {
  const el = parentRef.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
}

// 高亮消息：滚动到目标并标记
watch(
  [() => props.highlightMsgId, () => props.items],
  ([hid, items]) => {
    if (!hid || didHighlight.value === hid) return;
    if (items.length === 0) return;
    const idx = items.findIndex((it) => it.kind === "msg" && it.data.id === hid);
    if (idx >= 0) {
      didHighlight.value = hid;
      virtualizer.value.scrollToIndex(idx, { align: "center" });
    }
  },
  { flush: "post" },
);
</script>

<template>
  <div ref="parentRef" class="min-h-0 flex-1 overflow-y-auto" @scroll.passive="onParentScroll">
    <div :style="{ height: virtualizer.getTotalSize() + 'px', width: '100%', position: 'relative' }">
      <div
        v-for="vi in virtualizer.getVirtualItems()"
        :key="String(vi.key)"
        :data-index="vi.index"
        :ref="measureElement"
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
