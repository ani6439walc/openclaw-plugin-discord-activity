import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteMessage, editMessage } from "./discord-api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

describe("editMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns true when Discord accepts the PATCH", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      editMessage("channel_1", "status_1", "content", "token"),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false for a non-retryable non-2xx response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "Forbidden" }, 403),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      editMessage("channel_1", "status_1", "content", "token"),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false after network retries are exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const editPromise = editMessage(
      "channel_1",
      "status_1",
      "content",
      "token",
    );
    await vi.runAllTimersAsync();

    await expect(editPromise).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("deleteMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns true when Discord deletes the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => emptyResponse()),
    );

    await expect(deleteMessage("channel_1", "status_1", "token")).resolves.toBe(
      true,
    );
  });

  it("treats an already-absent message as deleted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Unknown Message" }, 404)),
    );

    await expect(deleteMessage("channel_1", "status_1", "token")).resolves.toBe(
      true,
    );
  });

  it.each([401, 403])(
    "returns false for non-retryable HTTP %s",
    async (status) => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ message: "Denied" }, status),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        deleteMessage("channel_1", "status_1", "token"),
      ).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([429, 503])(
    "returns false after retryable HTTP %s is exhausted",
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () =>
        status === 429
          ? jsonResponse({ retry_after: 0.001 }, status)
          : jsonResponse({ message: "Unavailable" }, status),
      );
      vi.stubGlobal("fetch", fetchMock);

      const deletePromise = deleteMessage("channel_1", "status_1", "token");
      await vi.runAllTimersAsync();

      await expect(deletePromise).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("returns false after network retries are exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const deletePromise = deleteMessage("channel_1", "status_1", "token");
    await vi.runAllTimersAsync();

    await expect(deletePromise).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
