<script setup lang="ts">
import { ChevronRight } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { readCsrf } from "../api";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/layout/PageHeader.vue";
import { resolveNotificationRoute } from "../lib/notification-jump";
import {
  NOTIFICATION_FALLBACK_ICON,
  NOTIFICATION_FALLBACK_STYLE,
  NOTIFICATION_TYPE_ICONS,
  NOTIFICATION_TYPE_STYLES,
  type NotificationTypeStyle,
} from "../lib/type-icons";
import { useChannelStore, useUiStore } from "../stores";
import { type NotificationItem, useNotificationStore } from "../stores/notificationStore";

function timeAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}秒前`;
  if (d < 3600) return `${Math.floor(d / 60)}分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)}小时前`;
  return `${Math.floor(d / 86400)}天前`;
}

/** 分组标签：今天 / 昨天 / M月d日（列表本身按 createdAt 倒序，标签变化即开新组） */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const notificationStore = useNotificationStore();
const channelStore = useChannelStore();
const uiStore = useUiStore();
const router = useRouter();
const filter = ref<"all" | "unread">("all");

const list = computed(() => {
  const all = notificationStore.notifications;
  return filter.value === "unread" ? all.filter((n) => !n.read) : all;
});

interface FeedGroup {
  label: string;
  items: NotificationItem[];
}

const grouped = computed<FeedGroup[]>(() => {
  const out: FeedGroup[] = [];
  for (const n of list.value) {
    const label = dayLabel(n.createdAt);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(n);
    else out.push({ label, items: [n] });
  }
  return out;
});

function iconFor(type: string) {
  return NOTIFICATION_TYPE_ICONS[type] || NOTIFICATION_FALLBACK_ICON;
}

function styleFor(type: string): NotificationTypeStyle {
  return NOTIFICATION_TYPE_STYLES[type] || NOTIFICATION_FALLBACK_STYLE;
}

function jumpable(n: NotificationItem): boolean {
  return resolveNotificationRoute(n, channelStore.channels) !== null;
}

onMounted(() => {
  notificationStore.loadFromApi();
});

async function handleClick(n: NotificationItem) {
  if (!n.read) {
    notificationStore.markAsRead(n.id);
    try {
      await fetch(`/api/notifications/${n.id}/read`, {
        method: "PATCH",
        credentials: "include",
        headers: { "X-CSRF-Token": readCsrf() || "" },
      });
    } catch {
      /* ignore */
    }
  }
  const to = resolveNotificationRoute(n, channelStore.channels);
  if (to) {
    uiStore.openSidebarPane("chat");
    uiStore.closeMobileDrawer();
    void router.push(to);
  }
}

async function handleMarkAll() {
  notificationStore.markAllAsRead();
  try {
    await fetch("/api/notifications/read", {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": readCsrf() || "",
      },
    });
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <PageHeader title="动态" subtitle="提及、任务与提醒">
      <div class="flex items-center gap-2">
        <div class="flex gap-1">
          <button
            type="button"
            :class="[
              'rounded-md px-2 py-1 text-xs',
              filter === 'all' ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-white' : 'text-gray-500',
            ]"
            @click="filter = 'all'"
          >
            全部
          </button>
          <button
            type="button"
            :class="[
              'rounded-md px-2 py-1 text-xs',
              filter === 'unread' ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-white' : 'text-gray-500',
            ]"
            @click="filter = 'unread'"
          >
            未读
          </button>
        </div>
        <button
          v-if="notificationStore.unreadCount > 0"
          type="button"
          class="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400"
          @click="handleMarkAll"
        >
          全部已读
        </button>
      </div>
    </PageHeader>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div
        v-if="notificationStore.loading && notificationStore.notifications.length === 0"
        class="px-4 py-8 text-center text-sm text-gray-500"
      >
        加载中…
      </div>
      <EmptyState v-else-if="list.length === 0" icon="zap" title="暂无动态" description="提及、任务指派和提醒会显示在这里" />
      <div v-else class="mx-auto max-w-3xl px-3 pb-6 sm:px-4">
        <section v-for="g in grouped" :key="g.label">
          <h3 class="px-1 pb-1.5 pt-4 text-xs font-semibold text-muted">{{ g.label }}</h3>
          <div class="space-y-2">
            <button
              v-for="(n, i) in g.items"
              :key="n.id"
              type="button"
              :class="[
                'group flex w-full animate-slide-in-up items-start gap-3 rounded-lg border px-4 py-3 text-left shadow-sm transition-colors duration-150 hover:shadow-md',
                !n.read
                  ? 'border-blue-200 border-l-[3px] border-l-blue-500 bg-blue-50 hover:bg-blue-100/70 dark:border-blue-900/60 dark:border-l-blue-400 dark:bg-blue-900/20 dark:hover:bg-blue-900/30'
                  : 'border-line bg-surface hover:bg-raised',
                jumpable(n) ? 'cursor-pointer' : 'cursor-default',
              ]"
              :style="{ animationDelay: `${Math.min(i, 10) * 20}ms` }"
              @click="handleClick(n)"
            >
              <span :class="['mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded', styleFor(n.type).chip]">
                <component :is="iconFor(n.type)" :class="['h-4 w-4', styleFor(n.type).icon]" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline justify-between gap-2">
                  <p class="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{{ n.title }}</p>
                  <span class="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                    <span v-if="!n.read" class="h-2 w-2 rounded-full bg-blue-500" />
                    {{ timeAgo(n.createdAt) }}
                  </span>
                </div>
                <p v-if="n.body" class="mt-0.5 line-clamp-2 text-sm text-subtle">{{ n.body }}</p>
              </div>
              <ChevronRight
                v-if="jumpable(n)"
                class="h-4 w-4 shrink-0 self-center text-gray-300 opacity-0 transition-opacity group-hover:opacity-100 dark:text-gray-500"
              />
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
