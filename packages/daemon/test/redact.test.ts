import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "../src/redact.js";

// 对齐 server 签发格式（server/src/routes/agents-credentials.ts）：sk_agent_ + 32 位 [a-z0-9]
const AGENT_TOKEN = "sk_agent_abcd1234abcd1234abcd1234abcd1234";
const MACHINE_TOKEN = "sk_machine_xyz987xyz987xyz987xyz987xyz9";

describe("redactSecrets", () => {
  it("脱敏 sk_agent_ token，保留前缀便于辨识类型", () => {
    expect(redactSecrets(`我的 token 是 ${AGENT_TOKEN} 别外传`)).toBe("我的 token 是 sk_agent_*** 别外传");
  });

  it("脱敏 sk_machine_ token（防御性：machine token 不应出现在任何出口文本）", () => {
    expect(redactSecrets(`auth: ${MACHINE_TOKEN}`)).toBe("auth: sk_machine_***");
  });

  it("同一文本多处 token 全部脱敏", () => {
    expect(redactSecrets(`${AGENT_TOKEN} 和 ${AGENT_TOKEN}`)).toBe("sk_agent_*** 和 sk_agent_***");
  });

  it("普通文本与短 lookalike 不动", () => {
    expect(redactSecrets("sk_agent_ 后面没内容")).toBe("sk_agent_ 后面没内容");
    expect(redactSecrets("sk_agent_abc")).toBe("sk_agent_abc"); // 不足 4 位，非签发格式
    expect(redactSecrets("普通中文文本")).toBe("普通中文文本");
  });

  it("词边界：嵌在更长单词里的不匹配", () => {
    expect(redactSecrets("ask_agent_abcdef")).toBe("ask_agent_abcdef"); // s 前是字母，无词边界
  });
});

describe("redactDeep", () => {
  it("嵌套对象/数组递归脱敏", () => {
    const input = {
      command: `TOKEN=${AGENT_TOKEN} curl x`,
      nested: { auth: [MACHINE_TOKEN, "ok"] },
      count: 3,
    };
    const out = redactDeep(input);
    expect(JSON.stringify(out)).not.toContain(AGENT_TOKEN);
    expect(JSON.stringify(out)).not.toContain(MACHINE_TOKEN);
    expect(out).toEqual({
      command: "TOKEN=sk_agent_*** curl x",
      nested: { auth: ["sk_machine_***", "ok"] },
      count: 3,
    });
  });

  it("不修改入参（返回新对象）", () => {
    const input = { token: AGENT_TOKEN };
    redactDeep(input);
    expect(input.token).toBe(AGENT_TOKEN);
  });

  it("非对象原始值原样返回", () => {
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(null)).toBe(null);
    expect(redactDeep(undefined)).toBe(undefined);
  });
});
