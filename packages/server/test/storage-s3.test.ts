import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { type S3ClientLike, S3Storage } from "../src/lib/storage-s3.js";

// O4 子任务 A：S3/MinIO 后端纯单测（fake client，不连网）。
// fake 记录 send 收到的命令，按 key 返回预设 Buffer 或 404/NoSuchKey。

const OPTS = {
  endpoint: "http://minio:9000",
  region: "us-east-1",
  bucket: "slock-dev",
  accessKey: "slockadmin",
  secretKey: "slockadmin123",
  forcePathStyle: true,
  publicBaseUrl: "",
};

function noSuchKey(): Error {
  return Object.assign(new Error("NoSuchKey: The specified key does not exist."), { name: "NoSuchKey" });
}

interface FakeClient {
  client: S3ClientLike;
  commands: unknown[];
}

function makeFake(bodies: Record<string, Buffer> = {}, errors: Record<string, unknown> = {}): FakeClient {
  const commands: unknown[] = [];
  const client: S3ClientLike = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof DeleteObjectCommand) {
        const err = errors[command.input.Key];
        if (err) throw err;
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const err = errors[command.input.Key];
        if (err) throw err;
        const body = bodies[command.input.Key];
        if (body === undefined) return { statusCode: 404 };
        return { statusCode: 200, Body: { transformToByteArray: async () => body } };
      }
      if (command instanceof PutObjectCommand) {
        return { ETag: '"fake-etag"' };
      }
      return {};
    },
  };
  return { client, commands };
}

describe("S3Storage", () => {
  it("save 发出 PutObjectCommand 且 Bucket/Key/Body 正确", async () => {
    const { client, commands } = makeFake();
    const storage = new S3Storage(OPTS, client);
    const data = Buffer.from("hello 世界");
    await storage.save("abc/测试 file.txt", data);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    const cmd = commands[0] as PutObjectCommand;
    expect(cmd.input.Bucket).toBe("slock-dev");
    expect(cmd.input.Key).toBe("abc/测试 file.txt");
    expect(cmd.input.Body).toBe(data);
  });

  it("read 通过 transformToByteArray 转 Buffer", async () => {
    const expected = Buffer.from([0, 1, 2, 255]);
    const { client, commands } = makeFake({ "k/1.bin": expected });
    const storage = new S3Storage(OPTS, client);

    await expect(storage.read("k/1.bin")).resolves.toEqual(expected);
    expect(commands[0]).toBeInstanceOf(GetObjectCommand);
    expect((commands[0] as GetObjectCommand).input.Key).toBe("k/1.bin");
  });

  it("read 兼容 Body 直接是 Buffer 的响应", async () => {
    const expected = Buffer.from("raw buffer body");
    const commands: unknown[] = [];
    const client: S3ClientLike = {
      async send(command: unknown) {
        commands.push(command);
        return { statusCode: 200, Body: expected };
      },
    };
    const storage = new S3Storage(OPTS, client);

    await expect(storage.read("k/raw")).resolves.toEqual(expected);
  });

  it("read 404 响应抛带 not found 的错误", async () => {
    const { client } = makeFake();
    const storage = new S3Storage(OPTS, client);

    await expect(storage.read("missing")).rejects.toThrow(/not found/i);
  });

  it("read SDK NoSuchKey 异常转 not found", async () => {
    const { client } = makeFake({}, { gone: noSuchKey() });
    const storage = new S3Storage(OPTS, client);

    await expect(storage.read("gone")).rejects.toThrow(/not found/i);
  });

  it("read 其它错误原样上抛", async () => {
    const denied = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    const { client } = makeFake({}, { locked: denied });
    const storage = new S3Storage(OPTS, client);

    await expect(storage.read("locked")).rejects.toThrow(/Access Denied/);
  });

  it("remove 发出 DeleteObjectCommand", async () => {
    const { client, commands } = makeFake();
    const storage = new S3Storage(OPTS, client);

    await expect(storage.remove("k/x.txt")).resolves.toBeUndefined();
    expect(commands[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((commands[0] as DeleteObjectCommand).input.Key).toBe("k/x.txt");
  });

  it("remove 幂等：NoSuchKey 吞掉", async () => {
    const { client } = makeFake({}, { ghost: noSuchKey() });
    const storage = new S3Storage(OPTS, client);

    await expect(storage.remove("ghost")).resolves.toBeUndefined();
  });

  it("remove 幂等：404 状态码错误吞掉", async () => {
    const notFound404 = Object.assign(new Error("Not Found"), { statusCode: 404 });
    const { client } = makeFake({}, { ghost404: notFound404 });
    const storage = new S3Storage(OPTS, client);

    await expect(storage.remove("ghost404")).resolves.toBeUndefined();
  });

  it("remove 其它错误向上抛", async () => {
    const denied = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    const { client } = makeFake({}, { locked: denied });
    const storage = new S3Storage(OPTS, client);

    await expect(storage.remove("locked")).rejects.toThrow(/Access Denied/);
  });

  it("publicUrl 配置 publicBaseUrl 时拼直链并去尾斜杠", () => {
    const storage = new S3Storage({ ...OPTS, publicBaseUrl: "https://cdn.example.com/" }, makeFake().client);
    expect(storage.publicUrl("a b/c d.txt")).toBe("https://cdn.example.com/a%20b/c%20d.txt");
  });

  it("publicUrl 逐段编码保留斜杠分隔", () => {
    const storage = new S3Storage({ ...OPTS, publicBaseUrl: "https://cdn.example.com" }, makeFake().client);
    expect(storage.publicUrl("图 片/名 称.png")).toBe(
      "https://cdn.example.com/%E5%9B%BE%20%E7%89%87/%E5%90%8D%20%E7%A7%B0.png",
    );
  });

  it("publicUrl 无 publicBaseUrl 时返回服务端代理路径", () => {
    const storage = new S3Storage(OPTS, makeFake().client);
    expect(storage.publicUrl("a/b c.txt")).toBe("/api/attachments/by-key?key=a%2Fb%20c.txt");
  });

  it("构造参数缺失时抛中文错误并列出缺失项", () => {
    expect(() => new S3Storage({ ...OPTS, endpoint: "" })).toThrow(/S3_ENDPOINT/);
    expect(() => new S3Storage({ ...OPTS, bucket: "" })).toThrow(/S3_BUCKET/);

    let caught: unknown;
    try {
      new S3Storage({ ...OPTS, endpoint: "", bucket: "", accessKey: "", secretKey: "" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    for (const name of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) {
      expect(message).toContain(name);
    }
  });

  it("region/forcePathStyle/publicBaseUrl 缺失不阻塞构造", () => {
    const storage = new S3Storage({ ...OPTS, region: "", publicBaseUrl: "", forcePathStyle: false }, makeFake().client);
    expect(storage.publicUrl("k")).toBe("/api/attachments/by-key?key=k");
  });
});
