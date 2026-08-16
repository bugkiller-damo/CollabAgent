<script setup lang="ts">
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

withDefaults(defineProps<{
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
}>(), {
  variant: "primary",
  size: "md",
  loading: false,
  disabled: false,
});

const variantStyles: Record<ButtonVariant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-500 focus:ring-blue-300 disabled:bg-blue-300",
  secondary: "bg-gray-200 text-gray-900 hover:bg-gray-300 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600 focus:ring-gray-300",
  ghost: "bg-transparent text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white focus:ring-gray-300",
  danger: "bg-red-600 text-white hover:bg-red-500 focus:ring-red-300 disabled:bg-red-300",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs rounded",
  md: "px-4 py-2 text-sm rounded-md",
  lg: "px-5 py-2.5 text-base rounded-md",
};
</script>

<template>
  <!-- 其余原生 button 属性（type / onClick / aria-* 等）与父级 class 均通过 fallthrough 落到 button 上 -->
  <button
    :disabled="disabled || loading"
    :class="[
      'inline-flex items-center justify-center font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-white dark:focus:ring-offset-gray-900 disabled:cursor-not-allowed active:scale-[0.98]',
      variantStyles[variant],
      sizeStyles[size],
    ]"
  >
    <span
      v-if="loading"
      class="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
    <slot />
  </button>
</template>
