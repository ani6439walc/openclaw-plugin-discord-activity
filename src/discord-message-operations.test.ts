import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteDiscordStatusMessageWithResult,
  editDiscordStatusMessage,
  editDiscordStatusMessageWithResult,
  sendDiscordStatusWithDmFallbackWithResult,
} from "./discord-message-operations.js";
import { createMockSessionEntry } from "../test-helpers.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("editDiscordStatusMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false without a Discord token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      editDiscordStatusMessage(() => "", "channel_1", "status_1", "content"),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when the Discord PATCH fails", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "Forbidden" }, 403),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      editDiscordStatusMessage(
        () => "token",
        "channel_1",
        "status_1",
        "content",
      ),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a missing token as rejected in the detailed API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      editDiscordStatusMessageWithResult(
        () => "",
        "channel_1",
        "status_1",
        "content",
      ),
    ).resolves.toEqual({
      outcome: "rejected",
      reason: "missing-token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies token resolution errors as rejected", async () => {
    await expect(
      editDiscordStatusMessageWithResult(
        () => {
          throw new Error("secret provider unavailable");
        },
        "channel_1",
        "status_1",
        "content",
      ),
    ).resolves.toEqual({
      outcome: "rejected",
      reason: "token-resolution-error",
    });
  });

  it.each(["", "   ", "```ansi\n\n```", "```\nansi\n```", "```ansi```"])(
    "rejects empty content %j early without calling fetch or resolving token",
    async (emptyContent) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tokenGetter = vi.fn(() => "token");

      await expect(
        editDiscordStatusMessageWithResult(
          tokenGetter,
          "channel_1",
          "status_1",
          emptyContent,
        ),
      ).resolves.toEqual({
        outcome: "rejected",
        reason: "empty-content",
      });
      expect(tokenGetter).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(
        editDiscordStatusMessage(
          tokenGetter,
          "channel_1",
          "status_1",
          emptyContent,
        ),
      ).resolves.toBe(false);
    },
  );
});

describe("sendDiscordStatusWithDmFallbackWithResult", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies a missing token as rejected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendDiscordStatusWithDmFallbackWithResult(
        () => "",
        createMockSessionEntry(),
        "content",
      ),
    ).resolves.toEqual({
      outcome: "rejected",
      reason: "missing-token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "```ansi\n\n```", "```\nansi\n```", "```ansi```"])(
    "rejects empty content %j early without calling fetch or resolving token",
    async (emptyContent) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const tokenGetter = vi.fn(() => "token");

      await expect(
        sendDiscordStatusWithDmFallbackWithResult(
          tokenGetter,
          createMockSessionEntry(),
          emptyContent,
        ),
      ).resolves.toEqual({
        outcome: "rejected",
        reason: "empty-content",
      });
      expect(tokenGetter).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("deleteDiscordStatusMessageWithResult", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies token resolution exceptions as terminal", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteDiscordStatusMessageWithResult(
        () => {
          throw new Error("secret provider unavailable");
        },
        "channel_1",
        "status_1",
      ),
    ).resolves.toEqual({
      deleted: false,
      retryable: false,
      reason: "token-resolution-error",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
