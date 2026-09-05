import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import type { ObsFrame } from "./terminalStore";
import { useTerminalStore } from "./terminalStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

function frame(seq: number, agentName = "alpha"): ObsFrame {
  return { agentName, seq, timestamp: seq, kind: "text", turnId: null, payload: { text: `t${seq}` } };
}

describe("terminalStore 实时帧", () => {
  it("setFrame/setHistory 按 agentName 写入且互不覆盖", () => {
    const store = useTerminalStore();
    store.setFrame("alpha", { screen: "s1", status: "running" });
    store.setFrame("beta", { screen: "s2", status: "idle" });
    store.setHistory("alpha", "log-a");

    expect(store.frames.alpha).toEqual({ screen: "s1", status: "running" });
    expect(store.frames.beta?.screen).toBe("s2");
    expect(store.histories.alpha).toBe("log-a");
    expect(store.histories.beta).toBeUndefined();
  });
});

// OBS_CAP=500：实时追加与 replay 回放共用同一上限（与 daemon replay buffer 对齐）
describe("terminalStore 观察帧缓冲（B1）", () => {
  it("appendObsFrame 追加；超过 500 截断保尾部（丢最旧）", () => {
    const store = useTerminalStore();
    for (let i = 1; i <= 505; i++) {
      store.appendObsFrame("alpha", frame(i));
    }

    const arr = store.obsFrames.alpha!;
    expect(arr).toHaveLength(500);
    expect(arr[0].seq).toBe(6); // 前 5 帧被挤出
    expect(arr.at(-1)?.seq).toBe(505);
  });

  it("setObsHistory 回放 slice(-500)：600 帧只留尾部 500", () => {
    const store = useTerminalStore();
    const batch = Array.from({ length: 600 }, (_, i) => frame(i + 1));
    store.setObsHistory("alpha", batch);

    const arr = store.obsFrames.alpha!;
    expect(arr).toHaveLength(500);
    expect(arr[0].seq).toBe(101);
    expect(arr.at(-1)?.seq).toBe(600);
  });

  it("setObsHistory 不足上限原样保留；不同 agent 缓冲隔离", () => {
    const store = useTerminalStore();
    store.setObsHistory("alpha", [frame(1), frame(2)]);
    store.appendObsFrame("beta", frame(1, "beta"));

    expect(store.obsFrames.alpha).toHaveLength(2);
    expect(store.obsFrames.beta).toHaveLength(1);
    expect(store.obsFrames.beta![0].agentName).toBe("beta");
  });
});
