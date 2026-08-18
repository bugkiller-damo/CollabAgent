<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { apiGet } from "../../api";

interface Member {
  id: string;
  handle: string;
  displayName?: string;
  type: string;
}

const props = defineProps<{
  query: string;
  channelName: string;
  onSelect: (h: string) => void;
  onClose: () => void;
}>();

const members = ref<Member[]>([]);
const idx = ref(0);

onMounted(() => {
  apiGet<{ users: Member[]; agents: Member[] }>("/api/server/info")
    .then((d) => {
      members.value = [...(d.users || []), ...(d.agents || [])];
    })
    .catch(() => {});
});

const list = computed(() =>
  props.query ? members.value.filter((m) => m.handle.toLowerCase().includes(props.query.toLowerCase())) : members.value,
);

function handleKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    idx.value = Math.min(idx.value + 1, list.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    idx.value = Math.max(idx.value - 1, 0);
  } else if (e.key === "Enter" && list.value[idx.value]) {
    e.preventDefault();
    props.onSelect(list.value[idx.value].handle);
  } else if (e.key === "Escape") {
    e.preventDefault();
    props.onClose();
  }
}

onMounted(() => window.addEventListener("keydown", handleKey));
onBeforeUnmount(() => window.removeEventListener("keydown", handleKey));
</script>

<template>
  <div
    v-if="list.length > 0"
    class="absolute bottom-full left-0 mb-1 w-64 max-h-48 overflow-y-auto bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50"
  >
    <button
      v-for="(m, i) in list"
      :key="m.id"
      @click="onSelect(m.handle)"
      :class="'w-full text-left px-3 py-2 text-sm flex items-center gap-2 ' + (i === idx ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700')"
    >
      <span class="w-6 h-6 rounded bg-gray-600 flex items-center justify-center text-xs shrink-0">{{ m.handle[0] }}</span>
      <div class="min-w-0"><span class="font-medium">@{{ m.handle }}</span></div>
      <span class="text-[10px] text-gray-500 ml-auto">{{ m.type }}</span>
    </button>
  </div>
</template>
