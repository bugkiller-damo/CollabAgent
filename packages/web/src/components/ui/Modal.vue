<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 内容区宽度类（默认 max-w-md；终端查看器等宽弹窗传 "max-w-4xl" 之类） */
    widthClass?: string;
    /** 无障碍标签（aria-label）；不传则依赖弹窗内可见标题文本 */
    label?: string;
  }>(),
  {
    widthClass: "max-w-md",
    label: undefined,
  },
);

const emit = defineEmits<{
  close: [];
}>();

// 父级 class 需要落到内容面板（对齐 React 的 className 用法），而非遮罩层
defineOptions({ inheritAttrs: false });

// 关闭时保留 150ms 退场动画再卸载（对齐 React 版 render/exiting 双状态）
const render = ref(props.open);
const exiting = ref(false);
let exitTimer: ReturnType<typeof setTimeout> | undefined;

// ---- a11y：焦点陷阱 + 初始聚焦 + 焦点归还 + 滚动锁定 ----
const panelRef = ref<HTMLElement | null>(null);
let previouslyFocused: HTMLElement | null = null;
let prevBodyOverflow: string | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function activateA11y() {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  prevBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  void nextTick(() => {
    const panel = panelRef.value;
    if (!panel) return;
    const target = panel.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? panel).focus();
  });
}

function deactivateA11y() {
  if (prevBodyOverflow !== null) {
    document.body.style.overflow = prevBodyOverflow;
    prevBodyOverflow = null;
  }
  previouslyFocused?.focus();
  previouslyFocused = null;
}

watch(
  () => props.open,
  (open) => {
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = undefined;
    }
    if (open) {
      exiting.value = false;
      render.value = true;
      activateA11y();
    } else {
      deactivateA11y();
      exiting.value = true;
      exitTimer = setTimeout(() => {
        render.value = false;
        exitTimer = undefined;
      }, 150);
    }
  },
);

function close() {
  emit("close");
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === "Escape") {
    close();
    return;
  }
  // Tab 焦点陷阱：循环限制在面板内可聚焦元素之间
  if (e.key !== "Tab") return;
  const panel = panelRef.value;
  if (!panel) return;
  const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
  if (focusables.length === 0) {
    e.preventDefault();
    panel.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !panel.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  if (props.open) activateA11y();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (props.open) deactivateA11y();
  if (exitTimer) clearTimeout(exitTimer);
});
</script>

<template>
  <div
    v-if="render"
    :class="[
      'fixed inset-0 z-50 flex items-center justify-center',
      exiting ? 'animate-fade-out' : 'animate-fade-in',
      'bg-black/50',
    ]"
    @click="close"
  >
    <div
      ref="panelRef"
      role="dialog"
      aria-modal="true"
      :aria-label="label"
      tabindex="-1"
      :class="[
        'mx-4 w-full transform rounded-lg bg-white p-6 shadow-xl outline-none dark:bg-gray-800',
        widthClass,
        exiting ? 'animate-scale-out' : 'animate-scale-in',
        $attrs.class,
      ]"
      @click.stop="() => {}"
    >
      <slot />
    </div>
  </div>
</template>
