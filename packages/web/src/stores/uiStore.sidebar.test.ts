import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { hasSidebarDetailPane, loadSidebarState, useUiStore } from "./uiStore";

function stubLocalStorage() {
  const map = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  stubLocalStorage();
  setActivePinia(createPinia());
});

describe("loadSidebarState", () => {
  it("缺省 → chat + 展开", () => {
    expect(loadSidebarState()).toEqual({ pane: "chat", open: true });
  });

  it("非法 JSON / 非法 pane → 回退", () => {
    localStorage.setItem("slock.sidebar", "{");
    expect(loadSidebarState()).toEqual({ pane: "chat", open: true });
    localStorage.setItem("slock.sidebar", JSON.stringify({ pane: "nope", open: false }));
    expect(loadSidebarState()).toEqual({ pane: "chat", open: false });
  });

  it("读合法值", () => {
    localStorage.setItem("slock.sidebar", JSON.stringify({ pane: "activity", open: false }));
    expect(loadSidebarState()).toEqual({ pane: "activity", open: false });
  });
});

describe("useUiStore sidebar", () => {
  it("selectSidebarPane 同项已开 → 折叠；另项 → 切换并展开", () => {
    const ui = useUiStore();
    expect(ui.sidebarPane).toBe("chat");
    expect(ui.sidebarOpen).toBe(true);
    ui.selectSidebarPane("chat");
    expect(ui.sidebarOpen).toBe(false);
    ui.selectSidebarPane("search");
    expect(ui.sidebarPane).toBe("search");
    expect(ui.sidebarOpen).toBe(false);
  });

  it("setSidebarPane：有二级栏的面不改开合；搜索/动态强制收起", () => {
    const ui = useUiStore();
    ui.selectSidebarPane("chat");
    expect(ui.sidebarOpen).toBe(false);
    ui.setSidebarPane("tasks");
    expect(ui.sidebarPane).toBe("tasks");
    expect(ui.sidebarOpen).toBe(false);
    ui.openSidebarPane("search");
    expect(ui.sidebarPane).toBe("search");
    expect(ui.sidebarOpen).toBe(false);
    expect(ui.mobileDrawerOpen).toBe(false);
  });

  it("搜索 / 动态 / 成员不占二级栏；聊天 / 任务 / 计算机有 pane", () => {
    expect(hasSidebarDetailPane("search")).toBe(false);
    expect(hasSidebarDetailPane("activity")).toBe(false);
    expect(hasSidebarDetailPane("people")).toBe(false);
    expect(hasSidebarDetailPane("chat")).toBe(true);
    expect(hasSidebarDetailPane("tasks")).toBe(true);
    expect(hasSidebarDetailPane("computers")).toBe(true);
    const ui = useUiStore();
    ui.selectSidebarPane("people");
    expect(ui.sidebarOpen).toBe(false);
    ui.selectSidebarPane("chat");
    expect(ui.sidebarOpen).toBe(true);
  });

  it("移动抽屉在无二级栏的面上回退到聊天", () => {
    const ui = useUiStore();
    ui.setSidebarPane("people");
    ui.openMobileDrawer();
    expect(ui.sidebarPane).toBe("chat");
    expect(ui.mobileDrawerOpen).toBe(true);
  });

  it("toggleSidebar 写入 localStorage", () => {
    const ui = useUiStore();
    ui.toggleSidebar();
    expect(JSON.parse(localStorage.getItem("slock.sidebar") || "{}")).toEqual({
      pane: "chat",
      open: false,
    });
  });
});

describe("useUiStore profile", () => {
  it("openProfile 剥 @ 且同时只保留一份", () => {
    const ui = useUiStore();
    ui.openProfile({ handle: "@alice" });
    expect(ui.profileTarget?.handle).toBe("alice");
    expect(ui.profileTarget?.channelId).toBeUndefined();
    ui.openProfile({ handle: "bob", channelId: "ch-1" });
    expect(ui.profileTarget).toEqual({ handle: "bob", channelId: "ch-1" });
    ui.closeProfile();
    expect(ui.profileTarget).toBeNull();
  });

  it("requestMention / consumeMention", () => {
    const ui = useUiStore();
    ui.requestMention("@coder");
    expect(ui.pendingMention).toBe("coder");
    expect(ui.consumeMention()).toBe("coder");
    expect(ui.pendingMention).toBeNull();
    expect(ui.consumeMention()).toBeNull();
  });
});
