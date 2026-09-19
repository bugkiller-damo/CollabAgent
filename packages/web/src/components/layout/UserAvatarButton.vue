<script setup lang="ts">
import { Check, Link2, Plus, X } from "@lucide/vue";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { channelPath } from "../../lib/nav";
import { type ServerItem, useAuthStore, useChannelStore, useServerStore, useUiStore } from "../../stores";
import Avatar from "../ui/Avatar.vue";
import Tooltip from "../ui/Tooltip.vue";

/**
 * 左下角头像 = 服务器管理二级菜单入口（guild 化 IA 收敛：撤销独立 server 列）。
 * 菜单内容：用户身份头 + 公共服务器（is_public）+ 我的服务器（自建/被邀
 * server 同区——2026-09-19 personal 特例取消后所有自建 server 同口径）+
 * 新建 / 通过邀请加入。点击外部 / Esc 关闭；fixed 定位避免被侧栏 overflow 裁剪。
 * direction="up"（rail 底部，向上弹）| "down"（移动端抽屉顶栏，向下弹）。
 */
const props = withDefaults(defineProps<{ direction?: "up" | "down" }>(), { direction: "up" });

const authStore = useAuthStore();
const uiStore = useUiStore();
const serverStore = useServerStore();
const channelStore = useChannelStore();
const router = useRouter();

const displayName = computed(() => authStore.user?.displayName || authStore.user?.handle || "User");

const ringClass = computed(() => {
  if (!uiStore.online) return "ring-2 ring-amber-500";
  if (uiStore.wsStatus === "connected") return "ring-2 ring-green-500";
  if (uiStore.wsStatus === "connecting" || uiStore.wsStatus === "reconnecting") return "ring-2 ring-amber-400";
  return "ring-2 ring-red-500";
});

const statusText = computed(() => {
  if (!uiStore.online) return "离线";
  if (uiStore.wsStatus === "connected") return "已连接";
  if (uiStore.wsStatus === "connecting" || uiStore.wsStatus === "reconnecting") return "连接中";
  return "未连接";
});
const statusDotClass = computed(() => {
  if (!uiStore.online || uiStore.wsStatus === "connecting" || uiStore.wsStatus === "reconnecting")
    return "bg-amber-400";
  return uiStore.wsStatus === "connected" ? "bg-green-500" : "bg-red-500";
});

// ---- server 列表：公共服务器（is_public）与我的服务器（其余全部）分组 ----
const publicOrgs = computed(() => serverStore.orgs.filter((o) => o.is_public));
const myOrgs = computed(() => serverStore.orgs.filter((o) => !o.is_public));
// 未加入的公共 server（注册自动入圈前的存量账号在此补票）
const discoverable = computed(() => serverStore.discoverable);
const activeId = computed(() => serverStore.activeServerId);
const joiningId = ref<string | null>(null);

function initial(name: string): string {
  return (name || "?").trim().charAt(0).toUpperCase();
}

/** 该 server 的未读总数（unreadCounts key 为 "<serverId>:<name>"） */
function unreadFor(serverId: string): number {
  const prefix = `${serverId}:`;
  let n = 0;
  for (const k in channelStore.unreadCounts) {
    if (k.startsWith(prefix)) n += channelStore.unreadCounts[k] || 0;
  }
  return n;
}

/** 非活跃 server 有未读时头像右上角红点——菜单外也能感知「别处有动静」 */
const elsewhereUnread = computed(() => serverStore.orgs.some((o) => o.id !== activeId.value && unreadFor(o.id) > 0));

// admin 角色值冷冻（schema 保留、不可指派）——存量 admin 一律显示为成员
function roleLabel(role: ServerItem["role"]): string {
  if (role === "owner") return "所有者";
  return "成员";
}

// ---- 菜单开合：fixed 定位（侧栏容器 overflow-hidden 会裁剪 absolute 弹层）----
const open = ref(false);
const btnRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

