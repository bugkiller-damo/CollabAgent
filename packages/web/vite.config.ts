import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001" },
      "/files": { target: "http://localhost:3001" },
      // daemon/agent 内部接口（mint 凭证、agent 消息等）：接入向导用 window.location.origin
      // 生成命令，dev 环境下是 5173——不代理的话 mint credential 会拿到 Vite 的 404
      "/internal": { target: "http://localhost:3001" },
      // 浏览器走 /ws/chat（重写到后端 /ws）；daemon 走 /ws（接入向导生成的命令用 origin=5173）。
      // /ws/chat 必须排在 /ws 前面，否则前缀匹配会被 /ws 吞掉。
      "/ws/chat": { target: "ws://localhost:3001", ws: true, rewrite: () => "/ws" },
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
