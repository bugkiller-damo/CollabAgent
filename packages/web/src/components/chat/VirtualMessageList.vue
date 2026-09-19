<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import MessageRow from "./MessageRow.vue";
import PendingRow from "./PendingRow.vue";
import type { ListItem } from "./types";

const props = defineProps<{
  items: ListItem[];
  channelName?: string;
  /** 频道 UUID：透传给 MessageRow 做发送者头像的成员缓存解析 */
  channelId?: string;
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

// 高亮待定：目标 id 已声明但尚未在列表中命中——期间抑制自动滚底，否则初始/追加的
// scrollToEnd 会盖掉随后的 scrollToIndex 居中（搜索跳转落最新的实锤竞争）
const highlightPending = computed(() => !!props.highlightMsgId && didHighlight.value !== props.highlightMsgId);

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
    // 声明了高亮目标就不滚底、也不重臂钉底——onMounted 晚于 immediate 高亮 watcher
    // 执行，无此守卫会在居中完成后把视图拽回最新（give-up 清 hash 后由 highlight
    // watcher 的 !hid 分支补滚底，不会停在中途）
    if (props.highlightMsgId) return;
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
    if (len > prevCount.value && stickToBottom.value && !highlightPending.value) {
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
// immediate 覆盖「回填后列表跨阈值切到虚拟分支」的挂载场景——挂载时 items 已含目标，
// 非 immediate 的 watcher 不会因「变化」触发，目标永远等不到
watch(
  [() => props.highlightMsgId, () => props.items],
  ([hid, items]) => {
    if (!hid) {
      // 父级 give-up 清了 hash：复位跟踪；仍处于钉底态时补一次滚底（初始滚底曾被抑制）
      if (didHighlight.value) didHighlight.value = undefined;
      else if (stickToBottom.value && items.length > 0) {
        nextTick(() => {
          scrollToEnd();
          requestAnimationFrame(scrollToEnd);
        });
      }
      return;
    }
    if (didHighlight.value === hid) return;
    if (items.length === 0) return;
    const idx = items.findIndex((it) => it.kind === "msg" && it.data.id === hid);
    if (idx >= 0) {
      didHighlight.value = hid;
      // 定位在历史位置：解除钉底——新消息到达时 items.length watcher 不再拽回最新
      stickToBottom.value = false;
      virtualizer.value.scrollToIndex(idx, { align: "center" });
      // 行高测量收敛后重滚一次校正位置（estimateSize 与实际行高有差）
      nextTick(() => virtualizer.value.scrollToIndex(idx, { align: "center" }));
    }
  },
  { flush: "post", immediate: true },
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
          :channel-id="channelId"
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
