<script setup lang="ts">
import { useRouter } from "vue-router";
import EmptyState from "../components/EmptyState.vue";

const router = useRouter();

function onAction() {
  router.replace("/channels/general");
}
</script>

<template>
  <div class="flex items-center justify-center min-h-[80vh]">
    <EmptyState
      icon="🔍"
      title="页面未找到"
      description="你访问的页面不存在或已被移动。"
      action-label="返回主聊天"
      @action="onAction"
    />
  </div>
</template>
