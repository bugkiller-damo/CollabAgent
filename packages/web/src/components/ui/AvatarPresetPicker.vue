<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { AVATAR_FAMILIES, avatarFallbackClass, DEFAULT_AVATARS } from "../../lib/defaultAvatars";
import Avatar from "./Avatar.vue";

/**
 * 头像选择器：头像即触发器，点击向下弹出预设面板（Teleport + fixed 定位，
 * 避免被 Modal/Drawer 的 overflow 裁剪）。外点 / Esc / 滚动关闭；面板
 * scale+位移过渡，格子逐格 stagger 入场。emit("") = 恢复字母头像。
 */
const props = withDefaults(
  defineProps<{
    /** 当前生效的 avatar_url：命中预设时高亮；空值（null/""）高亮字母格 */
    current?: string | null;
    /** 传入则在面板顶部提供「字母头像」格（选择后 emit("")，由调用方决定写 NULL 或 ""） */
    letterName?: string;
    disabled?: boolean;
    /** 触发器头像尺寸（转发给 Avatar） */
    size?: "sm" | "md" | "lg" | "xl";
  }>(),
  { current: null, letterName: undefined, disabled: false, size: "lg" },
);

const emit = defineEmits<{ select: [url: string] }>();

const groups = computed(() =>
  AVATAR_FAMILIES.map((f) => ({ ...f, items: DEFAULT_AVATARS.filter((a) => a.family === f.key) })),
);

const letterInitial = computed(() => (props.letterName || "?")[0].toUpperCase());
const letterBg = computed(() => avatarFallbackClass(props.letterName || "?"));
const letterSelected = computed(() => !props.current);

const selectedRing = "ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-gray-800";

// ---- 弹层开合：fixed 定位（Modal/Drawer 容器 overflow 会裁剪 absolute 弹层）----
const open = ref(false);
const btnRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

// 逐格入场序号（--i 供 scoped 样式做 animation-delay 阶梯）
const staggerIndex = new Map(DEFAULT_AVATARS.map((a, i) => [a.id, i + 1]));

const PANEL_W = 288; // w-72
const PANEL_H = 340; // header + max-h-72 滚动区的估值，仅用于判定是否向上翻

function toggle() {
  if (props.disabled) return;
  if (!open.value && btnRef.value) {
    const r = btnRef.value.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8));
    const below = window.innerHeight - r.bottom - 8;
    const flipUp = below < Math.min(PANEL_H, 200) && r.top - 8 > below;
    menuStyle.value = flipUp
      ? { left: `${left}px`, bottom: `${window.innerHeight - r.top + 8}px`, transformOrigin: "bottom left" }
      : { left: `${left}px`, top: `${r.bottom + 8}px`, transformOrigin: "top left" };
  }
  open.value = !open.value;
}

function close(refocus = false) {
  if (!open.value) return;
  open.value = false;
  if (refocus) btnRef.value?.focus();
}

function pick(url: string) {
  if (props.disabled) return;
  close(true); // 键盘选中后焦点回到触发器，符合菜单惯例
  emit("select", url);
}

// 打开后把焦点放进面板（优先当前选中项），键盘用户立即可操作。
// preventScroll：focus 的 scrollIntoView 会滚动面板内层列表 → 命中自己的
// 滚动关闭监听 → 面板开即关（选中项在折叠线以下时必现「点击无反应」）
watch(open, async (v) => {
  if (!v) return;
  await nextTick();
  if (!open.value) return;
  const el =
    menuRef.value?.querySelector<HTMLElement>('[data-selected="true"]') ||
    menuRef.value?.querySelector<HTMLElement>("button");
  el?.focus({ preventScroll: true });
});

