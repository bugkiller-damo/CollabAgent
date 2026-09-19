import { ref } from "vue";
import { apiGet } from "../api";

/**
 * W-A4：实例级 admin 推导——与 server `isInstanceAdmin` 同口径（2026-09-18
 * 权限模型收敛：锚点从「任一非 personal server owner」收为「公共服务器
 * （is_public，广场）owner」；isDefault 兜底兼容旧响应）。membership role 口径与
 * servers.owner_id 双查等价（025 迁移 + 启动擢升已保证 owner 必有成员行）。
 * 模块级单例缓存：SettingsLayout 等共享一次拉取；拉取失败按非 admin 处理
 * （隐藏入口，admin 页自有 403 红字兜底，不漏权只少入口）。
 * 取舍立此存照：角色中途变更不刷新缓存（P2 体验项，刷新页面即复位）。
 */
const isInstanceAdmin = ref<boolean | null>(null); // null = 未加载
let inflight: Promise<void> | null = null;

export function useInstanceAdmin() {
  if (isInstanceAdmin.value === null && !inflight) {
    inflight = apiGet<{ orgs: { is_public?: boolean; isDefault?: boolean; role: string }[] }>("/api/orgs")
      .then((d) => {
        isInstanceAdmin.value = (d.orgs || []).some((o) => (o.is_public || o.isDefault) && o.role === "owner");
      })
      .catch(() => {
        isInstanceAdmin.value = false;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return { isInstanceAdmin };
}

/** 仅测试用：清空模块级缓存 */
export function __resetInstanceAdminForTest() {
  isInstanceAdmin.value = null;
  inflight = null;
}
