<script setup lang="ts">
import { Check } from "@lucide/vue";
import { ref } from "vue";
import { copyText } from "../../lib/clipboard";
import { toast } from "../../stores/toastStore";
import Button from "../ui/Button.vue";

/**
 * 计算机接入命令块（slock computer 两步形态）——默认即渲染，不藏在按钮后：
 *   ① setup —— 一次性登记。tokenReady=false 时展示占位模板
 *      （--api-key <MACHINE_TOKEN>），点「生成机器令牌」后原地换成真命令；
 *   ② start —— 日常启动/重启，不含密钥，任何时候都可直接复制。
 * 列表页与详情页两处「接入」卡片共用；签发动作经 generate 事件上交父级。
 */
const props = defineProps<{
  setupCommand: string;
  startCommand: string;
  /** true = setup 行已含真实令牌；false = 占位模板，须先生成令牌 */
  tokenReady: boolean;
  generating?: boolean;
}>();
const emit = defineEmits<{ generate: [] }>();

const copiedSetup = ref(false);
const copiedStart = ref(false);

async function copy(which: "setup" | "start") {
  const text = which === "setup" ? props.setupCommand : props.startCommand;
  if (!text) return;
  const flag = which === "setup" ? copiedSetup : copiedStart;
  try {
    await copyText(text);
    flag.value = true;
    setTimeout(() => {
      flag.value = false;
    }, 2000);
  } catch {
    toast.error("复制失败，请手动选择命令");
  }
}
</script>

<template>
  <div class="space-y-3">
    <div class="space-y-1.5">
      <p class="text-xs font-medium text-gray-700 dark:text-gray-300">
        ① 在目标电脑上登记（只跑一次；令牌只显示这一次）
      </p>
      <div
        :class="[
          'break-all rounded bg-gray-900 p-3 font-mono text-xs dark:bg-black',
          tokenReady ? 'text-green-400' : 'text-gray-500',
        ]"
      >
        {{ setupCommand }}
      </div>
      <div class="flex items-center gap-2">
        <Button v-if="!tokenReady" size="sm" :loading="generating" @click="emit('generate')">
          生成机器令牌填入
        </Button>
        <Button v-else size="sm" variant="secondary" @click="copy('setup')">
          <Check v-if="copiedSetup" class="mr-0.5 inline h-3.5 w-3.5" aria-hidden="true" />
          {{ copiedSetup ? "已复制" : "复制登记命令" }}
        </Button>
      </div>
      <p v-if="!tokenReady" class="text-xs text-muted">
        命令里的 <code class="rounded bg-black/10 px-1 dark:bg-white/10">&lt;MACHINE_TOKEN&gt;</code>
        是占位符——点上方按钮签发后会原地填成真命令。
      </p>
    </div>
    <div class="space-y-1.5">
      <p class="text-xs font-medium text-gray-700 dark:text-gray-300">② 之后启动 / 重启（随时可用，不带密钥）</p>
      <div class="break-all rounded bg-gray-900 p-3 font-mono text-xs text-green-400 dark:bg-black">
        {{ startCommand }}
      </div>
      <Button size="sm" variant="secondary" @click="copy('start')">
        <Check v-if="copiedStart" class="mr-0.5 inline h-3.5 w-3.5" aria-hidden="true" />
        {{ copiedStart ? "已复制" : "复制启动命令" }}
      </Button>
    </div>
    <p class="text-xs text-muted">
      换 server 接入请回到对应 server 再生成。管理已登记的接入：
      <code class="rounded bg-black/10 px-1 dark:bg-white/10">slock computer list / stop / remove</code>
    </p>
  </div>
</template>
