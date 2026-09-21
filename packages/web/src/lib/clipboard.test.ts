import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

// vitest node 环境无 navigator.clipboard / document——全部经 vi.stubGlobal 模拟。
// execResult=false 模拟 execCommand("copy") 返回 false 的失败分支。
function stubDocument(execResult = true) {
  const ta = {
    value: "",
    style: {} as Record<string, string>,
    select: vi.fn(),
    remove: vi.fn(),
  };
  const doc = {
    createElement: vi.fn(() => ta),
    body: { appendChild: vi.fn() },
    execCommand: vi.fn(() => execResult),
  };
  vi.stubGlobal("document", doc);
  return { doc, ta };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("native clipboard 成功：不触碰 execCommand 兜底", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { doc } = stubDocument();
    await copyText("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(doc.createElement).not.toHaveBeenCalled();
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it("native clipboard reject：document 在则回退 execCommand 成功", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { doc, ta } = stubDocument();
    await copyText("hi");
    expect(writeText).toHaveBeenCalledWith("hi");
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(ta.remove).toHaveBeenCalled();
  });

  it("无 native clipboard：直接走 execCommand 兜底", async () => {
    vi.stubGlobal("navigator", {});
    const { doc, ta } = stubDocument();
    await copyText("x");
    expect(doc.createElement).toHaveBeenCalledWith("textarea");
    expect(ta.select).toHaveBeenCalled();
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(ta.remove).toHaveBeenCalled();
  });

  it("execCommand 返回 false：reject 且 textarea 仍被移除", async () => {
    vi.stubGlobal("navigator", {});
    const { ta } = stubDocument(false);
    await expect(copyText("x")).rejects.toThrow("copy failed");
    expect(ta.remove).toHaveBeenCalled();
  });

  it("navigator/document 均不存在：reject clipboard unavailable", async () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("document", undefined);
    await expect(copyText("x")).rejects.toThrow("clipboard unavailable");
  });
});
