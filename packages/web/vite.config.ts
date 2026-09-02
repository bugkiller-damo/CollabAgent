import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // Vite 会把 "/src" 解析为相对 project root 的绝对路径，无需 node:url（避免引入 @types/node）
      "@": "/src",
    },
  },
  server: {
    // dev 端口 5174；生产形态由 server 静态托管 dist（WEB_DIST_DIR，见 server/src/index.ts）
    port: 5174,
    // 监听所有网卡，允许局域网访问（否则只绑 localhost，他机 ip:5174 连接不可达）
    host: true,
    proxy: {
      "/api": { target: "http://localhost:3001" },
      "/files": { target: "http://localhost:3001" },
      // daemon/agent 内部接口（mint 凭证、agent 消息等）：接入向导用 window.location.origin
      // 生成命令，dev 环境下是 5174——不代理的话 mint credential 会拿到 Vite 的 404
      "/internal": { target: "http://localhost:3001" },
      // 浏览器与 daemon 均走 /ws（dev 下代理到后端；接入向导生成的命令用 origin=5174）。
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["vue", "vue-router", "pinia"],
        },
      },
    },
  },
});
