<script setup lang="ts">
interface MentionCandidate {
  handle: string;
  displayName: string;
  type: "user" | "agent";
  id?: string;
  duty?: "on" | "off";
}

defineProps<{
  items: MentionCandidate[];
  selectedIdx: number;
}>();

const emit = defineEmits<{
  select: [handle: string];
}>();
</script>

<template>
  <div
    v-if="items.length > 0"
    data-mention-popup
    class="absolute z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl overflow-hidden"
    style="bottom: 100%; left: 1rem; min-width: 14rem; max-height: 15rem; overflow-y: auto; margin-bottom: 4px"
  >
    <button
      v-for="(item, i) in items"
      :key="item.handle"
      type="button"
      :class="[
        'w-full text-left px-3 py-1.5 text-sm flex items-center gap-2',
        i === selectedIdx ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700',
      ]"
      @click="emit('select', item.handle)"
    >
      <span class="w-5 h-5 rounded-full bg-gray-600 flex items-center justify-center text-[10px] shrink-0">
        {{ (item.displayName || item.handle)[0] }}
      </span>
      <span class="font-medium truncate">@{{ item.handle }}</span>
      <span v-if="item.displayName && item.displayName !== item.handle" class="text-gray-500 text-xs truncate">
        {{ item.displayName }}
      </span>
      <span class="ml-auto text-[10px] opacity-50 shrink-0">
        {{ item.duty === "off" ? "停班" : item.type === "agent" ? "Agent" : "" }}
      </span>
    </button>
  </div>
</template>
