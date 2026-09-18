<script setup lang="ts">
import { Check, House, Plus, X } from "@lucide/vue";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { channelPath, lastChannelKey } from "../../lib/nav";
import { type ServerItem, useChannelStore, useServerStore, useUiStore } from "../../stores";
import Tooltip from "../ui/Tooltip.vue";

/**
 * 最左 server 列（guild 化 IA）：首页/私信入口 + server 图标 + 创建/加入。
 * 视觉沿用现有灰蓝体系（gray-100 rail + blue-600 强调），不仿 Discord 配色。
 * 桌面常驻；移动端随 Sidebar 一起在抽屉内可见。
 */

const serverStore = useServerStore();
const channelStore = useChannelStore();
const uiStore = useUiStore();
const router = useRouter();

const orgs = computed(() => serverStore.orgs);
const activeId = computed(() => serverStore.activeServerId);

function initial(name: string): string {
  const ch = (name || "?").trim().charAt(0);
  return ch.toUpperCase();
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

function goHome() {
  // 私信「首页」：DM 列表在 ChatPane 私信区——切到聊天 pane 即是入口；
  // 已在 /dm/* 路由时顺带关抽屉即可
  uiStore.selectSidebarPane("chat");
  uiStore.closeMobileDrawer();
}

function selectServer(s: ServerItem) {
  if (s.id === activeId.value) return;
  serverStore.setActive(s.id);
  let last = "general";
  try {
    last = localStorage.getItem(lastChannelKey(s.id)) || "general";
  } catch {
    /* ignore */
  }
  uiStore.closeMobileDrawer();
  void router.push(channelPath(s.id, last));
}

// ---- 创建 / 加入 ----
const showAdd = ref(false);
const addMode = ref<"create" | "join">("create");
const serverName = ref("");
const inviteInput = ref("");
const addBusy = ref(false);
const addError = ref("");

function openAdd() {
  showAdd.value = true;
  addMode.value = "create";
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
      void router.push(channelPath(org.id, "general"));
    } catch (e: any) {
      addError.value = e?.message || "创建失败";
    } finally {
      addBusy.value = false;
    }
    return;
  }
  const token = extractToken(inviteInput.value);
  if (!token) {
    addError.value = "请输入邀请链接或代码";
    return;
  }
  addBusy.value = true;
  try {
    const r = await serverStore.acceptInvite(token);
    serverStore.setActive(r.serverId);
    showAdd.value = false;
    uiStore.closeMobileDrawer();
    void router.push(channelPath(r.serverId, "general"));
  } catch (e: any) {
    addError.value = e?.message || "加入失败";
  } finally {
    addBusy.value = false;
  }
}
</script>

<template>
  <nav
    class="flex h-full w-14 shrink-0 flex-col items-center border-r border-gray-200 bg-gray-50 py-2 dark:border-gray-700 dark:bg-gray-900"
    aria-label="服务器"
  >
    <Tooltip label="私信" position="right">
      <button
        type="button"
        aria-label="私信"
        :class="[
          'flex h-10 w-10 items-center justify-center rounded-xl transition-colors',
          $route.path.startsWith('/dm/')
            ? 'bg-blue-600 text-white'
            : 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
        ]"
        @click="goHome"
      >
        <House class="h-5 w-5" />
      </button>
    </Tooltip>

    <div class="my-2 h-px w-8 shrink-0 bg-gray-300 dark:bg-gray-600" />

    <div class="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
      <Tooltip v-for="s in orgs" :key="s.id" :label="s.name" position="right">
        <button
          type="button"
          :aria-label="s.name"
          :aria-pressed="s.id === activeId"
          :class="[
            'relative flex h-10 w-10 items-center justify-center rounded-xl text-sm font-semibold transition-colors',
            s.id === activeId
              ? 'bg-blue-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
          ]"
          @click="selectServer(s)"
        >
          {{ initial(s.name) }}
          <span
            v-if="unreadFor(s.id) > 0"
            class="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white"
          >
            {{ unreadFor(s.id) > 99 ? "99+" : unreadFor(s.id) }}
          </span>
        </button>
      </Tooltip>
    </div>

    <Tooltip label="创建或加入服务器" position="right">
      <button
        type="button"
        aria-label="创建或加入服务器"
        class="mt-2 flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-gray-400 text-gray-500 transition-colors hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-400 dark:hover:border-blue-400 dark:hover:text-blue-400"
        @click="openAdd"
      >
        <Plus class="h-5 w-5" />
      </button>
    </Tooltip>

    <!-- 创建 / 加入弹层 -->
    <Teleport to="body">
      <div
        v-if="showAdd"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        @click.self="showAdd = false"
      >
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
  </nav>
</template>
