<script setup lang="ts">
import { computed } from "vue";
import { type Strength, scorePassword } from "../lib/passwordStrength";

const props = defineProps<{
  password: string;
}>();

const CONFIG: Record<Strength, { label: string; color: string; bars: number }> = {
  weak: { label: "弱", color: "bg-red-500", bars: 1 },
  medium: { label: "中", color: "bg-yellow-500", bars: 2 },
  strong: { label: "强", color: "bg-green-500", bars: 3 },
};

const strength = computed<Strength>(() => scorePassword(props.password));
const cfg = computed(() => CONFIG[strength.value]);
</script>

<template>
  <!-- React 版 !password 时返回 null -->
  <div v-if="password" class="mt-1">
    <div class="flex gap-1">
      <div
        v-for="i in [0, 1, 2]"
        :key="i"
        :class="'h-1 flex-1 rounded ' + (i < cfg.bars ? cfg.color : 'bg-gray-300 dark:bg-gray-600')"
      />
    </div>
    <div
      :class="'text-xs mt-0.5 ' + (strength === 'weak' ? 'text-red-500' : strength === 'medium' ? 'text-yellow-600 dark:text-yellow-500' : 'text-green-600 dark:text-green-500')"
    >
      密码强度：{{ cfg.label }}
      <span v-if="strength === 'weak'" class="text-gray-400"> · 建议至少 8 位且含字母和数字</span>
    </div>
  </div>
</template>
