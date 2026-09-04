/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{vue,ts}"],
  theme: {
    extend: {
      // 语义化 token（值见 style.css :root/.dark，light/dark 双套由 CSS 变量翻转，
      // 使用侧无需 dark: 变体）。var() 形式不支持 /opacity 修饰。
      colors: {
        canvas: "var(--bg-primary)", // 页面底色
        surface: "var(--bg-secondary)", // 卡片/面板
        raised: "var(--bg-tertiary)", // hover/凹陷填充
        ink: "var(--text-primary)", // 主文字
        subtle: "var(--text-secondary)", // 次文字
        muted: "var(--text-muted)", // 弱提示文字
        line: "var(--border)", // 边框/分隔线
      },
    },
  },
  plugins: [],
};
