import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from "../api";
import { __resetInstanceAdminForTest, useInstanceAdmin } from "./useInstanceAdmin";

const apiGetMock = vi.mocked(apiGet);

// W-A4：与 server isInstanceAdmin 同口径——公共服务器（is_public/广场）owner 即
// 实例 admin；自建非公共 server 的 owner 不计（2026-09-18 权限模型收敛）
describe("useInstanceAdmin（W-A4）", () => {
  beforeEach(() => {
    __resetInstanceAdminForTest();
    vi.clearAllMocks();
  });

  it("公共服务器 owner → true", async () => {
    apiGetMock.mockResolvedValueOnce({
      orgs: [
        { role: "owner" }, // 自建 server owner 不计
        { is_public: true, role: "owner" }, // 广场 owner = 实例 admin
      ],
    } as any);
    const { isInstanceAdmin } = useInstanceAdmin();
    await vi.waitFor(() => expect(isInstanceAdmin.value).toBe(true));
  });

  it("isDefault 兜底：旧响应无 is_public 时按默认社区判", async () => {
    apiGetMock.mockResolvedValueOnce({
      orgs: [{ isDefault: true, role: "owner" }],
    } as any);
    const { isInstanceAdmin } = useInstanceAdmin();
    await vi.waitFor(() => expect(isInstanceAdmin.value).toBe(true));
  });

  it("自建 server owner、公共 server 非 owner 成员 → false", async () => {
    apiGetMock.mockResolvedValueOnce({
      orgs: [
        { role: "owner" }, // 自建 server owner 不是实例 admin
        { role: "owner" },
        { is_public: true, role: "member" }, // 广场普通成员
      ],
    } as any);
    const { isInstanceAdmin } = useInstanceAdmin();
    await vi.waitFor(() => expect(isInstanceAdmin.value).toBe(false));
  });

  it("拉取失败按非 admin 处理（隐藏入口不漏权）", async () => {
    apiGetMock.mockRejectedValueOnce(new Error("network"));
    const { isInstanceAdmin } = useInstanceAdmin();
    await vi.waitFor(() => expect(isInstanceAdmin.value).toBe(false));
  });

  it("单例缓存：重复调用不重拉", async () => {
    apiGetMock.mockResolvedValueOnce({ orgs: [{ is_public: true, role: "owner" }] } as any);
    useInstanceAdmin();
    await vi.waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
    useInstanceAdmin();
    useInstanceAdmin();
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });
});
