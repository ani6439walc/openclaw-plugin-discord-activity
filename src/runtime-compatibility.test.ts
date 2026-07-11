import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { definePluginEntry, logger } from "../api.js";
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
  });

  it("keeps runtime, SDK, peer, and minimum versions aligned", () => {
    const peerVersion = packageMetadata.peerDependencies.openclaw;

    expect(packageMetadata.openclaw.compat.pluginApi).toBe(`>=${peerVersion}`);
    expect(packageMetadata.openclaw.compat.minGatewayVersion).toBe(peerVersion);
    expect(packageMetadata.openclaw.build.openclawVersion).toBe(peerVersion);
    expect(packageMetadata.openclaw.build.pluginSdkVersion).toBe(peerVersion);
  });
});
