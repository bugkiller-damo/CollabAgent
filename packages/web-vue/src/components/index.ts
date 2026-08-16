// 通用 UI 组件层统一出口：与 packages/web/src/components/ 的导出关系保持同名，
// 页面层可以 `import { Button, ConfirmDialog, MessageSkeleton, ... } from "../components"`。

// ui/ 基础组件（Avatar/Breadcrumb/Button/Card/IconButton/Input/Modal/NavItem/Textarea/Tooltip）
export * from "./ui";

// 骨架屏（Skeleton/MessageSkeleton/ChannelListSkeleton/AgentCardSkeleton）
export * from "./skeleton";

// 顶层纯 UI 组件
export { default as ConfirmDialog } from "./ConfirmDialog.vue";
export { default as EmptyState } from "./EmptyState.vue";
export { default as ErrorBoundary } from "./ErrorBoundary.vue";
export { default as PasswordStrength } from "./PasswordStrength.vue";
// React 版文件名 Toast.tsx、导出名 ToastContainer，桶文件保持导出名不变
export { default as ToastContainer } from "./Toast.vue";

// React 版从 components/PasswordStrength 再导出的纯函数；Vue 版拆到 lib 后在此再导出，保持 import 路径可预期
export { scorePassword, type Strength } from "../lib/passwordStrength";
