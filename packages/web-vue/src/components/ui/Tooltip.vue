<script setup lang="ts">
import { ref } from "vue";

type TooltipPosition = "top" | "bottom" | "left" | "right";

withDefaults(defineProps<{
  label: string;
  position?: TooltipPosition;
}>(), {
  position: "bottom",
});

const positionClasses: Record<TooltipPosition, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
};

const show = ref(false);
</script>

<template>
  <!-- React 的 onFocus/onBlur 会冒泡；Vue 原生 focus/blur 不冒泡，故用 focusin/focusout 保持"子元素聚焦也显示"的语义 -->
  <div
    class="relative flex items-center justify-center"
    @mouseenter="show = true"
    @mouseleave="show = false"
    @focusin="show = true"
    @focusout="show = false"
  >
    <slot />
    <div
      v-if="show"
      :class="[
        'pointer-events-none absolute z-50 whitespace-nowrap rounded-md',
        'bg-gray-900 px-2 py-1 text-xs text-white shadow-lg',
        'dark:bg-gray-700',
        'animate-fade-in',
        positionClasses[position],
      ]"
      role="tooltip"
    >
      {{ label }}
    </div>
  </div>
</template>
