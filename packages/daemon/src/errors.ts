/** 从 unknown catch 取值，避免 `(err as any)?.message`。P1.13 顺手收口；P1.14 再统一 Result。 */
export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
