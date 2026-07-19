import { useRef, useState, useCallback, useEffect } from "react";
import { uploadAttachment, type UploadedAttachment } from "../../api/client";
import { useMentionSuggest } from "../../hooks/useMentionSuggest";
import { MentionPopup } from "../chat/MentionPopup";
import { Textarea } from "../ui/Textarea";
import { IconButton } from "../ui/IconButton";

export interface ComposerAttachment {
  tempId: string;
  name: string;
  status: "uploading" | "done" | "error";
  uploaded?: UploadedAttachment;
}

interface MessageComposerProps {
  placeholder?: string;
  disabled?: boolean;
  attachments?: ComposerAttachment[];
  onAttachmentsChange?: (attachments: ComposerAttachment[]) => void;
  onSend: (content: string, attachmentIds: string[]) => Promise<void>;
  /** External files dropped by parent (e.g. global drag-over). */
  droppedFiles?: File[] | null;
}

export function MessageComposer({
  placeholder,
  disabled = false,
  attachments: controlledAttachments,
  onAttachmentsChange,
  onSend,
  droppedFiles,
}: MessageComposerProps) {
  const isControlled = controlledAttachments !== undefined;
  const [internalAttachments, setInternalAttachments] = useState<ComposerAttachment[]>([]);
  const attachments = isControlled ? controlledAttachments! : internalAttachments;
  const setAttachments = useCallback(
    (next: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])) => {
      if (isControlled) {
        onAttachmentsChange!(typeof next === "function" ? next(controlledAttachments!) : next);
      } else {
        setInternalAttachments(next);
      }
    },
    [isControlled, onAttachmentsChange, controlledAttachments]
  );

  const [draft, setDraft] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { filtered, selectedIdx, visible, handleInput, handleKeyDown: mentionKD, insertMention: rawInsert } =
    useMentionSuggest(textareaRef);

  const insertMention = (handle: string) => {
    const newText = rawInsert(handle);
    if (newText !== undefined) setDraft(newText);
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const addAttachment = useCallback(
    (file: File) => {
      if (file.size > 10 * 1024 * 1024) {
        const tempId = "att-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
        setAttachments((a) => [...a, { tempId, name: file.name, status: "error" }]);
        return;
      }
      const tempId = "att-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      setAttachments((a) => [...a, { tempId, name: file.name, status: "uploading" }]);
      uploadAttachment(file)
        .then((uploaded) => setAttachments((a) => a.map((x) => (x.tempId === tempId ? { ...x, status: "done", uploaded } : x))))
        .catch(() => setAttachments((a) => a.map((x) => (x.tempId === tempId ? { ...x, status: "error" } : x))));
    },
    [setAttachments]
  );

  useEffect(() => {
    if (!droppedFiles || droppedFiles.length === 0) return;
    for (const file of droppedFiles) addAttachment(file);
  }, [droppedFiles, addAttachment]);

  const handleFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      for (const file of Array.from(files)) addAttachment(file);
    },
    [addAttachment]
  );

  const removeAttachment = (tempId: string) => setAttachments((a) => a.filter((x) => x.tempId !== tempId));

  const doSend = async () => {
    const content = draft.trim();
    if (attachments.some((a) => a.status === "uploading")) return;
    const attachmentIds = attachments
      .filter((a) => a.status === "done" && a.uploaded)
      .map((a) => a.uploaded!.attachmentId);
    if (!content && attachmentIds.length === 0) return;

    setSending(true);
    try {
      await onSend(content, attachmentIds);
      setDraft("");
      setAttachments([]);
      const el = textareaRef.current;
      if (el) el.style.height = "auto";
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    mentionKD(e);
    if (!visible && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    handleInput(e);
    autoResize(e.target);
  };

  const canSend =
    !disabled &&
    !sending &&
    !attachments.some((a) => a.status === "uploading") &&
    (draft.trim().length > 0 || attachments.some((a) => a.status === "done"));

  return (
    <div
      className="relative"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-400 bg-blue-500/10">
          <span className="font-medium text-blue-500">松开以上传文件</span>
        </div>
      )}
      <MentionPopup items={filtered} selectedIdx={selectedIdx} onSelect={insertMention} />
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div
              key={a.tempId}
              className="flex items-center gap-1.5 rounded bg-gray-200 px-2 py-1 text-xs dark:bg-gray-700"
            >
              <span className="max-w-[140px] truncate text-gray-700 dark:text-gray-200">{a.name}</span>
              {a.status === "uploading" && <span className="text-gray-400">上传中…</span>}
              {a.status === "error" && <span className="text-red-500">失败</span>}
              <button
                type="button"
                onClick={() => removeAttachment(a.tempId)}
                className="text-gray-400 hover:text-red-500"
                aria-label="移除附件"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
        />
        <IconButton label="上传文件" tooltip="上传文件" onClick={() => fileInputRef.current?.click()} disabled={disabled || sending}>
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M12 18.75H4.5a2.25 2.25 0 0 1-2.25-2.25V9m12.841 2.091a2.25 2.25 0 0 1 3.18 0l2.87 2.87" />
          </svg>
        </IconButton>
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={(e) => { const files = Array.from(e.clipboardData.files); if (files.length) { e.preventDefault(); handleFiles(files); } }}
          placeholder={placeholder}
          rows={1}
          disabled={disabled || sending}
          className="min-h-[2.5rem] py-2.5"
        />
        <button
          type="button"
          onClick={doSend}
          disabled={!canSend}
          aria-label="发送"
          className={[
            "mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors",
            canSend
              ? "bg-blue-600 text-white hover:bg-blue-500"
              : "cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-gray-700 dark:text-gray-500",
          ].join(" ")}
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
          </svg>
        </button>
      </div>
      <div className="mt-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>Enter 发送 · Shift+Enter 换行 · @ 提及 · 支持拖拽/粘贴上传</span>
        {draft.length > 0 && <span>{draft.length}/4000</span>}
      </div>
    </div>
  );
}
