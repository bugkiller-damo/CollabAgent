<script setup lang="ts">
import Button from "./ui/Button.vue";
import Modal from "./ui/Modal.vue";

withDefaults(
  defineProps<{
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  }>(),
  {
    confirmLabel: "确定",
    cancelLabel: "取消",
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <Modal open @close="emit('cancel')">
    <h3 class="text-base font-bold text-ink">{{ title }}</h3>
    <p v-if="message" class="text-sm text-subtle">{{ message }}</p>
    <div class="flex justify-end gap-2 pt-1">
      <Button variant="secondary" @click="emit('cancel')">
        {{ cancelLabel }}
      </Button>
      <Button :variant="danger ? 'danger' : 'primary'" @click="emit('confirm')">
        {{ confirmLabel }}
      </Button>
    </div>
  </Modal>
</template>
