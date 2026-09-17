import { describe, expect, it } from "vitest";
import { previewKind, TEXT_PREVIEW_MAX_BYTES, textPreviewable } from "./attachment-preview";

// F14 预览矩阵判定：与 server INLINE_SAFE_MIME 扩容口径对齐（F13 音视频四类 +
// PDF/text/json 入 inline；SVG/HTML 恒排除、未知 MIME 落下载卡）。

describe("previewKind", () => {
  it("图片系列 → image", () => {
    expect(previewKind("image/jpeg")).toBe("image");
    expect(previewKind("image/webp")).toBe("image");
  });

  it("F13 白名单内音视频 → video/audio", () => {
    expect(previewKind("video/mp4")).toBe("video");
    expect(previewKind("video/webm")).toBe("video");
    expect(previewKind("audio/mpeg")).toBe("audio");
    expect(previewKind("audio/ogg")).toBe("audio");
  });

  it("未入册的音视频容器落 file（走下载）", () => {
    expect(previewKind("video/x-matroska")).toBe("file");
    expect(previewKind("video/quicktime")).toBe("file");
    expect(previewKind("audio/flac")).toBe("file");
  });

  it("PDF → pdf", () => expect(previewKind("application/pdf")).toBe("pdf"));

  it("纯文本/JSON → text；HTML/SVG 恒 file（XSS 排除口径）", () => {
    expect(previewKind("text/plain")).toBe("text");
    expect(previewKind("application/json")).toBe("text");
    expect(previewKind("text/html")).toBe("file");
    expect(previewKind("image/svg+xml")).toBe("file");
  });

  it("空/未知 MIME → file", () => {
    expect(previewKind("")).toBe("file");
    expect(previewKind("application/octet-stream")).toBe("file");
  });
});

describe("textPreviewable", () => {
  it("kind=text 且不超上限 → true", () => {
    expect(textPreviewable("text/plain", 100)).toBe(true);
    expect(textPreviewable("application/json", TEXT_PREVIEW_MAX_BYTES)).toBe(true);
  });

  it("超上限或非 text 一律 false", () => {
    expect(textPreviewable("text/plain", TEXT_PREVIEW_MAX_BYTES + 1)).toBe(false);
    expect(textPreviewable("application/pdf", 100)).toBe(false);
  });
});
