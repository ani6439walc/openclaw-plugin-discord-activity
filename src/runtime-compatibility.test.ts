import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  definePluginEntry,
  logger,
  LOG_PREFIX,
  setApiLogger,
  resetApiLogger,
} from "../api.js";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

type PackageMetadata = {
  peerDependencies: { openclaw: string };
  openclaw: {
    compat: { pluginApi: string; minGatewayVersion: string };
    build: { openclawVersion: string; pluginSdkVersion: string };
  };
};

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

describe("OpenClaw runtime compatibility", () => {
  it("loads the SDK entrypoints used by the plugin", () => {
    expect(typeof definePluginEntry).toBe("function");
    expect(typeof createSubsystemLogger).toBe("function");
    expect(logger).toBeDefined();
    expect(LOG_PREFIX).toContain("discord-activity:");
  });

  it("prefixes messages with colored LOG_PREFIX and routes through setApiLogger", () => {
    const logs: { level: string; msg: string; meta?: unknown }[] = [];
    setApiLogger({
      info: (msg, meta) => logs.push({ level: "info", msg, meta }),
      warn: (msg, meta) => logs.push({ level: "warn", msg, meta }),
      debug: (msg, meta) => logs.push({ level: "debug", msg, meta }),
      trace: (msg, meta) => logs.push({ level: "trace", msg, meta }),
    });

    try {
      logger.info("testing info log", { testKey: "testVal" });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.level).toBe("info");
      expect(logs[0]!.msg).toBe(`${LOG_PREFIX} testing info log`);
      expect(logs[0]!.meta).toEqual({ testKey: "testVal" });

      // Does not duplicate prefix if already prefixed
      logger.warn(`${LOG_PREFIX} already prefixed`);
      expect(logs).toHaveLength(2);
      expect(logs[1]!.msg).toBe(`${LOG_PREFIX} already prefixed`);
    } finally {
      resetApiLogger();
    }
  });

  it("keeps runtime, SDK, peer, and minimum versions aligned", () => {
    const peerVersion = packageMetadata.peerDependencies.openclaw;

    expect(packageMetadata.openclaw.compat.pluginApi).toBe(`>=${peerVersion}`);
    expect(packageMetadata.openclaw.compat.minGatewayVersion).toBe(peerVersion);
    expect(packageMetadata.openclaw.build.openclawVersion).toBe(peerVersion);
    expect(packageMetadata.openclaw.build.pluginSdkVersion).toBe(peerVersion);
  });
});
