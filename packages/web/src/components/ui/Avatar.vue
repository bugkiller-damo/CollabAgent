<script setup lang="ts">
import { computed, type PropType } from "vue";

type AvatarSize = "sm" | "md" | "lg" | "xl";

// 运行期声明：React 版用 `typeof online === "boolean"` 区分"未传 online（不显示状态点）"
// 与"显式传 false（灰点）"，这里显式 default: undefined，规避 Vue Boolean prop 缺省自动转 false 的规则
const props = defineProps({
  name: { type: String, required: true },
  src: { type: String, default: undefined },
  size: { type: String as PropType<AvatarSize>, default: "md" },
  online: { type: Boolean as PropType<boolean | undefined>, default: undefined },
});

const sizeMap: Record<AvatarSize, { box: string; text: string; dot: string }> = {
  sm: { box: "w-6 h-6", text: "text-[10px]", dot: "w-2 h-2" },
  md: { box: "w-8 h-8", text: "text-xs", dot: "w-2.5 h-2.5" },
  lg: { box: "w-10 h-10", text: "text-sm", dot: "w-3 h-3" },
  xl: { box: "w-14 h-14", text: "text-xl", dot: "w-3.5 h-3.5" },
};

const s = computed(() => sizeMap[props.size]);
const initial = computed(() => (props.name || "?")[0].toUpperCase());
</script>

<template>
  <div class="relative inline-flex shrink-0">
    <img v-if="src" :src="src" :alt="name" :class="[s.box, 'rounded-full object-cover']" />
    <div
      v-else
      :class="[
        s.box,
        'rounded-full bg-gray-500 dark:bg-gray-600 flex items-center justify-center font-medium text-white',
        s.text,
      ]"
    >
      {{ initial }}
    </div>
    <span
      v-if="typeof online === 'boolean'"
      :class="[
        'absolute -bottom-0.5 -right-0.5',
        s.dot,
        'rounded-full border-2 border-gray-50 dark:border-gray-800',
        online ? 'bg-green-500' : 'bg-gray-400',
      ]"
    />
  </div>
</template>
