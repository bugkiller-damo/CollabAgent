import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

vi.mock("../api", () => ({ apiGet: vi.fn() }));

import { apiGet } from "../api";
import { useMentionSuggest } from "./useMentionSuggest";

const apiGetMock = vi.mocked(apiGet);

// #18：node 环境无 DOM——@ 检测（光标回溯/截断）、过滤派生、键盘导航为纯逻辑可测；
// insertMention（HTMLTextAreaElement 原生 setter hack）与 document mousedown 处理为 DOM 绑定取舍不测。
function stubTextarea(value: string, cursor = value.length) {
  return { value, selectionStart: cursor, contains: () => false } as unknown as HTMLTextAreaElement;
}

const inputEvent = (value: string) => ({ target: { value } }) as unknown as Event;

beforeEach(() => {
  vi.clearAllMocks();
  // mentionActive→true 时注册 document mousedown 监听（node 无 document，stub 之）
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  // 无组件实例的 onMounted 仅 dev 告警并跳过注册，属预期；静音避免噪音
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockPublicDirectory() {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === "/api/agents") return { agents: [{ name: "alice", display_name: "Alice", id: "a1" }] } as any;
    if (url === "/api/server/info") return { humans: [{ handle: "bob", id: "h1" }] } as any; // 无 display_name → 回退 handle
    throw new Error(`unexpected url ${url}`);
  });
}

describe("useMentionSuggest @ 检测与过滤", () => {
  it("光标前未闭合 @ 触发弹窗：提取 query、合并 agent+human 并按输入过滤", async () => {
    mockPublicDirectory();
    const ta = ref(stubTextarea("@", 1));
    const sug = useMentionSuggest(ta);

    sug.handleInput(inputEvent("@")); // q==="" → 重拉候选
    await vi.waitFor(() => expect(sug.visible.value).toBe(true)); // 候选到位，query 空全量可见
    expect(apiGetMock).toHaveBeenCalledTimes(2); // /api/agents + /api/server/info

    ta.value = stubTextarea("@al", 3);
    sug.handleInput(inputEvent("@al"));
    await new Promise((r) => setTimeout(r, 0));
    expect(sug.filtered.value.map((c) => c.handle)).toEqual(["alice"]);
    expect(sug.filtered.value[0]?.type).toBe("agent");
  });

  it("@ 词被空格隔断后回溯不命中：弹窗关闭且 filtered 清空", async () => {
    mockPublicDirectory();
    const ta = ref(stubTextarea("@", 1));
    const sug = useMentionSuggest(ta);
    sug.handleInput(inputEvent("@"));
    await vi.waitFor(() => expect(sug.visible.value).toBe(true));

    ta.value = stubTextarea("@al hi", 6);
    sug.handleInput(inputEvent("@al hi")); // 回溯遇空格截断（@ 在前一词）→ 无提及
    await new Promise((r) => setTimeout(r, 0));
    expect(sug.visible.value).toBe(false);
    expect(sug.filtered.value).toEqual([]);
  });

  it("新 @ 会话（query 为空）重拉候选：频道刚加的成员立刻可 @", async () => {
    mockPublicDirectory();
    const ta = ref(stubTextarea("@", 1));
    const sug = useMentionSuggest(ta);

    sug.handleInput(inputEvent("@"));
    await vi.waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(2));

    ta.value = stubTextarea("done", 4);
    sug.handleInput(inputEvent("done")); // 关闭
    await new Promise((r) => setTimeout(r, 0));

    ta.value = stubTextarea("@", 1);
    sug.handleInput(inputEvent("@")); // 新 @ 会话再拉
    await vi.waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(4));
  });
});

describe("useMentionSuggest 键盘导航", () => {
  it("ArrowDown/ArrowUp 在 filtered 边界内移动不越界（并 preventDefault）", async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === "/api/agents") {
        return {
          agents: [
            { name: "alice", display_name: "Alice", id: "a1" },
            { name: "alina", display_name: "Alina", id: "a2" },
          ],
        } as any;
      }
      if (url === "/api/server/info") return { humans: [] } as any;
      throw new Error(`unexpected url ${url}`);
    });

    const ta = ref(stubTextarea("@", 1));
    const sug = useMentionSuggest(ta);
    sug.handleInput(inputEvent("@"));
    await vi.waitFor(() => expect(sug.visible.value).toBe(true));
    expect(sug.filtered.value).toHaveLength(2);

    const pd = vi.fn();
    const key = (k: string) => sug.handleKeyDown({ key: k, preventDefault: pd } as unknown as KeyboardEvent);

    key("ArrowDown");
    expect(sug.selectedIdx.value).toBe(1);
    key("ArrowDown");
    expect(sug.selectedIdx.value).toBe(1); // 尾部不越界
    key("ArrowUp");
    expect(sug.selectedIdx.value).toBe(0);
    key("ArrowUp");
    expect(sug.selectedIdx.value).toBe(0); // 顶部不越界
    expect(pd).toHaveBeenCalledTimes(4);
  });

  it("Escape 关闭弹窗（visible false + filtered 清空）", async () => {
    mockPublicDirectory();
    const ta = ref(stubTextarea("@", 1));
    const sug = useMentionSuggest(ta);
    sug.handleInput(inputEvent("@"));
    await vi.waitFor(() => expect(sug.visible.value).toBe(true));

    sug.handleKeyDown({ key: "Escape" } as unknown as KeyboardEvent);
    await new Promise((r) => setTimeout(r, 0));
    expect(sug.visible.value).toBe(false);
    expect(sug.filtered.value).toEqual([]);
  });
});

describe("useMentionSuggest scope 语义", () => {
  it("私有频道：走 members 端点，member 字段映射（display_name 回退、无 handle 跳过）", async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/channels/")) {
        return {
          members: [
            { handle: "carol", display_name: "", member_type: "agent", member_id: "m1", duty: "on" },
            { handle: "", member_id: "m2" }, // 无 handle 跳过
          ],
        } as any;
      }
      throw new Error(`unexpected url ${url}`);
    });

    const scope = ref({ channelId: "c1", channelType: "private" });
    const ta = ref(stubTextarea("@", 1));
    const sug = useMentionSuggest(ta, scope);

    sug.handleInput(inputEvent("@"));
    await vi.waitFor(() => expect(sug.visible.value).toBe(true));
    expect(apiGetMock).toHaveBeenCalledWith("/api/channels/c1/members");
    expect(sug.filtered.value).toEqual([
      { handle: "carol", displayName: "carol", type: "agent", id: "m1", duty: "on" },
    ]);
  });

  it("私有频道但 channelId 未加载 → 不发请求不给候选（防短暂展示全量）", async () => {
    const scope = ref({ channelType: "private" });
    const ta = ref(stubTextarea("@", 1));
    const sug = useMentionSuggest(ta, scope);

    sug.handleInput(inputEvent("@"));
    await new Promise((r) => setTimeout(r, 0));
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(sug.visible.value).toBe(false);
  });

  it("scope 变化（切频道）重载候选（React useCallback deps 语义）", async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/channels/")) return { members: [{ handle: "carol", member_id: "m1" }] } as any;
      throw new Error(`unexpected url ${url}`);
    });

    const scope = ref({ channelId: "c1", channelType: "private" });
    const ta = ref(stubTextarea("@", 1));
    const sug = useMentionSuggest(ta, scope);
    sug.handleInput(inputEvent("@"));
    await vi.waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));

    scope.value = { channelId: "c2", channelType: "private" }; // 切频道 → watch 重载
    await vi.waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(2));
    expect(apiGetMock).toHaveBeenLastCalledWith("/api/channels/c2/members");
  });
});
