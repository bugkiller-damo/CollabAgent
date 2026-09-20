import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { zipSync } from "fflate";

/**
 * A7.3：upload_attachment 的上传载荷准备——单文件直读；目录在内存里打成 zip。
 *
 * 设计要点：
 * - 大小闸口在 HTTP 之前：单文件 / 打包后 zip 都不得超过服务端 MAX_UPLOAD_SIZE
 *   （10MB，见 server lib/config.ts），提前拒掉给出可读错误，而不是让 agent
 *   收到一条 413 后盲目重试。
 * - 目录收集做防御性裁剪：隐藏段（任一 `.` 开头路径段）、`node_modules`、
 *   符号链接一律跳过——交付物目录里这三类最常见也最不该外发（`.env` 凭据、
 *   依赖目录体积爆炸、链接逃逸根目录）。
 * - MIME 白名单在服务端（ALLOWED_MIME_TYPES，fail-closed 415）：这里按扩展名
 *   给出正确 MIME，源码类映射 text/plain——此前一律 octet-stream 导致 .cpp/.ts
 *   被 415 拒收。未知扩展名照传 octet-stream，由服务端返回它自己的 415。
 */

/** 服务端 MAX_UPLOAD_SIZE 的客户端镜像（10MB）：单文件与 zip 包共用此上限 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 目录打包前未压缩字节上限：防止把巨型目录整个读进内存 */
export const MAX_DIRECTORY_SOURCE_BYTES = 50 * 1024 * 1024;
/** 目录打包文件数上限 */
export const MAX_DIRECTORY_FILES = 1_000;

export interface UploadPayload {
  bytes: Buffer;
  filename: string;
  mimeType: string;
  sourceKind: "file" | "directory";
  fileCount: number;
  /** 原始来源字节数：单文件 = 文件大小；目录 = 未压缩总字节 */
  sourceBytes: number;
}

/** 服务端默认 MIME 白名单覆盖（见 server lib/config.ts ALLOWED_MIME_TYPES） */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 源码 / 文本扩展名一律按 text/plain 上传（在白名单内且语义正确） */
const TEXT_PLAIN_EXTS = new Set([
  "txt",
  "log",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "hxx",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "kts",
  "swift",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "sql",
  "ini",
  "cfg",
  "conf",
  "env",
  "gitignore",
  "dockerfile",
]);

/** 无扩展名但应按文本处理的特殊文件名（大小写不敏感） */
const TEXT_PLAIN_BASENAMES = new Set(["dockerfile", ".gitignore"]);

export function mimeTypeForPath(path: string): string {
  const base = basename(path).toLowerCase();
  if (TEXT_PLAIN_BASENAMES.has(base)) return "text/plain";
  const ext = extname(path).slice(1).toLowerCase();
  // own-property 查询：扩展名是外部输入，不能沿原型链命中（"constructor" 等）
  const mapped = Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : undefined;
  if (mapped) return mapped;
  if (TEXT_PLAIN_EXTS.has(ext)) return "text/plain";
  return "application/octet-stream";
}

/** 目录收集时跳过的路径段：`.` 开头（隐藏文件/目录）与 node_modules（大小写不敏感） */
const isSkippedSegment = (name: string): boolean => name.startsWith(".") || name.toLowerCase() === "node_modules";

/**
 * 递归收集目录下的常规文件（相对根目录排序后稳定为字典序）。
 * 跳过符号链接 / 隐藏段 / node_modules；返回 [archiveName, absolutePath] 列表，
 * archiveName 为 POSIX 相对路径。
 */
