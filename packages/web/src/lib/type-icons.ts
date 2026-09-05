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
