<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(defineProps<{
  open: boolean;
  /** 内容区宽度类（默认 max-w-md；终端查看器等宽弹窗传 "max-w-4xl" 之类） */
  widthClass?: string;
}>(), {
  widthClass: "max-w-md",
});

const emit = defineEmits<{
  close: [];
}>();

// 父级 class 需要落到内容面板（对齐 React 的 className 用法），而非遮罩层
defineOptions({ inheritAttrs: false });

// 关闭时保留 150ms 退场动画再卸载（对齐 React 版 render/exiting 双状态）
const render = ref(props.open);
const exiting = ref(false);
let exitTimer: ReturnType<typeof setTimeout> | undefined;

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
    } else {
      exiting.value = true;
      exitTimer = setTimeout(() => {
        render.value = false;
        exitTimer = undefined;
      }, 150);
    }
  }
);

function close() {
  emit("close");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.open) close();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
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
      :class="[
        'mx-4 w-full transform rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800',
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
