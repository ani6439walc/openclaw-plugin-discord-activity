import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultStore, updateStatusMessage } from "./session.js";
import { createMockSessionEntry, createToolEntry } from "../test-helpers.js";
import { renderStatusContent } from "./render.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("updateStatusMessage", () => {
  afterEach(() => {
    defaultStore.sessions.clear();
    defaultStore.contexts.clear();
    vi.unstubAllGlobals();
  });

  it("does not create a non-final status message for a finalized session without a message id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "status_1" }));
    vi.stubGlobal("fetch", fetchMock);

    const session = createMockSessionEntry({
      finalized: true,
      statusMessageId: undefined,
      toolHistory: [createToolEntry({ status: "pending" })],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", false, 60_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.statusMessageId).toBeUndefined();
  });

  it("creates a final status message for a finalized session when none exists yet", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/users/@me/channels") && method === "POST") {
        return jsonResponse({ id: "dm_channel_123" });
      }
      if (
        url.includes("/channels/dm_channel_123/messages") &&
        method === "POST"
      ) {
        return jsonResponse({ id: "status_1" });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = createMockSessionEntry({
      channelId: "123",
      ownerSessionKey: "agent:main:discord:direct:123",
      finalized: true,
      statusMessageId: undefined,
      toolHistory: [createToolEntry({ status: "completed" })],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(session.channelId).toBe("dm_channel_123");
    expect(session.statusMessageId).toBe("status_1");
  });

  it("still edits the existing status message for a finalized session", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/messages/status_1") && method === "PATCH") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = createMockSessionEntry({
      finalized: true,
      statusMessageId: "status_1",
      toolHistory: [createToolEntry({ status: "completed" })],
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/messages/status_1");
    expect((init as RequestInit | undefined)?.method).toBe("PATCH");
  });

  it("skips editing when the rendered content is unchanged", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const toolHistory = [createToolEntry({ status: "completed" })];
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory,
      lastRenderedContent: renderStatusContent(toolHistory, true),
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores rendered content after a successful edit", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const toolHistory = [createToolEntry({ status: "completed" })];
    const expectedContent = renderStatusContent(toolHistory, true);
    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory,
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.lastRenderedContent).toBe(expectedContent);
  });

  it("trims rendered status content using the configured max length", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const session = createMockSessionEntry({
      statusMessageId: "status_1",
      toolHistory: [
        createToolEntry({
          toolCallId: "call_drop",
          params: { command: "x".repeat(180) },
        }),
        createToolEntry({
          toolCallId: "call_keep",
          params: { command: "ok" },
        }),
      ],
      lastRenderedContent: "old-content",
    });
    defaultStore.sessions.set(session.contextKey, session);

    await updateStatusMessage(session, () => "token", true, 60_000, 120);

    expect(session.toolHistory.map((entry) => entry.toolCallId)).toEqual([
      "call_keep",
    ]);
    expect(session.lastRenderedContent?.length).toBeLessThanOrEqual(120);
  });
});
