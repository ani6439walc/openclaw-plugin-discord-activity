import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStatusMessage,
  defaultStore,
  updateStatusMessage,
} from "./session.js";
import {
  createMockSessionEntry,
  createToolEntry,
  flushPromises,
} from "../test-helpers.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

describe("Discord status deletion recovery", () => {
  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("treats a Discord 404 as completed cleanup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Unknown Message" }, 404)),
    );
    const session = createMockSessionEntry({
      statusMessageId: "status_old",
      statusCreateNonce: "stale_nonce",
      confirmedDisplayState: {
        activeMemory: "removed",
        skillHarness: "collapsed",
      },
      monotonicSafetyFloor: {
        activeMemory: "removed",
        skillHarness: "removed",
      },
    });

    await clearStatusMessage(session, "test_cleanup", () => "token");

    expect(session.statusMessageId).toBeUndefined();
    expect(session.statusCreateNonce).toBeUndefined();
    expect(session.confirmedDisplayState).toBeUndefined();
    expect(session.monotonicSafetyFloor).toBeUndefined();
  });

  it.each([401, 403])(
    "does not schedule delayed recovery for HTTP %s",
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () =>
        jsonResponse({ message: "Denied" }, status),
      );
      vi.stubGlobal("fetch", fetchMock);
      const session = createMockSessionEntry({ statusMessageId: "status_old" });

      await clearStatusMessage(session, "test_cleanup", () => "token");
      await vi.runAllTimersAsync();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("retries one captured stale message after a retryable terminal failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal("fetch", fetchMock);
    const staleSession = createMockSessionEntry({
      statusMessageId: "status_old",
      generation: 1,
    });
    defaultStore.sessions.set(staleSession.contextKey, staleSession);

    const clearPromise = clearStatusMessage(
      staleSession,
      "test_cleanup",
      () => "token",
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await clearPromise;

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const replacement = createMockSessionEntry({
      statusMessageId: "status_new",
      generation: 2,
    });
    defaultStore.sessions.set(replacement.contextKey, replacement);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain(
      "/messages/status_old",
    );
    expect(replacement.statusMessageId).toBe("status_new");
  });

  it("releases max-display session state before bounded recovery runs", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "status_old" }))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "Unavailable" }, 503))
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal("fetch", fetchMock);
    const session = createMockSessionEntry({
      toolHistory: [createToolEntry({ status: "pending" })],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", false, 100);
    expect(session.statusMessageId).toBe("status_old");

    await vi.advanceTimersByTimeAsync(3_100);
    await flushPromises();

    expect(defaultStore.sessions.has(session.contextKey)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("serializes concurrent cleanup into one bounded recovery chain", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: "Unavailable" }, 503),
    );
    vi.stubGlobal("fetch", fetchMock);
    const session = createMockSessionEntry({ statusMessageId: "status_old" });

    const first = clearStatusMessage(session, "agent_cleanup", () => "token");
    const second = clearStatusMessage(
      session,
      "max_display_timeout",
      () => "token",
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.runAllTimersAsync();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(6);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each(["rate-limit", "network"])(
    "runs one bounded recovery chain after exhausted %s failures",
    async (failureMode) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => {
        if (failureMode === "network") {
          throw new Error("network unavailable");
        }
        return jsonResponse({ retry_after: 0.001 }, 429);
      });
      vi.stubGlobal("fetch", fetchMock);
      const session = createMockSessionEntry({ statusMessageId: "status_old" });

      const clearPromise = clearStatusMessage(
        session,
        "test_cleanup",
        () => "token",
      );
      await vi.runAllTimersAsync();
      await clearPromise;
      await flushPromises();

      expect(fetchMock).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    },
  );
});
