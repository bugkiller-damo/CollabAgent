// ============================================================
// CollabAgent — 基础类型（从 index.ts 提取，避免循环依赖）
// ============================================================

export type UUID = string;
export type ISO8601 = string;
export type Email = string;

export interface PaginationOpts {
  before?: number;
  after?: number;
  around?: UUID;
  limit?: number;
}

export interface Reaction {
  emoji: string;
  userId: UUID;
  createdAt: ISO8601;
}

export interface AttachmentRef {
  id: UUID;
  name: string;
  mimeType: string;
  sizeBytes: number;
}
