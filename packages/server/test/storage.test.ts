import { describe, expect, it } from "vitest";
import { newStorageKey, resolveStorageBackend, sanitizeFilename } from "../src/lib/storage.js";

// O4 对象存储抽象：key 净化/生成与后端选择的纯函数单测。

describe("sanitizeFilename", () => {
  it("路径分隔符替换为下划线", () => {
    expect(sanitizeFilename("a/b\\c.txt")).toBe("a_b_c.txt");
  });

  it("去除控制字符", () => {
    expect(sanitizeFilename("a\u0000b\u001fc\nd\u007f")).toBe("abcd");
  });

  it("截断到 128 字符", () => {
    expect(sanitizeFilename("x".repeat(200))).toBe("x".repeat(128));
  });

  it('"." 回退 file', () => {
    expect(sanitizeFilename(".")).toBe("file");
  });

  it('".." 回退 file', () => {
    expect(sanitizeFilename("..")).toBe("file");
  });

  it("空串回退 file", () => {
    expect(sanitizeFilename("")).toBe("file");
  });

  it("首尾空白修剪", () => {
    expect(sanitizeFilename("  name.txt  ")).toBe("name.txt");
  });
});

describe("newStorageKey", () => {
  it("uuid 前缀 + 净化文件名", () => {
    expect(newStorageKey("hello.png")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/hello\.png$/,
    );
  });

  it("文件名经过净化", () => {
    expect(newStorageKey("a/b\\c.txt")).toMatch(/\/a_b_c\.txt$/);
  });

  it("两次调用不重复", () => {
    expect(newStorageKey("a.txt")).not.toBe(newStorageKey("a.txt"));
  });
});

describe("resolveStorageBackend", () => {
  it("缺省 local", () => {
    expect(resolveStorageBackend(undefined)).toBe("local");
  });

  it("空串 local", () => {
    expect(resolveStorageBackend("")).toBe("local");
  });

  it("local 原样", () => {
    expect(resolveStorageBackend("local")).toBe("local");
  });

  it("s3 归一 s3", () => {
    expect(resolveStorageBackend("s3")).toBe("s3");
  });

  it("大小写不敏感", () => {
    expect(resolveStorageBackend("S3")).toBe("s3");
  });

  it("minio 归一 s3", () => {
    expect(resolveStorageBackend("minio")).toBe("s3");
  });

  it("未知值降级 local", () => {
    expect(resolveStorageBackend("gcs")).toBe("local");
    expect(resolveStorageBackend("ftp")).toBe("local");
  });
});
