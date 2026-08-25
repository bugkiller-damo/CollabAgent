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
