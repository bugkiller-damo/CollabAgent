import type { PendingInterruptSummary } from "@collabagent/shared";
import { defineStore } from "pinia";
import { computed, ref } from "vue";

/**
 * 批次 C（P1.4）：pending interrupt 审批面状态——server 按 daemon 中继的
 * `agent:interrupts` 快照（仅安全摘要，resumeToken 从不出 daemon）。快照是
 * per-machine 全量：daemon 每次变更推全表，store 按 machineUuid 整体置换；
 * daemon 断连时 server 推空表清掉该机条目。
 */
export const useInterruptStore = defineStore("interrupt", () => {
  const byMachine = ref<Record<string, PendingInterruptSummary[]>>({});

  function setMachine(machineUuid: string | null | undefined, list: PendingInterruptSummary[]): void {
    const key = machineUuid || "";
    const next = { ...byMachine.value };
    if (!Array.isArray(list) || list.length === 0) delete next[key];
    else next[key] = list;
    byMachine.value = next;
  }

  /** 全机全量扁平化——审批门按会话语境再过滤 */
  const all = computed<PendingInterruptSummary[]>(() => Object.values(byMachine.value).flat());

  /**
   * 频道语境匹配：record.channel 是裸频道名（daemon parseDeliverChannel 去 #）。
   * threadId 缺省 = 频道顶层消息；调用方传 threadId 时只回该线程的 pending。
   */
  function forChannel(channelName: string, threadId?: string): PendingInterruptSummary[] {
    const tid = threadId || "";
    return all.value.filter((i) => i.channel === channelName && (i.threadId || "") === tid);
  }

  /** 频道含线程的全部 pending（频道页聚合展示，线程项带「去线程」入口） */
  function forChannelAll(channelName: string): PendingInterruptSummary[] {
    return all.value.filter((i) => i.channel === channelName);
  }

  /** DM 语境：agentId 锁定对端 agent；channel 形如 dm:@<senderHandle> */
  function forDm(agentId: string | undefined): PendingInterruptSummary[] {
    if (!agentId) return [];
    return all.value.filter((i) => i.agentId === agentId && (i.channel || "").startsWith("dm:"));
  }

  return { byMachine, all, setMachine, forChannel, forChannelAll, forDm };
});
