<script setup lang="ts">
import Modal from "./ui/Modal.vue";

withDefaults(defineProps<{
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}>(), {
  confirmLabel: "确定",
  cancelLabel: "取消",
});

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <Modal open @close="emit('cancel')">
    <h3 class="text-base font-bold text-gray-900 dark:text-white">{{ title }}</h3>
    <p v-if="message" class="text-sm text-gray-600 dark:text-gray-400">{{ message }}</p>
    <div class="flex justify-end gap-2 pt-1">
      <button
        class="rounded-md bg-gray-200 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-300 active:scale-[0.98] dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        @click="emit('cancel')"
      >
        {{ cancelLabel }}
      </button>
      <button
        :class="[
          'rounded-md px-4 py-2 text-sm text-white transition-colors active:scale-[0.98]',
          danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500',
        ]"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </div>
  </Modal>
</template>
