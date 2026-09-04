import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from "../api";
import { __resetInstanceAdminForTest, useInstanceAdmin } from "./useInstanceAdmin";

const apiGetMock = vi.mocked(apiGet);

// W-A4：与 server P1.30 isInstanceAdmin 同口径——任一非个人社区 owner 即 admin
describe("useInstanceAdmin（W-A4）", () => {
  beforeEach(() => {
    __resetInstanceAdminForTest();
    vi.clearAllMocks();
  });

  it("非个人社区 owner → true", async () => {
    apiGetMock.mockResolvedValueOnce({
      orgs: [
        { personal: true, role: "owner" }, // 个人空间不计
        { personal: false, role: "owner" },
      ],
    } as any);
    const { isInstanceAdmin } = useInstanceAdmin();
    await vi.waitFor(() => expect(isInstanceAdmin.value).toBe(true));
  });

  it("仅个人空间 owner / 非 owner 成员 → false", async () => {
    apiGetMock.mockResolvedValueOnce({
      orgs: [
        { personal: true, role: "owner" },
        { personal: false, role: "member" },
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
    apiGetMock.mockResolvedValueOnce({ orgs: [{ personal: false, role: "owner" }] } as any);
    useInstanceAdmin();
    await vi.waitFor(() => expect(apiGetMock).toHaveBeenCalledTimes(1));
    useInstanceAdmin();
    useInstanceAdmin();
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });
});
