import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteMessageWithResult,
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
      channelId: "channel_1",
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

describe("editMessageWithResult", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("classifies exhausted network retries as uncertain", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const editPromise = editMessageWithResult(
      "channel_1",
      "status_1",
      "content",
      "token",
    );
    await vi.runAllTimersAsync();

    await expect(editPromise).resolves.toEqual({
      outcome: "uncertain",
      reason: "network-error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    [200, "applied", "edited"],
    [403, "rejected", "http-403"],
    [503, "uncertain", "http-503"],
  ] as const)("classifies HTTP %s as %s", async (status, outcome, reason) => {
    if (status === 503) vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "response" }, status),
    );
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledTimes(status === 503 ? 3 : 1);
  });
});

describe("deleteMessageWithResult", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a deleted message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => emptyResponse()),
    );

    await expect(
      deleteMessageWithResult("channel_1", "status_1", "token"),
    ).resolves.toEqual({
      deleted: true,
      retryable: false,
      status: 204,
      reason: "deleted",
    });
  });

  it("treats an already-absent message as deleted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Unknown Message" }, 404)),
    );

    await expect(
      deleteMessageWithResult("channel_1", "status_1", "token"),
    ).resolves.toEqual({
      deleted: true,
      retryable: false,
      status: 404,
      reason: "not-found",
    });
  });

  it.each([401, 403])(
    "classifies non-retryable HTTP %s as terminal",
    async (status) => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ message: "Denied" }, status),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        deleteMessageWithResult("channel_1", "status_1", "token"),
      ).resolves.toEqual({
        deleted: false,
        retryable: false,
        status,
        reason: `http-${status}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([429, 503])(
    "classifies exhausted HTTP %s retries as retryable",
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () =>
        status === 429
          ? jsonResponse({ retry_after: 0.001 }, status)
          : jsonResponse({ message: "Unavailable" }, status),
      );
      vi.stubGlobal("fetch", fetchMock);

      const deletePromise = deleteMessageWithResult(
        "channel_1",
        "status_1",
        "token",
      );
      await vi.runAllTimersAsync();

      await expect(deletePromise).resolves.toEqual({
        deleted: false,
        retryable: true,
        status,
        reason: `http-${status}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("classifies exhausted network retries as retryable", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const deletePromise = deleteMessageWithResult(
      "channel_1",
      "status_1",
      "token",
    );
    await vi.runAllTimersAsync();

    await expect(deletePromise).resolves.toEqual({
      deleted: false,
      retryable: true,
      reason: "network-error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
