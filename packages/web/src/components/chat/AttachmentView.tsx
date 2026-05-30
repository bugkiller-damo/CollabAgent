import { useState } from "react";

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function isImage(mime: string): boolean {
  return mime?.startsWith("image/");
}

export function AttachmentView({ attachments }: { attachments: Attachment[] }) {
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-1.5">
      {attachments.map((a) =>
        isImage(a.mimeType) ? (
          <img
            key={a.id}
            src={a.url}
            alt={a.filename}
            loading="lazy"
            onClick={() => setLightbox(a)}
            className="max-h-48 max-w-xs rounded border border-gray-200 dark:border-gray-700 cursor-zoom-in object-cover"
          />
        ) : (
          <a
            key={a.id}
            href={a.url}
            download={a.filename}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 p-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 max-w-xs"
          >
            <span className="text-2xl shrink-0">📄</span>
            <span className="min-w-0">
              <span className="block text-sm text-gray-800 dark:text-gray-200 truncate">{a.filename}</span>
              <span className="block text-xs text-gray-400">{formatSize(a.sizeBytes)} · 下载</span>
            </span>
          </a>
        )
      )}

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox.url} alt={lightbox.filename} className="max-h-full max-w-full rounded shadow-lg" />
          <button
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 text-white/80 hover:text-white text-2xl"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
