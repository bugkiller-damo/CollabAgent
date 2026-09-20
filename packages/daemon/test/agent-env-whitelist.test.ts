import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAgentEnv, buildAgentEnv, diffAgentEnv, resolveAgentEnvMode } from "../src/agent-env-whitelist.js";

/** 构造一个模拟的 daemon 全量 env（避免依赖测试进程真实 env） */
const fakeFullEnv = () =>
  ({
    PATH: "C:\\Windows;C:\\npm",
    SystemRoot: "C:\\Windows",
    COMSPEC: "C:\\Windows\\system32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.CMD",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    TEMP: "C:\\Users\\x\\AppData\\Local\\Temp",
    SLOCK_API_KEY: "super-secret-api-key",
    AWS_SECRET_ACCESS_KEY: "another-secret",
    HTTP_PROXY: "http://proxy:8080",
    // A7.5：开发工具链键
    INCLUDE: "C:\\VC\\include",
    LIB: "C:\\VC\\lib",
    VCINSTALLDIR: "C:\\VS\\VC",
    VSCMD_ARG_TGT_ARCH: "x64",
    JAVA_HOME: "C:\\jdk",
    CARGO_HOME: "C:\\cargo",
    PYTHONPATH: "C:\\py\\lib",
    // A7.5：跨平台基础键与前缀族
    HOME: "C:\\Users\\x",
    USER: "x",
    SHELL: "/bin/bash",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    XDG_CONFIG_HOME: "C:\\Users\\x\\.config",
    // A7.5：仅经 SLOCK_ENV_EXTRA 显式追加才放行
    CUDA_PATH: "C:\\cuda",
    MY_CUSTOM: "custom-value",
    GITHUB_TOKEN: "ghp_secret",
    MY_SECRET: "topsecret",
  }) as NodeJS.ProcessEnv;

