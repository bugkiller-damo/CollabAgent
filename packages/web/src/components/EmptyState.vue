<script setup lang="ts">
import { AlarmClock, Mail, MessageCircle, Search, TriangleAlert, Users, Zap } from "@lucide/vue";
import { type Component, computed } from "vue";
import Button from "./ui/Button.vue";

// 语义名 → 图标组件。icon prop 用语义名而非组件对象：11 个消费方传字符串即可，
// 统一在单点控制空态图标视觉。未知语义名回落 message（不抛错，防新增页面漏配）。
const ICONS: Record<string, Component> = {
  message: MessageCircle,
  alert: TriangleAlert,
  search: Search,
  users: Users,
  mail: Mail,
  zap: Zap,
  clock: AlarmClock,
};

const props = withDefaults(
  defineProps<{
    icon?: string;
    title: string;
    description?: string;
    actionLabel?: string;
  }>(),
  {
    icon: "message",
  },
);

const iconComponent = computed(() => ICONS[props.icon] ?? MessageCircle);

const emit = defineEmits<{
  action: [];
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center px-4 py-16 text-center">
    <component :is="iconComponent" class="mb-4 h-12 w-12 opacity-60" />
    <h3 class="mb-1 text-base font-medium text-gray-700 dark:text-gray-300">{{ title }}</h3>
    <p v-if="description" class="mb-4 max-w-sm text-sm text-gray-500 dark:text-gray-500">{{ description }}</p>
    <Button v-if="actionLabel" @click="emit('action')">
      {{ actionLabel }}
    </Button>
  </div>
</template>

