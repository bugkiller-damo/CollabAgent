import { describe, expect, it } from "vitest";
import { MESSAGE_SPLIT_LIMIT, splitMessageContent } from "../src/mcp/message-split.js";

/**
 * A7.1：send_message 自动拆条纯函数测试。
 * 覆盖：短内容原样返回；段落边界优先；围栏代码块原子化；
 * 超限围栏跨条时补 ``` 收尾/重开；单行超限硬切；每条 ≤ maxLen。
 */

const L = MESSAGE_SPLIT_LIMIT; // 9000

describe("splitMessageContent", () => {
  it("≤ 上限原样返回（含恰好等于上限）", () => {
    const s = "a".repeat(L);
    expect(splitMessageContent(s)).toEqual([s]);
    expect(splitMessageContent("hi")).toEqual(["hi"]);
    expect(splitMessageContent("")).toEqual([""]);
  });

  it("两个超长段落按空行边界拆开，各自 ≤ 上限", () => {
    const p1 = "第一段\n" + "x".repeat(L - 100);
    const p2 = "第二段\n" + "y".repeat(500);
    const chunks = splitMessageContent(`${p1}\n\n${p2}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("第一段");
    expect(chunks[0]).not.toContain("第二段");
    expect(chunks[1]).toContain("第二段");
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(L);
  });

  it("能装下的段落合并进同一条（不浪费消息数）", () => {
    const big = "x".repeat(L - 50); // 8950：big+\n\n+small=9002 超限 → 必须拆
    const small = "y".repeat(50);
    const chunks = splitMessageContent(`${big}\n\n${small}\n\n${small}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toContain(small);
    expect(chunks[1]).toContain("\n\n"); // 两个小段在同一条内以空行相接
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(L);
  });

  it("完整围栏块作为原子块：优先不与段落挤、跨条时不拆开", () => {
    const fence = "```ts\n" + "code\n".repeat(100) + "```"; // ~510 字符
    const p = "x".repeat(L - 300);
    // p + fence > L → fence 独占第二条，且保持完整开闭
    const chunks = splitMessageContent(`${p}\n\n${fence}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe(fence);
    expect(chunks[1].startsWith("```ts")).toBe(true);
    expect(chunks[1].endsWith("```")).toBe(true);
  });

  it("超限围栏被迫跨条：前条补 ``` 收尾、后条按 ```lang 重开，条条合法", () => {
    const body = "c".repeat(L - 500); // 单块围栏体接近上限
    const fence = "```py\n" + `${body}\n${body}\n` + "```"; // 两倍体长 → 必拆
    const chunks = splitMessageContent(fence);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(L);
      // 每条都以围栏行开始、以 ``` 结束
      expect(c.startsWith("```py")).toBe(true);
      expect(c.trimEnd().endsWith("```")).toBe(true);
      // 围栏标记成对（开头 ```py 计 1 个 ```，结尾计 1 个 → 偶数个围栏标记行）
      const marks = c.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
      expect(marks % 2).toBe(0);
    }
  });

  it("单个无换行超长行硬切字符", () => {
    const s = "z".repeat(L + 10);
    const chunks = splitMessageContent(s);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(L);
    expect(chunks[1]).toBe("z".repeat(10));
    expect(chunks.join("")).toBe(s);
  });

  it("混合内容保序：段 → 围栏 → 段", () => {
    const mk = (c: string) => c.repeat(L - 500);
    const content = `${mk("a")}\n\n${"```\n" + mk("b") + "\n```"}\n\n${mk("c")}`;
    const chunks = splitMessageContent(content);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const joined = chunks.join("\n");
    expect(joined.indexOf("aaa")).toBeLessThan(joined.indexOf("bbb"));
    expect(joined.indexOf("bbb")).toBeLessThan(joined.indexOf("ccc"));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(L);
  });

  it("自定义 maxLen 生效", () => {
    const chunks = splitMessageContent("aaaa\n\nbbbb\n\ncccc", 6);
    expect(chunks).toEqual(["aaaa", "bbbb", "cccc"]);
  });
});
