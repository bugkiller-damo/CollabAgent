<script setup lang="ts">
type CardPadding = "none" | "sm" | "md" | "lg";

withDefaults(
  defineProps<{
    padding?: CardPadding;
  }>(),
  {
    padding: "md",
  },
);

const paddingStyles: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};
</script>

<template>
  <!-- 父级 class 与其余 div 属性（id / data-* 等）通过 fallthrough 落到根 div 上 -->
  <div
    :class="[
      'rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800',
      paddingStyles[padding],
    ]"
  >
    <slot />
  </div>
</template>
