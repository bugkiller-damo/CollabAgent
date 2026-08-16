// chat 组件族共享类型。
// React 版分别从 PendingRow.tsx / VirtualMessageList.tsx / AttachmentView.tsx 导出，
// 这里集中到 chat/types.ts，供各组件与页面层按 `import type { ... } from "./chat/types"` 引用。

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export interface PendingItem {
  tempId: string;
  content: string;
  status: "sending" | "failed" | "queued";
}

export type ListItem = { kind: "msg"; data: any } | { kind: "pending"; data: PendingItem };
