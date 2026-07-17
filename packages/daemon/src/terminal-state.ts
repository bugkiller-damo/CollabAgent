// @xterm/headless 的 CJS 产物是压缩成一行的 bundle，Node ESM 的 cjs-module-lexer
// 静态分析识别不出具名导出，`import { Terminal }` 会在运行时报
// "does not provide an export named 'Terminal'"——必须走默认导入再解构。
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;

/**
 * 轻量终端状态跟踪器。
 *
 * 之前判断"Claude 是不是说完了/输入框是不是就绪"，靠的是对 PTY 从 spawn
 * 起累计的原始字节流做正则扫描（`run.output` 从不清空）。这条路线连续踩了
 * 4 次坑（见 docs/2026-07-16/08-hive-alignment-gap-analysis.md 第 3/5/6/10
 * 个 bug）：同一个字符出现过一次就永远留在"历史"里、不同版本/场景下 Claude
 * 的收尾渲染方式还不统一（有的换行再画提示符，有的光标定位直接画，不带换行）。
 *
 * 用真正的终端模拟器（xterm.js 的 headless 引擎）正确解析这些 ANSI 控制序列
 * （光标定位、清屏、覆盖重绘），维护一份"当前实际渲染出来的屏幕"，而不是原始
 * 字节的流水账。`scrollback: 0` 让滚出可视区域的内容被丢弃——不需要，因为
 * 判断"现在"是不是空闲/忙碌只需要看当前这一帧，不需要历史。
 */
export interface ITerminalState {
  /** 喂入一段 PTY 原始输出（含 ANSI 转义）；onFlushed 在这段数据真正应用到
   *  屏幕缓冲区之后触发（xterm 的 write 对大段输入是异步分块处理的，想在
   *  写入之后立刻读屏幕状态必须等这个回调，不能假设 write() 返回时已经生效）*/
  write(data: string, onFlushed?: () => void): void;
  resize(cols: number, rows: number): void;
  /** 当前渲染出来的整屏文本，按行拼接（去掉每行行尾空白，不过滤空行，保留原始布局） */
  getScreenText(): string;
  dispose(): void;
}

export const createTerminalState = (cols: number, rows: number): ITerminalState => {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });

  return {
    write(data: string, onFlushed?: () => void): void {
      if (onFlushed) term.write(data, onFlushed);
      else term.write(data);
    },
    resize(newCols: number, newRows: number): void {
      term.resize(newCols, newRows);
    },
    getScreenText(): string {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < term.rows; y++) {
        const line = buf.getLine(y);
        lines.push(line ? line.translateToString(true) : "");
      }
      return lines.join("\n");
    },
    dispose(): void {
      term.dispose();
    },
  };
};