function toggle() {
  if (!open.value && btnRef.value) {
    const r = btnRef.value.getBoundingClientRect();
    menuStyle.value =
      props.direction === "up"
        ? { left: `${r.left}px`, bottom: `${window.innerHeight - r.top + 8}px` }
        : { left: `${r.left}px`, top: `${r.bottom + 8}px` };
  }
  open.value = !open.value;
}

function close() {
  open.value = false;
}

function onClickOutside(e: MouseEvent) {
  const t = e.target as Node;
  if (open.value && !menuRef.value?.contains(t) && !btnRef.value?.contains(t)) close();
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}
onMounted(() => {
  document.addEventListener("mousedown", onClickOutside);
  document.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onClickOutside);
  document.removeEventListener("keydown", onKeydown);
});

async function selectServer(s: ServerItem) {
  close();
  if (s.id === activeId.value) return;
  serverStore.setActive(s.id);
  // 落点按目标 server 的真实频道列表解析——新建 server 只有私有
  // onboarding-owner 频道（无 general），硬编码 general 会落到 404
  const last = await channelStore.resolveLandingChannel(s.id);
  uiStore.closeMobileDrawer();
  void router.push(channelPath(s.id, last));
}

/** 自助加入公共 server——成功后切过去并落到其频道 */
async function joinDiscoverable(s: { id: string; name: string }) {
  if (joiningId.value) return;
  joiningId.value = s.id;
  try {
    await serverStore.joinServer(s.id);
    const joined = serverStore.orgs.find((o) => o.id === s.id);
    close();
    if (joined) {
      serverStore.setActive(s.id);
      const ch = await channelStore.resolveLandingChannel(s.id);
      uiStore.closeMobileDrawer();
      void router.push(channelPath(s.id, ch));
    }
  } catch {
    /* join 失败留在菜单，discoverable 列表保持原样 */
  } finally {
    joiningId.value = null;
  }
}

// ---- 创建 / 加入（沿用原 ServerRail 弹窗，tab 由菜单动作预选）----
const showAdd = ref(false);
const addMode = ref<"create" | "join">("create");
const serverName = ref("");
const inviteInput = ref("");
const addBusy = ref(false);
const addError = ref("");

function openAdd(mode: "create" | "join") {
  close();
  showAdd.value = true;
  addMode.value = mode;
  serverName.value = "";
  inviteInput.value = "";
  addError.value = "";
}

