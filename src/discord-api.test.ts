import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteMessage,
  editMessage,
  editMessageWithResult,
  sendMessageWithResult,
} from "./discord-api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

describe("sendMessageWithResult", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns applied and sends an enforced idempotency nonce", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendMessageWithResult("channel_1", "content", "token"),
    ).resolves.toEqual({
      outcome: "applied",
      messageId: "status_1",
      status: 200,
      reason: "created",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      nonce?: string;
      enforce_nonce?: boolean;
    };
    expect(body.nonce).toEqual(expect.any(String));
    expect(body.nonce?.length).toBeLessThanOrEqual(25);
    expect(body.enforce_nonce).toBe(true);
  });

  it("reuses one nonce across server-error retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = sendMessageWithResult(
      "channel_1",
      "content",
      "token",
    );
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ outcome: "applied", messageId: "status_1" }),
    );
    const nonces = fetchMock.mock.calls.map(([_, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        nonce: string;
      };
      return body.nonce;
    });
    expect(nonces).toEqual([nonces[0], nonces[0]]);
  });

  it("reuses a caller-supplied nonce across the complete create attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = sendMessageWithResult(
      "channel_1",
      "content",
      "token",
      undefined,
      "stable_nonce",
    );
    await vi.runAllTimersAsync();
    await resultPromise;

    const nonces = fetchMock.mock.calls.map(([_, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        nonce: string;
      };
      return body.nonce;
    });
    expect(nonces).toEqual(["stable_nonce", "stable_nonce"]);
  });

  it("classifies a non-retryable 4xx as rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Forbidden" }, 403)),
    );

    await expect(
      sendMessageWithResult("channel_1", "content", "token"),
    ).resolves.toEqual({
      outcome: "rejected",
      status: 403,
      reason: "http-403",
    });
  });

  it("classifies a final 5xx as uncertain", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Unavailable" }, 503)),
    );

    const resultPromise = sendMessageWithResult(
      "channel_1",
      "content",
      "token",
    );
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      outcome: "uncertain",
      status: 503,
      reason: "http-503",
    });
  });

  it("classifies exhausted network errors as uncertain", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    );

    const resultPromise = sendMessageWithResult(
      "channel_1",
      "content",
      "token",
    );
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      outcome: "uncertain",
      reason: "network-error",
    });
  });

  it("classifies a successful response without an id as uncertain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({})),
    );

    await expect(
      sendMessageWithResult("channel_1", "content", "token"),
    ).resolves.toEqual({
      outcome: "uncertain",
      status: 200,
      reason: "missing-message-id",
    });
  });
});

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

  it.each([
    [200, "applied", "edited"],
    [403, "rejected", "http-403"],
    [503, "uncertain", "http-503"],
  ] as const)("classifies HTTP %s as %s", async (status, outcome, reason) => {
    if (status === 503) vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "response" }, status)),
    );

    const resultPromise = editMessageWithResult(
      "channel_1",
      "status_1",
      "content",
      "token",
    );
    if (status === 503) await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      outcome,
      status,
      reason,
    });
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
