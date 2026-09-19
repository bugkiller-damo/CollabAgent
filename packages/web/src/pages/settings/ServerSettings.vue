<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import PageHeader from "../../components/layout/PageHeader.vue";
import Button from "../../components/ui/Button.vue";
import Card from "../../components/ui/Card.vue";
import Input from "../../components/ui/Input.vue";
import Modal from "../../components/ui/Modal.vue";
import { channelPath } from "../../lib/nav";
import { useChannelStore, useServerStore } from "../../stores";
import { toast } from "../../stores/toastStore";

/**
 * 服务器资料（设置二级菜单）：展示当前活跃 server 信息，owner 可改名；
 * 危险区提供删服入口——永久删除 server 及全部数据（agent/频道/消息/计算机/
 * 邀请），二次确认要求逐字输入服务器名。
 * 非 owner 只读；公共服务器（is_public/广场）不显示危险区（后端 409 同口径）。
 */

const router = useRouter();
const serverStore = useServerStore();
const channelStore = useChannelStore();

const server = computed(() => serverStore.activeServer);
const isOwner = computed(() => server.value?.role === "owner");
// 与 ChatPane canDelete 同口径：owner + 非默认 + 非公共才显示危险区
const canDelete = computed(() => !!server.value && isOwner.value && !server.value.isDefault && !server.value.is_public);

const name = ref("");
const saveBusy = ref(false);
const msg = ref("");
const msgOk = ref(false);

watch(
  server,
  (s) => {
    name.value = s?.name ?? "";
    msg.value = "";
  },
  { immediate: true },
);

async function saveName() {
  const s = server.value;
  const n = name.value.trim();
  if (!s || !isOwner.value) return;
  if (!n) {
    msg.value = "请输入服务器名称";
    msgOk.value = false;
    return;
  }
  if (n === s.name) return;
  saveBusy.value = true;
  msg.value = "";
  try {
    await serverStore.renameServer(s.id, n);
    msg.value = "已保存";
    msgOk.value = true;
  } catch (e: any) {
    msg.value = e?.message || "保存失败";
    msgOk.value = false;
  } finally {
    saveBusy.value = false;
  }
}

// ---- 删除：Modal + 逐字输入服务器名二次确认 ----
const confirmOpen = ref(false);
const confirmText = ref("");
const deleteBusy = ref(false);
const confirmMatched = computed(() => !!server.value && confirmText.value.trim() === server.value.name);

function openConfirm() {
  confirmText.value = "";
  confirmOpen.value = true;
}

async function submitDelete() {
  const s = server.value;
  if (!s || !confirmMatched.value || deleteBusy.value) return;
  deleteBusy.value = true;
  try {
    await serverStore.deleteServer(s.id);
    confirmOpen.value = false;
    toast.success(`服务器「${s.name}」已删除`);
    // 落到下一个活跃 server 的合法频道（无 server 可去时回根路径）
    const next = serverStore.activeServerId;
    if (next) void router.push(channelPath(next, await channelStore.resolveLandingChannel(next)));
    else void router.push("/");
  } catch (e: any) {
    toast.error("删除失败：" + (e?.message || "网络错误"));
    deleteBusy.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="服务器资料" back-to="/settings" />

    <Card v-if="server" class="w-full">
      <div class="mx-auto max-w-lg space-y-4">
        <div class="flex items-center gap-4">
          <span
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-xl font-bold text-white"
          >
            {{ (server.name || "?").trim().charAt(0).toUpperCase() }}
          </span>
          <div class="min-w-0">
            <p class="truncate text-base font-semibold text-ink">{{ server.name }}</p>
            <p class="text-xs text-muted">
              {{ server.is_public ? "公共服务器" : "私有服务器" }} · {{ server.memberCount }} 成员 ·
              {{ server.agentCount }} Agent
            </p>
          </div>
        </div>

        <div>
          <label class="mb-1 block text-sm text-subtle">服务器名称{{ isOwner ? "" : "（仅所有者可修改）" }}</label>
          <Input
            type="text"
            :value="name"
            :disabled="!isOwner"
            maxlength="100"
            @input="name = ($event.target as HTMLInputElement).value"
          />
        </div>
        <div class="flex items-center gap-3">
          <Button size="sm" :loading="saveBusy" :disabled="!isOwner || name.trim() === server.name" @click="saveName">
            保存
          </Button>
          <p
            v-if="msg"
            :class="['text-sm', msgOk ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400']"
          >
            {{ msg }}
          </p>
        </div>
      </div>
    </Card>

    <Card v-else class="w-full">
      <p class="py-6 text-center text-sm text-muted">当前没有选中的服务器——先在左上角服务器菜单选择一个。</p>
    </Card>

    <!-- 危险区：仅 owner + 非公共/默认 server（后端同口径拒删） -->
    <Card v-if="server && canDelete" class="w-full border-red-200 dark:border-red-900/50">
      <div class="mx-auto max-w-lg space-y-3">
        <h3 class="font-semibold text-red-600 dark:text-red-400">危险区</h3>
        <p class="text-sm text-subtle">
          永久删除「{{ server.name }}」及其全部数据：Agent、频道、消息、计算机与邀请链接。此操作不可恢复。
        </p>
        <Button variant="danger" size="sm" @click="openConfirm">删除服务器</Button>
      </div>
    </Card>

    <Modal :open="confirmOpen" @close="confirmOpen = false">
      <div class="space-y-4">
        <h3 class="text-base font-bold text-red-600 dark:text-red-400">删除「{{ server?.name }}」</h3>
        <p class="text-sm text-subtle">
          该服务器下的 <strong>{{ server?.agentCount ?? 0 }} 个 Agent</strong>、全部频道、消息、计算机与邀请链接将被
          <strong>永久删除，不可恢复</strong>。
        </p>
        <p class="text-sm text-subtle">
          请输入服务器名称 <span class="font-semibold text-ink">{{ server?.name }}</span> 确认：
        </p>
        <Input
          type="text"
          :value="confirmText"
          :placeholder="server?.name"
          @input="confirmText = ($event.target as HTMLInputElement).value"
        />
        <div class="flex justify-end gap-2 pt-1">
          <Button variant="secondary" @click="confirmOpen = false">取消</Button>
          <Button variant="danger" :loading="deleteBusy" :disabled="!confirmMatched" @click="submitDelete">
            永久删除
          </Button>
        </div>
      </div>
    </Modal>
  </div>
</template>