async function collectDirectoryFiles(root: string): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (isSkippedSegment(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        out.push([rel, full]);
        // 文件数闸口在遍历中即时生效：巨型树不能全量走完才拒
        if (out.length > MAX_DIRECTORY_FILES) {
          throw new Error(
            `upload_attachment: directory exceeds ${MAX_DIRECTORY_FILES} files (max ${MAX_DIRECTORY_FILES}): ${root}`,
          );
        }
      }
      // 其它类型（socket/fifo 等）跳过
    }
  };
  await walk(root);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/**
 * 把本地文件或目录准备成可上传载荷。
 * - 文件：读入内存，>10MB 提前拒；MIME 按扩展名映射（未知 → octet-stream，
 *   由服务端返回常规 415，不在此猜测内容）。
 * - 目录：递归收集常规文件打 zip（排除隐藏/node_modules/符号链接），
 *   1000 文件 / 50MB 未压缩 / 10MB 压缩后三道闸。
 */
export async function prepareUpload(path: string): Promise<UploadPayload> {
  const root = resolve(path);
  const st = await lstat(root).catch(() => {
    throw new Error(`upload_attachment: path does not exist or is unreadable: ${path}`);
  });
  // 根路径拒绝符号链接：防止把白名单语义绕到任意指向（尤其目录递归时的逃逸）
  if (st.isSymbolicLink()) {
    throw new Error(`upload_attachment: refusing to upload a symlink: ${path}`);
  }

  if (st.isFile()) {
    if (st.size > MAX_UPLOAD_BYTES) {
      throw new Error(`upload_attachment: file too large (${st.size} bytes, max ${MAX_UPLOAD_BYTES}): ${path}`);
    }
    const bytes = await readFile(root);
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new Error(`upload_attachment: file too large (${bytes.length} bytes, max ${MAX_UPLOAD_BYTES}): ${path}`);
    }
    return {
      bytes,
      filename: basename(root),
      mimeType: mimeTypeForPath(root),
      sourceKind: "file",
      fileCount: 1,
      sourceBytes: bytes.length,
    };
  }

  if (st.isDirectory()) {
    const collected = await collectDirectoryFiles(root);
    if (collected.length === 0) {
      throw new Error(`upload_attachment: directory has no uploadable files: ${path}`);
    }
    if (collected.length > MAX_DIRECTORY_FILES) {
      throw new Error(
        `upload_attachment: directory has ${collected.length} files (max ${MAX_DIRECTORY_FILES}): ${path}`,
      );
    }
    const files: Record<string, Uint8Array> = {};
    let sourceBytes = 0;
    for (const [rel, full] of collected) {
      // 收集与读取之间文件可能被删/换成链接/增长——读前 lstat 复核：
      // 不再是常规文件就跳过；按 stat 大小先做预算闸，避免把巨型文件
      // 整个读进内存后才发现超未压缩上限。
      const fileStat = await lstat(full).catch(() => null);
      if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
      if (sourceBytes + fileStat.size > MAX_DIRECTORY_SOURCE_BYTES) {
        throw new Error(
          `upload_attachment: directory exceeds ${MAX_DIRECTORY_SOURCE_BYTES} bytes uncompressed: ${path}`,
        );
      }
      const content = await readFile(full);
      sourceBytes += content.length;
      // stat 后文件仍可能增长——读后再按实际字节复核一次
      if (sourceBytes > MAX_DIRECTORY_SOURCE_BYTES) {
        throw new Error(
          `upload_attachment: directory exceeds ${MAX_DIRECTORY_SOURCE_BYTES} bytes uncompressed: ${path}`,
        );
      }
      files[rel] = content;
    }
    const fileCount = Object.keys(files).length;
    if (fileCount === 0) {
      throw new Error(`upload_attachment: directory has no uploadable files: ${path}`);
    }
    const zipped = Buffer.from(zipSync(files, { level: 6 }));
    if (zipped.length > MAX_UPLOAD_BYTES) {
      throw new Error(
        `upload_attachment: zipped directory too large (${zipped.length} bytes, max ${MAX_UPLOAD_BYTES}): ${path}`,
      );
    }
    return {
      bytes: zipped,
      filename: `${basename(root) || "deliverables"}.zip`,
      mimeType: "application/zip",
      sourceKind: "directory",
      fileCount,
      sourceBytes,
    };
  }

  throw new Error(`upload_attachment: path is neither a file nor a directory: ${path}`);
}
