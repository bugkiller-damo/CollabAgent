<script setup lang="ts">
import { useRoute } from "vue-router";

const route = useRoute();
</script>

<template>
  <div class="p-8">
    <h1 class="text-2xl font-bold">{{ route.fullPath }}</h1>
    <p class="mt-2 text-gray-500 dark:text-gray-400">
      Vue3 重写中<template v-if="route.meta.sourceComponent">（对应 React 版组件：{{ route.meta.sourceComponent }}）</template>
    </p>
    <!-- 嵌套路由占位：等效 React Router 的 <Outlet />，叶子路由无 children 时不渲染任何内容 -->
    <router-view />
  </div>
</template>
