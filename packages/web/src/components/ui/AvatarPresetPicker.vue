<script setup lang="ts">
import { computed } from "vue";
import { AVATAR_FAMILIES, avatarFallbackClass, DEFAULT_AVATARS } from "../../lib/defaultAvatars";

const props = withDefaults(
  defineProps<{
    /** 当前生效的 avatar_url：命中预设时高亮；空值（null/""）高亮字母格 */
    current?: string | null;
    /** 传入则在顶部提供「字母头像」格（选择后 emit("")，由调用方决定写 NULL 或 ""） */
    letterName?: string;
    disabled?: boolean;
    /** 紧凑模式：不分组、不标风格名，单个平铺网格（弹窗内使用） */
    compact?: boolean;
  }>(),
  { current: null, letterName: undefined, disabled: false, compact: false },
);

const emit = defineEmits<{ select: [url: string] }>();

const groups = computed(() =>
  AVATAR_FAMILIES.map((f) => ({ ...f, items: DEFAULT_AVATARS.filter((a) => a.family === f.key) })),
);

const letterInitial = computed(() => (props.letterName || "?")[0].toUpperCase());
const letterBg = computed(() => avatarFallbackClass(props.letterName || "?"));
const letterSelected = computed(() => !props.current);

const selectedRing = "ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-gray-800";

function pick(url: string) {
  if (props.disabled) return;
  emit("select", url);
}
</script>

<template>
  <div class="space-y-2.5">
    <div v-if="letterName !== undefined" class="flex items-center gap-2.5">
      <button
        type="button"
        :disabled="disabled"
        :aria-pressed="letterSelected"
        title="字母头像（默认）"
        :class="[
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white transition-shadow disabled:opacity-50',
          letterBg,
          letterSelected ? selectedRing : 'hover:opacity-90',
        ]"
        @click="pick('')"
      >
        {{ letterInitial }}
      </button>
      <span v-if="!compact" class="text-xs text-muted">字母头像（默认）</span>
    </div>

    <div v-if="compact" class="grid grid-cols-6 gap-1.5">
      <button
        v-for="a in DEFAULT_AVATARS"
        :key="a.id"
        type="button"
        :disabled="disabled"
        :title="a.label"
        :aria-pressed="current === a.url"
        :class="[
          'aspect-square w-full overflow-hidden rounded-full transition-shadow disabled:opacity-50',
          current === a.url ? selectedRing : 'hover:ring-2 hover:ring-gray-300 dark:hover:ring-gray-600',
        ]"
        @click="pick(a.url)"
      >
        <img :src="a.url" :alt="a.label" class="h-full w-full" loading="lazy" />
      </button>
    </div>

    <template v-else>
      <div v-for="g in groups" :key="g.key">
        <p class="mb-1.5 text-xs text-muted">{{ g.label }}</p>
        <div class="grid grid-cols-6 gap-2 sm:grid-cols-8">
          <button
            v-for="a in g.items"
            :key="a.id"
            type="button"
            :disabled="disabled"
            :title="a.label"
            :aria-pressed="current === a.url"
            :class="[
              'aspect-square w-full overflow-hidden rounded-full transition-shadow disabled:opacity-50',
              current === a.url ? selectedRing : 'hover:ring-2 hover:ring-gray-300 dark:hover:ring-gray-600',
            ]"
            @click="pick(a.url)"
          >
            <img :src="a.url" :alt="a.label" class="h-full w-full" loading="lazy" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
