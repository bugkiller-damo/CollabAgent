<script setup lang="ts">
import { labelTool, summarizeProgress } from "@collabagent/shared";
import { computed } from "vue";
import type { ObsFrame } from "../../stores/terminalStore";

/**
 * T4 结构化事件流（headless 观察面板）：非技术用户可读的活动卡。
 * tool_use 用中文标签；顶部一条当前进度摘要。
 */

const props = defineProps<{ frames: ObsFrame[] }>();

interface ToolCard {
  kind: "tool";
  key: string;
  toolName: string;
  label: string;
  inputText: string;
  resultText?: string;
  done: boolean;
  time: number;
}

interface TextItem {
  kind: "text" | "thinking" | "divider" | "error";
  key: string;
  text: string;
  time: number;
}

type StreamItem = ToolCard | TextItem;

const snapshot = computed(() => summarizeProgress(props.frames));

const items = computed<StreamItem[]>(() => {
  const out: StreamItem[] = [];
  const cardByUseId = new Map<string, ToolCard>();
  for (const f of props.frames) {
    const key = `${f.seq}`;
    switch (f.kind) {
      case "system":
        out.push({ kind: "divider", key, text: f.payload.text ?? "", time: f.timestamp });
        break;
      case "text":
        out.push({ kind: "text", key, text: f.payload.text ?? "", time: f.timestamp });
        break;
      case "thinking":
        out.push({ kind: "thinking", key, text: f.payload.text ?? "", time: f.timestamp });
        break;
      case "tool_use": {
        const name = f.payload.toolName ?? "?";
        const card: ToolCard = {
          kind: "tool",
          key,
          toolName: name,
          label: labelTool(name),
          inputText: f.payload.text ?? "",
          done: false,
          time: f.timestamp,
        };
        out.push(card);
        if (f.payload.toolUseId) cardByUseId.set(f.payload.toolUseId, card);
        break;
      }
      case "tool_result": {
        const card = f.payload.toolUseId ? cardByUseId.get(f.payload.toolUseId) : undefined;
        if (card) {
          card.resultText = f.payload.text ?? "";
          card.done = true;
        } else {
          out.push({ kind: "text", key, text: `↳ ${f.payload.text ?? ""}`, time: f.timestamp });
        }
        break;
      }
      case "turn_end":
        out.push({ kind: "divider", key, text: `回合结束（${f.payload.summary ?? ""}）`, time: f.timestamp });
        break;
      case "error":
        out.push({ kind: "error", key, text: f.payload.text ?? "", time: f.timestamp });
        break;
    }
  }
  return out;
});

const fmtTime = (ts: number): string => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <div
      v-if="snapshot.headline && items.length > 0"
      class="sticky top-0 z-10 mb-1 rounded border border-sky-800/60 bg-sky-950/80 px-2 py-1 text-[12px] text-sky-100"
    >
      正在{{ snapshot.headline }}…
    </div>
    <template v-for="item in items" :key="item.key">
      <!-- 分隔线：session 初始化 / 回合结束 -->
      <div v-if="item.kind === 'divider'" class="my-1 flex items-center gap-2 text-[11px] text-gray-500">
        <span class="h-px flex-1 bg-gray-700" />
        <span class="shrink-0">{{ item.text }} · {{ fmtTime(item.time) }}</span>
        <span class="h-px flex-1 bg-gray-700" />
      </div>

      <!-- 思考块（弱化） -->
      <div
        v-else-if="item.kind === 'thinking'"
        class="rounded border-l-2 border-gray-600 bg-gray-900/60 px-2 py-1 text-gray-400 italic whitespace-pre-wrap"
      >
        💭 {{ item.text }}
      </div>

      <!-- 工具调用卡片（点击展开输入/结果） -->
      <details v-else-if="item.kind === 'tool'" class="group rounded border border-gray-700 bg-gray-900 text-[12px]">
        <summary class="flex cursor-pointer items-center gap-2 px-2 py-1 select-none hover:bg-gray-800/60">
          <span>{{ item.done ? "✅" : "⏳" }}</span>
          <span class="font-medium text-sky-300">{{ item.label }}</span>
          <span class="min-w-0 flex-1 truncate text-gray-500">{{ item.inputText }}</span>
          <span class="shrink-0 text-[10px] text-gray-600">{{ fmtTime(item.time) }}</span>
        </summary>
        <div class="border-t border-gray-700/60 px-2 py-1">
          <div class="mb-1 text-[10px] tracking-wide text-gray-500 uppercase">输入</div>
          <pre class="overflow-x-auto text-gray-300 whitespace-pre-wrap">{{ item.inputText || "(无)" }}</pre>
          <template v-if="item.done">
            <div class="mt-2 mb-1 text-[10px] tracking-wide text-gray-500 uppercase">结果</div>
            <pre class="overflow-x-auto text-gray-400 whitespace-pre-wrap">{{ item.resultText }}</pre>
          </template>
        </div>
      </details>

      <!-- 错误块 -->
      <div v-else-if="item.kind === 'error'" class="rounded border-l-2 border-red-500 bg-red-950/40 px-2 py-1 text-red-300 whitespace-pre-wrap">
        ⚠️ {{ item.text }}
      </div>

      <!-- 正文 -->
      <div v-else class="px-1 text-gray-200 whitespace-pre-wrap">{{ item.text }}</div>
    </template>
    <div v-if="items.length === 0" class="px-1 py-4 text-center text-gray-500">暂无事件（agent 开始工作后这里实时滚动）</div>
  </div>
</template>
