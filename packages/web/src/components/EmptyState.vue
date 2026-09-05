<script setup lang="ts">
import Button from "./ui/Button.vue";

withDefaults(
  defineProps<{
    icon?: string;
    title: string;
    description?: string;
    actionLabel?: string;
  }>(),
  {
    icon: "💬",
  },
);

const emit = defineEmits<{
  action: [];
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center px-4 py-16 text-center">
    <div class="mb-4 text-5xl opacity-60">{{ icon }}</div>
    <h3 class="mb-1 text-base font-medium text-gray-700 dark:text-gray-300">{{ title }}</h3>
    <p v-if="description" class="mb-4 max-w-sm text-sm text-gray-500 dark:text-gray-500">{{ description }}</p>
    <Button v-if="actionLabel" @click="emit('action')">
      {{ actionLabel }}
    </Button>
  </div>
</template>