describe("agent-env-whitelist", () => {
  describe("buildAgentEnv", () => {
    it("白名单键保留，非白名单键剔除", () => {
      const env = buildAgentEnv({}, fakeFullEnv());
      expect(env.PATH).toBe("C:\\Windows;C:\\npm");
      expect(env.SystemRoot).toBe("C:\\Windows");
      expect(env.SLOCK_API_KEY).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    });

    it("代理变量仅当 daemon env 存在时转发", () => {
      const withProxy = buildAgentEnv({}, fakeFullEnv());
      expect(withProxy.HTTP_PROXY).toBe("http://proxy:8080");
      const noProxy = fakeFullEnv();
      delete noProxy.HTTP_PROXY;
      expect(buildAgentEnv({}, noProxy).HTTP_PROXY).toBeUndefined();
    });

    it("overrides 最后合并，优先级高于白名单继承", () => {
      const env = buildAgentEnv({ SLOCK_AGENT_ID: "a1", PATH: "C:\\custom" }, fakeFullEnv());
      expect(env.SLOCK_AGENT_ID).toBe("a1");
      expect(env.PATH).toBe("C:\\custom");
    });

    it("SLOCK_AGENT_TOKEN 明文绝不出现在结果中（O11 兜底）", () => {
      const env = buildAgentEnv({ SLOCK_AGENT_TOKEN: "leak-attempt" }, fakeFullEnv());
      expect(env.SLOCK_AGENT_TOKEN).toBeUndefined();
    });

    it("白名单匹配大小写不敏感（Windows env 约定）", () => {
      const env = buildAgentEnv({}, { path: "C:\\lower" } as NodeJS.ProcessEnv);
      expect(env.path).toBe("C:\\lower");
    });

    it("A7.5：开发工具链键放行（MSVC/Java/Rust/Python 等）", () => {
      const env = buildAgentEnv({}, fakeFullEnv());
      expect(env.INCLUDE).toBe("C:\\VC\\include");
      expect(env.LIB).toBe("C:\\VC\\lib");
      expect(env.VCINSTALLDIR).toBe("C:\\VS\\VC");
      expect(env.VSCMD_ARG_TGT_ARCH).toBe("x64");
      expect(env.JAVA_HOME).toBe("C:\\jdk");
      expect(env.CARGO_HOME).toBe("C:\\cargo");
      expect(env.PYTHONPATH).toBe("C:\\py\\lib");
    });

    it("A7.5：跨平台基础键与前缀族放行", () => {
      const env = buildAgentEnv({}, fakeFullEnv());
      expect(env.HOME).toBe("C:\\Users\\x");
      expect(env.USER).toBe("x");
      expect(env.SHELL).toBe("/bin/bash");
      expect(env.LANG).toBe("en_US.UTF-8");
      expect(env.LC_ALL).toBe("en_US.UTF-8");
      expect(env.XDG_CONFIG_HOME).toBe("C:\\Users\\x\\.config");
    });

    it("A7.5：未配置 SLOCK_ENV_EXTRA 时，非白名单键仍被剔除", () => {
      const env = buildAgentEnv({}, fakeFullEnv());
      expect(env.SLOCK_API_KEY).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.CUDA_PATH).toBeUndefined();
      expect(env.MY_CUSTOM).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });

    it("A7.5：SLOCK_ENV_EXTRA 放行安全名，拒绝 SLOCK_*/_KEY/_TOKEN/_SECRET", () => {
      const full = { ...fakeFullEnv(), SLOCK_ENV_EXTRA: "CUDA_PATH,MY_CUSTOM,SLOCK_API_KEY,GITHUB_TOKEN,MY_SECRET" };
      const env = buildAgentEnv({}, full);
      expect(env.CUDA_PATH).toBe("C:\\cuda");
      expect(env.MY_CUSTOM).toBe("custom-value");
      // 名字本身就是凭据形态——即使显式追加也拒绝
      expect(env.SLOCK_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.MY_SECRET).toBeUndefined();
    });

    it("A7.5：extra 中不存在的键与非法名静默忽略", () => {
      const full = { ...fakeFullEnv(), SLOCK_ENV_EXTRA: "NOT_PRESENT,FOO-BAR,CUDA_PATH" };
      const env = buildAgentEnv({}, full);
      expect(env.CUDA_PATH).toBe("C:\\cuda");
      expect(env.NOT_PRESENT).toBeUndefined();
      expect(env["FOO-BAR"]).toBeUndefined();
    });

    it("A7.5：extra 大小写不敏感查找；overrides 仍最后胜出", () => {
      const full = { ...fakeFullEnv(), SLOCK_ENV_EXTRA: "cuda_path,my_custom" };
      const env = buildAgentEnv({ MY_CUSTOM: "override-value" }, full);
      // 请求名大小写不同也能命中 fullEnv 里的键，按原始拼写拷贝
      expect(env.CUDA_PATH).toBe("C:\\cuda");
      // overrides 覆盖 extra 拷贝的值
      expect(env.MY_CUSTOM).toBe("override-value");
    });
  });

  describe("diffAgentEnv", () => {
    it("返回会被剔除的键名（不含值）", () => {
      const whitelisted = buildAgentEnv({}, fakeFullEnv());
      const dropped = diffAgentEnv(whitelisted, fakeFullEnv());
      expect(dropped).toContain("SLOCK_API_KEY");
      expect(dropped).toContain("AWS_SECRET_ACCESS_KEY");
      expect(dropped).not.toContain("PATH");
    });
  });

  describe("applyAgentEnv 模式", () => {
    const originalApiKey = process.env.SLOCK_API_KEY;
    const originalAws = process.env.AWS_SECRET_ACCESS_KEY;
    const originalInherit = process.env.SLOCK_ENV_INHERIT;
    const originalWhitelist = process.env.SLOCK_ENV_WHITELIST;

    beforeEach(() => {
      delete process.env.SLOCK_ENV_WHITELIST;
      delete process.env.SLOCK_ENV_INHERIT;
      process.env.SLOCK_API_KEY = "super-secret-api-key";
      process.env.AWS_SECRET_ACCESS_KEY = "another-secret";
    });

    afterEach(() => {
      vi.restoreAllMocks();
      if (originalApiKey === undefined) delete process.env.SLOCK_API_KEY;
      else process.env.SLOCK_API_KEY = originalApiKey;
      if (originalAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = originalAws;
      if (originalInherit === undefined) delete process.env.SLOCK_ENV_INHERIT;
      else process.env.SLOCK_ENV_INHERIT = originalInherit;
      if (originalWhitelist === undefined) delete process.env.SLOCK_ENV_WHITELIST;
      else process.env.SLOCK_ENV_WHITELIST = originalWhitelist;
    });

    it("默认 whitelist：只转发白名单 + overrides，剔除 daemon secrets 与明文 token", () => {
      expect(resolveAgentEnvMode()).toBe("whitelist");
      const env = applyAgentEnv({ SLOCK_AGENT_TOKEN: "x", SLOCK_AGENT_ID: "a1" }, "test");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.SLOCK_AGENT_ID).toBe("a1");
      expect(env.SLOCK_AGENT_TOKEN).toBeUndefined();
      expect(env.SLOCK_API_KEY).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(Object.keys(env).length).toBeLessThan(Object.keys(process.env).length);
    });

    it("SLOCK_ENV_WHITELIST=1：兼容别名，仍是 whitelist", () => {
      process.env.SLOCK_ENV_WHITELIST = "1";
      expect(resolveAgentEnvMode()).toBe("whitelist");
      const env = applyAgentEnv({ SLOCK_AGENT_ID: "a1" }, "test");
      expect(env.SLOCK_AGENT_ID).toBe("a1");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.SLOCK_API_KEY).toBeUndefined();
    });

    it("SLOCK_ENV_INHERIT=1：显式回到全量继承，但仍剔除明文 token", () => {
      process.env.SLOCK_ENV_INHERIT = "1";
      expect(resolveAgentEnvMode()).toBe("inherit");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = applyAgentEnv({ SLOCK_AGENT_ID: "a1", SLOCK_AGENT_TOKEN: "x" }, "test");
      expect(env.SLOCK_AGENT_ID).toBe("a1");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.SLOCK_API_KEY).toBe("super-secret-api-key");
      expect(env.SLOCK_AGENT_TOKEN).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("SLOCK_ENV_INHERIT=1"));
    });

    it("SLOCK_ENV_INHERIT=1 优先于 SLOCK_ENV_WHITELIST=1", () => {
      process.env.SLOCK_ENV_INHERIT = "1";
      process.env.SLOCK_ENV_WHITELIST = "1";
      expect(resolveAgentEnvMode()).toBe("inherit");
    });
  });
});
