import { describe, it, expect, beforeEach } from "vitest";
import { createAgentTokenRegistry } from "../src/agent-tokens.js";

describe("agent-tokens", () => {
  let reg: ReturnType<typeof createAgentTokenRegistry>;

  beforeEach(() => {
    reg = createAgentTokenRegistry();
  });

  describe("issue", () => {
    it("returns a non-empty token", () => {
      const tok = reg.issue("agent-1");
      expect(tok).toBeTruthy();
      expect(tok.length).toBeGreaterThan(10);
    });

    it("returns different tokens for same agent on subsequent calls", () => {
      const t1 = reg.issue("agent-1");
      const t2 = reg.issue("agent-1");
      expect(t1).not.toBe(t2);
    });

    it("returns different tokens for different agents", () => {
      const t1 = reg.issue("agent-1");
      const t2 = reg.issue("agent-2");
      expect(t1).not.toBe(t2);
    });
  });

  describe("peek", () => {
    it("returns the issued token", () => {
      const tok = reg.issue("agent-1");
      expect(reg.peek("agent-1")).toBe(tok);
    });

    it("returns undefined for unknown agent", () => {
      expect(reg.peek("unknown")).toBeUndefined();
    });

    it("returns latest token after re-issue", () => {
      reg.issue("agent-1");
      const t2 = reg.issue("agent-1");
      expect(reg.peek("agent-1")).toBe(t2);
    });
  });

  describe("validate", () => {
    it("returns true for matching token", () => {
      const tok = reg.issue("agent-1");
      expect(reg.validate("agent-1", tok)).toBe(true);
    });

    it("returns false for wrong token", () => {
      reg.issue("agent-1");
      expect(reg.validate("agent-1", "wrong-token")).toBe(false);
    });

    it("returns false for undefined token", () => {
      reg.issue("agent-1");
      expect(reg.validate("agent-1", undefined)).toBe(false);
    });

    it("returns false for unknown agent", () => {
      expect(reg.validate("unknown", "any-token")).toBe(false);
    });

    it("returns false for stale token after re-issue", () => {
      const oldToken = reg.issue("agent-1");
      reg.issue("agent-1");
      expect(reg.validate("agent-1", oldToken)).toBe(false);
    });
  });

  describe("revokeIfMatches", () => {
    it("revokes when token matches", () => {
      const tok = reg.issue("agent-1");
      reg.revokeIfMatches("agent-1", tok);
      expect(reg.peek("agent-1")).toBeUndefined();
    });

    it("does NOT revoke when token does not match (race protection)", () => {
      const oldToken = reg.issue("agent-1");
      const newToken = reg.issue("agent-1");
      reg.revokeIfMatches("agent-1", oldToken);
      expect(reg.peek("agent-1")).toBe(newToken);
    });

    it("does nothing for unknown agent", () => {
      reg.revokeIfMatches("unknown", "any-token");
    });

    it("does nothing when no token issued", () => {
      reg.revokeIfMatches("agent-1", "any-token");
      expect(reg.peek("agent-1")).toBeUndefined();
    });
  });
});