/** 邀请输入兼容整链接（/invite/<token>、?invite=<token>）与裸 token */
function extractToken(input: string): string {
  const s = input.trim();
  if (!s) return "";
  try {
    const u = new URL(s, window.location.origin);
    const m = /\/invite\/([^/?#]+)/.exec(u.pathname);
    if (m) return decodeURIComponent(m[1]);
    const q = u.searchParams.get("invite");
    if (q) return q;
  } catch {
    /* 非 URL → 裸 token */
  }
  return s;
}

async function submitAdd() {
  addError.value = "";
  if (addMode.value === "create") {
    const name = serverName.value.trim();
    if (!name) {
      addError.value = "请输入服务器名称";
      return;
    }
    addBusy.value = true;
    try {
      const org = await serverStore.createServer(name);
      serverStore.setActive(org.id);
      showAdd.value = false;
      uiStore.closeMobileDrawer();
      const ch = await channelStore.resolveLandingChannel(org.id);
      void router.push(channelPath(org.id, ch));
    } catch (e: any) {
      addError.value = e?.message || "创建失败";
    } finally {
      addBusy.value = false;
    }
    return;
  }
  const token = extractToken(inviteInput.value);
  if (!token) {
    addError.value = "请输入邀请链接或邀请码";
    return;
  }
  addBusy.value = true;
  try {
    const r = await serverStore.acceptInvite(token);
    serverStore.setActive(r.serverId);
    showAdd.value = false;
    uiStore.closeMobileDrawer();
    const ch = await channelStore.resolveLandingChannel(r.serverId);
    void router.push(channelPath(r.serverId, ch));
  } catch (e: any) {
    addError.value = e?.message || "加入失败";
  } finally {
    addBusy.value = false;
  }
}
</script>

<template>
  <Tooltip :label="`${displayName} · 我的服务器`" position="right">
    <button
      ref="btnRef"
      type="button"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="`${displayName}，打开服务器菜单`"
      class="relative flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-gray-200 dark:hover:bg-gray-700"
      @click="toggle"
    >
      <span :class="['rounded-full', ringClass]">
        <Avatar :name="displayName" :src="authStore.user?.avatarUrl || undefined" size="sm" />
      </span>
      <span
        v-if="elsewhereUnread"
        class="absolute right-0 top-0.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-gray-100 dark:ring-gray-800"
        aria-label="其他服务器有未读消息"
      />
    </button>
  </Tooltip>

  <!-- 服务器管理二级菜单 -->
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      :style="menuStyle"
      class="fixed z-50 w-72 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800"
      role="menu"
    >
      <!-- 用户身份头 -->
      <div class="flex items-center gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-700">
        <span :class="['rounded-full', ringClass]">
          <Avatar :name="displayName" :src="authStore.user?.avatarUrl || undefined" size="md" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-semibold text-ink">{{ displayName }}</div>
          <div class="truncate text-xs text-muted">@{{ authStore.user?.handle }}</div>
        </div>
        <span class="flex items-center gap-1.5 text-xs text-muted">
          <span :class="['h-2 w-2 rounded-full', statusDotClass]" />
          {{ statusText }}
        </span>
      </div>

      <div class="max-h-72 overflow-y-auto py-1">
        <!-- 公共服务器（is_public：已加入的行 + 未加入的可发现行，member 不可退） -->
        <div
          v-if="publicOrgs.length || discoverable.length"
          class="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted"
        >
          公共服务器
        </div>
        <button
          v-for="s in publicOrgs"
          :key="s.id"
          type="button"
          role="menuitem"
          :class="[
            'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
            s.id === activeId ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-gray-100 dark:hover:bg-gray-700',
          ]"
          @click="selectServer(s)"
        >
          <span
            :class="[
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold',
              s.id === activeId ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-200',
            ]"
          >
            {{ initial(s.name) }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="truncate text-sm font-medium text-ink">{{ s.name }}</span>
              <span
                v-if="s.isDefault"
                class="shrink-0 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-muted dark:bg-gray-700"
                title="实例默认社区"
              >默认</span>
            </span>
            <span class="block truncate text-xs text-muted">{{ roleLabel(s.role) }} · {{ s.memberCount }} 成员</span>
          </span>
          <span
            v-if="unreadFor(s.id) > 0"
            class="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white"
          >
            {{ unreadFor(s.id) > 99 ? "99+" : unreadFor(s.id) }}
          </span>
          <Check v-else-if="s.id === activeId" class="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        </button>
        <!-- 未加入的公共 server：卡片可点加入，加入即切换 -->
        <button
          v-for="s in discoverable"
          :key="s.id"
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
          :disabled="joiningId === s.id"
          @click="joinDiscoverable(s)"
        >
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm font-semibold text-gray-500 dark:border-gray-600 dark:text-gray-300"
          >
            {{ initial(s.name) }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="truncate text-sm font-medium text-ink">{{ s.name }}</span>
              <span
                v-if="s.isDefault"
                class="shrink-0 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-muted dark:bg-gray-700"
                title="实例默认社区"
              >默认</span>
            </span>
            <span class="block truncate text-xs text-muted">{{ s.memberCount }} 成员 · 未加入</span>
          </span>
          <span class="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white">
            {{ joiningId === s.id ? "加入中…" : "加入" }}
          </span>
        </button>
        <p v-if="!publicOrgs.length && !discoverable.length" class="px-3 py-2 text-xs text-muted">
          还没有加入公共服务器
        </p>

        <!-- 我的服务器（自建/被邀 user server 同区） -->
        <div class="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">我的服务器</div>
        <button
          v-for="s in myOrgs"
          :key="s.id"
          type="button"
          role="menuitem"
          :class="[
            'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
            s.id === activeId ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-gray-100 dark:hover:bg-gray-700',
          ]"
          @click="selectServer(s)"
        >
          <span
            :class="[
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold',
              s.id === activeId ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-200',
            ]"
          >
            {{ initial(s.name) }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="truncate text-sm font-medium text-ink">{{ s.name }}</span>
            <span class="block truncate text-xs text-muted">{{ roleLabel(s.role) }} · {{ s.memberCount }} 成员</span>
          </span>
          <span
            v-if="unreadFor(s.id) > 0"
            class="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white"
          >
            {{ unreadFor(s.id) > 99 ? "99+" : unreadFor(s.id) }}
          </span>
          <Check v-else-if="s.id === activeId" class="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        </button>
        <p v-if="!myOrgs.length" class="px-3 py-2 text-xs text-muted">还没有自己的服务器</p>
      </div>

      <!-- 动作：新建 / 通过邀请加入 -->
      <div class="border-t border-gray-100 p-1.5 dark:border-gray-700">
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          @click="openAdd('create')"
        >
          <span class="flex h-7 w-7 items-center justify-center rounded-lg border border-dashed border-gray-400 text-gray-500 dark:border-gray-500 dark:text-gray-400">
            <Plus class="h-4 w-4" />
          </span>
          新建服务器
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          @click="openAdd('join')"
        >
          <span class="flex h-7 w-7 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400">
            <Link2 class="h-4 w-4" />
          </span>
          通过邀请加入
        </button>
      </div>
    </div>
  </Teleport>

  <!-- 创建 / 加入弹层 -->
  <Teleport to="body">
    <div v-if="showAdd" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="showAdd = false">
      <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between">
          <div class="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-700">
            <button
              :class="[
                'rounded-md px-3 py-1 text-sm',
                addMode === 'create'
                  ? 'bg-white font-medium text-gray-900 shadow-sm dark:bg-gray-600 dark:text-white'
                  : 'text-gray-500 dark:text-gray-300',
              ]"
              @click="addMode = 'create'"
            >
              创建服务器
            </button>
            <button
              :class="[
                'rounded-md px-3 py-1 text-sm',
                addMode === 'join'
                  ? 'bg-white font-medium text-gray-900 shadow-sm dark:bg-gray-600 dark:text-white'
                  : 'text-gray-500 dark:text-gray-300',
              ]"
              @click="addMode = 'join'"
            >
              加入服务器
            </button>
          </div>
          <button class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" aria-label="关闭" @click="showAdd = false">
            <X class="h-5 w-5" />
          </button>
        </div>

        <div v-if="addMode === 'create'" class="space-y-3">
          <p class="text-xs text-muted">为你的团队创建一个服务器，频道和成员都在其中。</p>
          <input
            v-model="serverName"
            type="text"
            maxlength="100"
            placeholder="服务器名称"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            @keydown.enter="submitAdd"
          />
        </div>
        <div v-else class="space-y-3">
          <p class="text-xs text-muted">粘贴邀请链接或邀请码，加入别人的服务器。</p>
          <input
            v-model="inviteInput"
            type="text"
            placeholder="https://…/invite/xxxx 或邀请码"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            @keydown.enter="submitAdd"
          />
        </div>

        <p v-if="addError" class="mt-2 text-xs text-red-500">{{ addError }}</p>

        <button
          class="mt-4 flex w-full items-center justify-center gap-1 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="addBusy"
          @click="submitAdd"
        >
          <Check v-if="!addBusy" class="h-4 w-4" />
          {{ addBusy ? "处理中…" : addMode === "create" ? "创建" : "加入" }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
