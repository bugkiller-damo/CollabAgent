/**
 * A7.1：send_message 长消息自动拆条（纯函数，供 slock-mcp-server.ts 与测试共用）。
 *
 * 服务端上限 10_000 字符（MAX_MESSAGE_CONTENT_LEN，超限 400）。拆条策略：
 * - 优先在「块」边界切：代码围栏（```…```）算一个原子块；其余按空行分段。
 * - 单块超限才进块内按行切；单行仍超限才硬切字符。
 * - 代码围栏被迫跨条时，前一条补收尾 ```、后一条补 ```lang 重开，
 *   保证每条都是合法 markdown。
 */

export const MESSAGE_SPLIT_LIMIT = 9_000;

interface Block {
  text: string;
  /** 完整围栏块（``` 开 … ``` 合）——不可在边界上被拆开之外不受特殊处理 */
  isFence: boolean;
}

/** 把正文切成原子块：围栏块（含未成对围栏的尾部）或空行分隔的段落。 */
const splitBlocks = (content: string): Block[] => {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let cur: string[] = [];
  let inFence = false;

  const flush = (isFence: boolean) => {
    if (cur.length === 0) return;
    const text = cur.join("\n");
    if (text.trim()) blocks.push({ text, isFence });
    cur = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trimStart())) {
      if (!inFence) {
        // 围栏开始：先结算之前的段落块
        flush(false);
        inFence = true;
        cur.push(line);
        continue;
      }
      // 围栏结束：连同本行结算为原子围栏块
      cur.push(line);
      flush(true);
      inFence = false;
      continue;
    }
    if (!inFence && !line.trim()) {
      flush(false);
      continue;
    }
    cur.push(line);
  }
  flush(inFence);
  return blocks;
};

/** 围栏块按行切：跨条处补 ``` 收尾 / 重开。lines[0] 是开头的 ```lang。 */
const splitFenceBlock = (text: string, maxLen: number): string[] => {
  const lines = text.split("\n");
  const openLine = lines[0] ?? "```";
  const out: string[] = [];
  let cur = openLine + "\n";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const projected = cur.length + line.length + 1 + 4; // +4: 可能的收尾 ```
    if (projected > maxLen && cur.trim() !== openLine.trim()) {
      out.push(cur + "```");
      cur = openLine + "\n" + line + "\n";
    } else {
      cur += line + "\n";
    }
  }
  const tail = cur.replace(/\n$/, "");
  out.push(tail.endsWith("```") ? tail : tail + "\n```");
  return out;
};

/** 非围栏超限块：按行切，单行仍超限则硬切字符。 */
const splitParagraphBlock = (text: string, maxLen: number): string[] => {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > maxLen) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < line.length; i += maxLen) out.push(line.slice(i, i + maxLen));
      continue;
    }
    const projected = cur ? cur.length + 1 + line.length : line.length;
    if (projected > maxLen && cur) {
      out.push(cur);
      cur = line;
    } else {
      cur = cur ? cur + "\n" + line : line;
    }
  }
  if (cur) out.push(cur);
  return out;
};

/** 单块超限时按块类型分流。 */
const splitOversizedBlock = (block: Block, maxLen: number): string[] =>
  block.isFence ? splitFenceBlock(block.text, maxLen) : splitParagraphBlock(block.text, maxLen);

/**
 * content 超限时拆成多条（每条 ≤ maxLen），否则原样返回 [content]。
 * 保序；空内容返回 [content]（交给上层/服务端按原语义处理）。
 */
export const splitMessageContent = (content: string, maxLen = MESSAGE_SPLIT_LIMIT): string[] => {
  if (content.length <= maxLen) return [content];
  const out: string[] = [];
  let cur = "";
  for (const block of splitBlocks(content)) {
    const piece = block.text;
    const projected = cur ? cur.length + 2 + piece.length : piece.length; // 块间 \n\n
    if (piece.length > maxLen) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(...splitOversizedBlock(block, maxLen));
      continue;
    }
    if (projected > maxLen && cur) {
      out.push(cur);
      cur = piece;
    } else {
      cur = cur ? cur + "\n\n" + piece : piece;
    }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [content];
};
