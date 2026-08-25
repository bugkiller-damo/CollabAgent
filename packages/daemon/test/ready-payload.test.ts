import { describe, expect, it } from "vitest";
import { buildReadyPayload, readDaemonVersion } from "../src/ready-payload.js";

describe("buildReadyPayload", () => {
  it("带上 package.json 版本、os/arch、传入的 runtimes", () => {
    const payload = buildReadyPayload([
      { id: "claude", status: "installed", version: "1.0" },
      { id: "codex", status: "not_installed" },
    ]);
    expect(payload.type).toBe("ready");
    expect(payload.daemonVersion).toBe(readDaemonVersion());
    expect(payload.os).toBe(process.platform);
    expect(payload.arch).toBe(process.arch);
    expect(payload.hostname.length).toBeGreaterThan(0);
    expect(payload.runtimes).toHaveLength(2);
    expect(payload.capabilities).toEqual(["send", "read"]);
  });
});
