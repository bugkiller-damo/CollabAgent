import { AlarmClock, CircleCheck, Mail, MessageCircle, Pin } from "@lucide/vue";
import { type Component, markRaw } from "vue";

/**
 * 通知类型 → 图标组件。NotificationBell（铃铛面板）与 ActivityView（动态页）共用，
 * 消除两处同构 emoji 映射。markRaw：组件对象不进响应式系统（避免渲染开销与
 * Vue 对组件值做 reactive 代理的警告）。
 */
export const NOTIFICATION_TYPE_ICONS: Record<string, Component> = {
  "@mention": markRaw(MessageCircle),
  task_assigned: markRaw(CircleCheck),
  dm: markRaw(Mail),
  reminder: markRaw(AlarmClock),
};

export const NOTIFICATION_FALLBACK_ICON: Component = markRaw(Pin);

/**
 * 通知类型 → 图标底色徽章样式（ActivityView 卡片用；class 字符串静态不进响应式）。
 * chip = 圆角色块底色，icon = 图标前景色。
 */
export interface NotificationTypeStyle {
  chip: string;
  icon: string;
}

export const NOTIFICATION_TYPE_STYLES: Record<string, NotificationTypeStyle> = {
  "@mention": { chip: "bg-blue-100 dark:bg-blue-900/40", icon: "text-blue-600 dark:text-blue-300" },
  task_assigned: { chip: "bg-green-100 dark:bg-green-900/40", icon: "text-green-600 dark:text-green-300" },
  dm: { chip: "bg-purple-100 dark:bg-purple-900/40", icon: "text-purple-600 dark:text-purple-300" },
  reminder: { chip: "bg-amber-100 dark:bg-amber-900/40", icon: "text-amber-600 dark:text-amber-300" },
};

export const NOTIFICATION_FALLBACK_STYLE: NotificationTypeStyle = {
  chip: "bg-gray-100 dark:bg-gray-700",
  icon: "text-gray-500 dark:text-gray-300",
};
