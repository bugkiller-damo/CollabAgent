import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./index.css";
import "highlight.js/styles/github-dark.css";

// Theme initialization: respect saved preference or system default
const savedTheme = localStorage.getItem("theme") || "system";
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const isDark = savedTheme === "dark" || (savedTheme === "system" && prefersDark);
document.documentElement.classList.toggle("dark", isDark);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
