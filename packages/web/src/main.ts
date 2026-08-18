import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import router from "./router";
import { initTheme } from "./stores/uiStore";
import "./style.css";
import "highlight.js/styles/github-dark.css";

// 主题初始化：逻辑收敛在 uiStore（localStorage "theme"，dark 默认），
// 挂载前先应用到 documentElement，避免首屏闪烁
initTheme();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
