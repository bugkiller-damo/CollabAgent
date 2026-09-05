import { composePresence } from "@collabagent/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore } from "./agentStore";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("agentStore 状态更新", () => {
  it("updateStatus 首见 agent：默认骨架（name=id 前 8 位 + duty on + computerOnline true）+ presence 合成", () => {
    const store = useAgentStore();
    store.updateStatus("agent-abc12345", "working", "整理中");

    const a = store.agents["agent-abc12345"];
    expect(a.status).toBe("working");
    expect(a.detail).toBe("整理中");
    expect(a.name).toBe("agent-abc12345".slice(0, 8));
    expect(a.duty).toBe("on");
    expect(a.computerOnline).toBe(true);
    expect(a.presence).toBe(composePresence("on", true, "working"));
    expect(a.lastSeen).toBeTruthy();
  });

  it("updateStatus 保留既有 duty/computerOnline（先 applyPresence 再更新不回退默认）", () => {
    const store = useAgentStore();
    store.applyPresence({
      agentName: "alpha",
      agentId: "a1",
      duty: "off",
      computerOnline: false,
      presence: "off_duty", // AgentPresence 五值之一（duty off 压过一切，shared presence.ts 口径）
    });
    store.updateStatus("alpha", "idle");

    expect(store.agents.alpha.duty).toBe("off");
    expect(store.agents.alpha.computerOnline).toBe(false);
    expect(store.agents.alpha.presence).toBe(composePresence("off", false, "idle"));
  });

  it("applyPresence 以 agentName 为 key upsert；id 缺省回退 name、有则透传", () => {
    const store = useAgentStore();
    store.applyPresence({ agentName: "beta", duty: "on", computerOnline: true, presence: "idle" });
    expect(store.agents.beta.id).toBe("beta");

    store.applyPresence({
      agentName: "beta",
      agentId: "real-id",
      duty: "on",
      computerOnline: true,
      presence: "working",
    });
    expect(store.agents.beta.presence).toBe("working");
  });
});

describe("agentStore.setAgents", () => {
  it("按 id 重建映射（替换而非合并）", () => {
    const store = useAgentStore();
    store.updateStatus("stale-agent", "idle");

    store.setAgents([{ id: "a1", name: "Alpha", status: "idle", detail: "", lastSeen: "" }]);

    expect(store.agents.a1?.name).toBe("Alpha");
    expect(store.agents["stale-agent"]).toBeUndefined();
  });
});

describe("agentStore 进度条（T4 agent:progress）", () => {
  it("setProgress 剥 # 前缀并写频道/agent 双索引", () => {
    const store = useAgentStore();
    store.setProgress("#general", "alpha", "正在整理代码");

    expect(store.progressByChannel.general).toEqual({ agentName: "alpha", headline: "正在整理代码" });
    expect(store.progressByAgent.alpha).toEqual({ channelName: "general", headline: "正在整理代码" });
  });

  it("clearProgress：异名 agent 不误清，同 agent 清双索引", () => {
    const store = useAgentStore();
    store.setProgress("#general", "alpha", "h");

    store.clearProgress("#general", "beta");
    expect(store.progressByChannel.general).toEqual({ agentName: "alpha", headline: "h" }); // 异名不误清

    store.clearProgress("#general", "alpha");
    expect(store.progressByChannel.general).toBeUndefined();
    expect(store.progressByAgent.alpha).toBeUndefined();
  });

  it("clearProgress 不传 agentName：清频道槽位但保留 agent 索引", () => {
    const store = useAgentStore();
    store.setProgress("#dev", "beta", "h");

    store.clearProgress("#dev");
    expect(store.progressByChannel.dev).toBeUndefined();
    expect(store.progressByAgent.beta).toEqual({ channelName: "dev", headline: "h" });
  });
});
