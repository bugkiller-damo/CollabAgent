import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DIRECTORY_SOURCE_BYTES, mimeTypeForPath, prepareUpload } from "../src/mcp/upload-payload.js";

/**
 * A7.3：upload_attachment 载荷准备——单文件直传 + 目录内存打 zip。
 * 全部用真实临时目录；afterEach 统一清理。
 */

const tempRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "slock-upload-"));
  tempRoots.push(dir);
  return dir;
};

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("prepareUpload（目录 → zip）", () => {
  it("嵌套文件按 POSIX 相对路径进包且内容可回读；隐藏/node_modules 被排除", async () => {
    const root = makeTempDir();
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "main.cpp"), "int main() { return 0; }\n");
    writeFileSync(join(root, "src", "deep", "util.h"), "#pragma once\n");
    writeFileSync(join(root, "README.md"), "# demo\n");
    // 以下应全部被排除
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".hidden"), "x\n");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    // 大小写变体同样排除（Windows 文件系统大小写不敏感）
    mkdirSync(join(root, "Node_Modules"), { recursive: true });
    writeFileSync(join(root, "Node_Modules", "x.js"), "module.exports = 2;\n");
    mkdirSync(join(root, ".config"), { recursive: true });
    writeFileSync(join(root, ".config", "settings.json"), "{}\n");
    mkdirSync(join(root, "src", ".cache"), { recursive: true });
    writeFileSync(join(root, "src", ".cache", "tmp.txt"), "t\n");

    const payload = await prepareUpload(root);
    expect(payload.sourceKind).toBe("directory");
    expect(payload.mimeType).toBe("application/zip");
    expect(payload.filename).toBe(`${basename(root)}.zip`);
    expect(payload.fileCount).toBe(3);

    const entries = unzipSync(payload.bytes);
    const names = Object.keys(entries).sort();
    expect(names).toEqual(["README.md", "src/deep/util.h", "src/main.cpp"]);
    expect(strFromU8(entries["src/main.cpp"]!)).toBe("int main() { return 0; }\n");
    expect(strFromU8(entries["src/deep/util.h"]!)).toBe("#pragma once\n");
    // 排除项断言：任何条目名都不含隐藏段 / node_modules（含大小写变体）
    for (const name of names) {
      expect(name.toLowerCase()).not.toContain("node_modules");
      expect(name.split("/").some((seg) => seg.startsWith("."))).toBe(false);
    }
  });

  it("超过 50MB 未压缩上限的稀疏文件在读入内存前就拒绝（stat 预算闸）", async () => {
    const root = makeTempDir();
    const big = join(root, "huge.bin");
    writeFileSync(big, "");
    // 逻辑大小 > 上限；若实现先 readFile 再判，这里会真的分配 50MB+
    truncateSync(big, MAX_DIRECTORY_SOURCE_BYTES + 1);
    await expect(prepareUpload(root)).rejects.toThrow(/uncompressed/);
  });

  it("空目录（或全部被排除）拒绝", async () => {
    const root = makeTempDir();
    await expect(prepareUpload(root)).rejects.toThrow(/no uploadable files/);

    const onlyHidden = makeTempDir();
    writeFileSync(join(onlyHidden, ".env"), "SECRET=1\n");
    await expect(prepareUpload(onlyHidden)).rejects.toThrow(/no uploadable files/);
  });
});

describe("prepareUpload（单文件）", () => {
  it(".cpp 按 text/plain 上传，字节/fileCount/sourceBytes 精确", async () => {
    const root = makeTempDir();
    const file = join(root, "main.cpp");
    const content = "#include <cstdio>\nint main() { return 0; }\n";
    writeFileSync(file, content);

    const payload = await prepareUpload(file);
    expect(payload.sourceKind).toBe("file");
    expect(payload.filename).toBe("main.cpp");
    expect(payload.mimeType).toBe("text/plain");
    expect(payload.fileCount).toBe(1);
    expect(payload.sourceBytes).toBe(Buffer.byteLength(content));
    expect(payload.bytes.equals(Buffer.from(content))).toBe(true);
  });

  it("不存在的路径报可读错误", async () => {
    const root = makeTempDir();
    await expect(prepareUpload(join(root, "nope.txt"))).rejects.toThrow(/does not exist/);
  });
});

describe("mimeTypeForPath", () => {
  it("覆盖服务端白名单类型 + 源码 text/plain + 未知 octet-stream", () => {
    expect(mimeTypeForPath("a/b/readme.md")).toBe("text/markdown");
    expect(mimeTypeForPath("x.JSON")).toBe("application/json");
    expect(mimeTypeForPath("pack.zip")).toBe("application/zip");
    expect(mimeTypeForPath("report.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(mimeTypeForPath("pic.PNG")).toBe("image/png");
    expect(mimeTypeForPath("main.TS")).toBe("text/plain");
    expect(mimeTypeForPath("Makefile.am")).toBe("application/octet-stream");
    expect(mimeTypeForPath("noext")).toBe("application/octet-stream");
    // 原型链属性不得命中 MIME 表（own-property 查询）
    expect(mimeTypeForPath("x.constructor")).toBe("application/octet-stream");
    expect(mimeTypeForPath("x.toString")).toBe("application/octet-stream");
  });

  it("特殊 basename：Dockerfile / .gitignore → text/plain", () => {
    expect(mimeTypeForPath("proj/Dockerfile")).toBe("text/plain");
    expect(mimeTypeForPath("proj/.gitignore")).toBe("text/plain");
  });
});
