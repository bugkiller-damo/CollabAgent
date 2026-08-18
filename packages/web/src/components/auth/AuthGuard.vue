<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../../stores";

const router = useRouter();
const authStore = useAuthStore();

function redirectIfUnauthed() {
  if (!authStore.isAuthenticated) router.replace("/login");
}

// React 版 AuthGuard：!isAuthenticated → <Navigate to="/login" replace/>，否则 <Outlet/>。
// React Router 的 <Navigate> 在 useEffect 里导航（挂载后），这里用 onMounted 对齐；
// isAuthenticated 由 localStorage 同步初始化（authStore 无异步加载），故无需 loading 态。
onMounted(redirectIfUnauthed);

// 页面内登出（isAuthenticated → false）时同样重定向，对齐 React 版重新渲染 AuthGuard 时 <Navigate> 生效。
watch(() => authStore.isAuthenticated, redirectIfUnauthed);
</script>

<template>
  <!-- <router-view/> 充当 React Router <Outlet/>：本组件作为受保护路由的父路由组件时渲染子路由。 -->
  <router-view v-if="authStore.isAuthenticated" />
</template>
