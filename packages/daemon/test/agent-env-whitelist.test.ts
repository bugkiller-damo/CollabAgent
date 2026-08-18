import { beforeEach, describe, expect, it } from "vitest";
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
    beforeEach(() => {
      delete process.env.SLOCK_ENV_WHITELIST;
      delete process.env.SLOCK_ENV_INHERIT;
    });

    it("默认 warn 模式：行为不变（返回全量），但 token 仍被剔除", () => {
      expect(resolveAgentEnvMode()).toBe("warn");
      const env = applyAgentEnv({ SLOCK_AGENT_TOKEN: "x", SLOCK_AGENT_ID: "a1" }, "test");
      expect(env.PATH).toBe(process.env.PATH); // 全量继承
      expect(env.SLOCK_AGENT_ID).toBe("a1");
      expect(env.SLOCK_AGENT_TOKEN).toBeUndefined(); // O11 任何模式都生效
    });

    it("SLOCK_ENV_WHITELIST=1：只返回白名单 + overrides", () => {
      process.env.SLOCK_ENV_WHITELIST = "1";
      const env = applyAgentEnv({ SLOCK_AGENT_ID: "a1" }, "test");
      expect(env.SLOCK_AGENT_ID).toBe("a1");
      expect(env.PATH).toBe(process.env.PATH);
      // 随机挑一个测试进程里必然存在但不在白名单的键不好找——反向验证：
      // 结果键集必须是「白名单 ∪ 代理 ∪ overrides」的子集
      expect(Object.keys(env).length).toBeLessThan(Object.keys(process.env).length + 1);
    });

    it("SLOCK_ENV_INHERIT=1：显式回到全量继承", () => {
      process.env.SLOCK_ENV_INHERIT = "1";
      expect(resolveAgentEnvMode()).toBe("inherit");
      const env = applyAgentEnv({ SLOCK_AGENT_ID: "a1" }, "test");
      expect(env.SLOCK_AGENT_ID).toBe("a1");
      expect(env.PATH).toBe(process.env.PATH);
    });
  });
});
