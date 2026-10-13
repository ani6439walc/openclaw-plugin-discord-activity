import { describe, expect, it } from "vitest";
import { isCanonicalDirectSessionKey } from "./parser.js";

describe("isCanonicalDirectSessionKey", () => {
  it.each([
    "discord:direct:123",
    "DISCORD:DIRECT:123",
    "agent:main:discord:direct:123",
  ])("accepts canonical direct session key %s", (sessionKey) => {
    expect(isCanonicalDirectSessionKey(sessionKey)).toBe(true);
  });

  it.each([
    undefined,
    "discord:channel:123",
    "discord:group:123",
    "discord:dm:123",
    "discord:chat:123",
    "discord:direct:",
    "discord:direct:user-123",
    "discord:direct:+123",
    "discord:direct:1.2",
    "discord:direct:123:extra",
    "discord:direct:123\n",
    "discord:direct:123 ",
    "notdiscord:direct:123",
  ])("rejects non-canonical session key %s", (sessionKey) => {
    expect(isCanonicalDirectSessionKey(sessionKey)).toBe(false);
  });
});