function onClickOutside(e: MouseEvent) {
  const t = e.target as Node;
  if (open.value && !menuRef.value?.contains(t) && !btnRef.value?.contains(t)) close();
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) {
    // 弹层已消费 Esc：document 层截停，避免冒泡到 window 上挂的
    // Drawer/Modal Esc 监听把整个抽屉/弹窗一起关掉（嵌套浮层惯例）
    e.stopPropagation();
    close(true);
  }
}
// capture=true：任何容器滚动（含 Modal 内部滚动区）都收回弹层，避免悬浮脱节；
// 但面板内层列表自身的滚动要放行（e.target 是滚动元素本身）
function onScrollOrResize(e: Event) {
  if (e.target instanceof Node && menuRef.value?.contains(e.target)) return;
  close();
}
onMounted(() => {
  document.addEventListener("mousedown", onClickOutside);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onClickOutside);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("scroll", onScrollOrResize, true);
  window.removeEventListener("resize", onScrollOrResize);
});
</script>

<template>
  <button
    ref="btnRef"
    type="button"
    :disabled="disabled"
    aria-haspopup="dialog"
    :aria-expanded="open"
    aria-label="选择头像"
    title="点击选择头像"
    class="relative inline-flex shrink-0 rounded-full transition-transform duration-150 hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:hover:scale-100 dark:focus-visible:ring-offset-gray-800"
    @click="toggle"
  >
    <Avatar :name="letterName || '?'" :src="current || undefined" :size="size" />
    <span
      class="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-white bg-gray-100 text-gray-500 dark:border-gray-800 dark:bg-gray-700 dark:text-gray-300"
    >
      <ChevronDown :class="['h-2.5 w-2.5 transition-transform duration-200', open && 'rotate-180']" aria-hidden="true" />
    </span>
  </button>

  <Teleport to="body">
    <Transition name="avatar-pop">
      <div
        v-if="open"
        ref="menuRef"
        :style="menuStyle"
        role="dialog"
        aria-label="选择头像"
        class="fixed z-50 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800"
      >
        <p class="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">选择头像</p>
        <div class="max-h-72 overflow-y-auto px-3 pb-3">
          <div v-if="letterName !== undefined" class="flex items-center gap-2 pb-2">
            <button
              type="button"
              :data-selected="letterSelected"
              title="字母头像（默认）"
              :aria-pressed="letterSelected"
              :class="[
                'pop-item flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white focus-visible:outline-none',
                letterBg,
                letterSelected ? selectedRing : 'hover:opacity-90',
              ]"
              :style="{ '--i': 0 }"
              @click="pick('')"
            >
              {{ letterInitial }}
            </button>
            <span class="text-xs text-muted">字母头像（默认）</span>
          </div>

          <div v-for="g in groups" :key="g.key" class="pb-1.5">
            <p class="pb-1 text-[10px] font-medium text-muted">{{ g.label }}</p>
            <div class="grid grid-cols-6 gap-2">
              <button
                v-for="a in g.items"
                :key="a.id"
                type="button"
                :title="a.label"
                :aria-pressed="current === a.url"
                :data-selected="current === a.url"
                :class="[
                  'pop-item aspect-square w-full overflow-hidden rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                  current === a.url ? selectedRing : 'hover:ring-2 hover:ring-gray-300 dark:hover:ring-gray-600',
                ]"
                :style="{ '--i': staggerIndex.get(a.id) ?? 0 }"
                @click="pick(a.url)"
              >
                <img :src="a.url" :alt="a.label" class="h-full w-full" loading="lazy" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.avatar-pop-enter-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}
.avatar-pop-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}
.avatar-pop-enter-from,
.avatar-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
}

/* 格子逐格入场：--i 为全局序号，延迟封顶 180ms 保证尾格不拖沓 */
.pop-item {
  animation: avatar-item-in 0.28s cubic-bezier(0.34, 1.4, 0.64, 1) both;
  animation-delay: min(calc(var(--i, 0) * 9ms), 180ms);
}
@keyframes avatar-item-in {
  from {
    opacity: 0;
    transform: scale(0.5) translateY(6px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
</style>
