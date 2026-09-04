/**
 * 消息正文上限（字符）——与 server `src/lib/validators.ts` 的 MAX_MESSAGE_CONTENT_LEN 对齐（P1.33/W-A2）。
 * server 是唯一强制点（send/edit 双侧 400），前端只做预检与计数提示。
 */
export const MAX_MESSAGE_CONTENT_LEN = 10_000;
