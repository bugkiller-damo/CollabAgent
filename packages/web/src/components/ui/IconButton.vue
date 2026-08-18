<script setup lang="ts">
import Tooltip from "./Tooltip.vue";

type TooltipPosition = "top" | "bottom" | "left" | "right";

withDefaults(
  defineProps<{
    label: string;
    tooltip?: string;
    tooltipPosition?: TooltipPosition;
  }>(),
  {
    tooltipPosition: "bottom",
  },
);

// 无论是否被 Tooltip 包裹，fallthrough 属性（onClick / disabled / class 等）都必须落到内部 button 上，
// 对齐 React 版 {...props} 只作用于 button 的行为
defineOptions({ inheritAttrs: false });

const buttonClasses = [
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors",
  "hover:bg-gray-100 hover:text-gray-900",
  "dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white",
  "disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]",
];
</script>

<template>
  <Tooltip v-if="tooltip" :label="tooltip" :position="tooltipPosition">
    <button type="button" :aria-label="label" :class="buttonClasses" v-bind="$attrs">
      <slot />
    </button>
  </Tooltip>
  <button v-else type="button" :aria-label="label" :class="buttonClasses" v-bind="$attrs">
    <slot />
  </button>
</template>
