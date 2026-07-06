import { describe, it, expect, beforeEach } from "vitest";
import { createSessionStore } from "./store.js";
import type { ChannelMeta } from "./types.js";

describe("createSessionStore", () => {
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    store = createSessionStore();
  });

  describe("getOrCreateSession", () => {
    it("returns undefined when no context exists", () => {
      const session = store.getOrCreateSession("discord:channel:123");
      expect(session).toBeUndefined();
    });

    it("creates session when context exists", () => {
      store.contexts.set("discord:channel:123", {
        actualChannelId: "123",
        userMessageId: "msg_001",
        senderId: "user_001",
      });
      const session = store.getOrCreateSession("discord:channel:123");
      expect(session).toBeDefined();
      expect(session?.channelId).toBe("123");
      expect(session?.toolHistory).toEqual([]);
    });

    it("returns existing session for matching owner", () => {
      store.contexts.set("discord:channel:123", {
        actualChannelId: "123",
        sourceSessionKey: "discord:channel:123:agent:abc",
      });
      const first = store.getOrCreateSession(
        "discord:channel:123",
        "discord:channel:123:agent:abc",
      );
      const second = store.getOrCreateSession(
        "discord:channel:123",
        "discord:channel:123:agent:abc",
      );
      expect(second).toBe(first);
    });
  });

  describe("isCurrentSession", () => {
    it("returns true for active session", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      expect(store.isCurrentSession(session)).toBe(true);
    });

    it("returns false for replaced session", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const oldSession = store.getOrCreateSession("discord:channel:123")!;
      store.sessions.set("discord:channel:123", {
        ...oldSession,
        generation: 2,
      });
      expect(store.isCurrentSession(oldSession)).toBe(false);
    });
  });

  describe("hasVisibleStatusState", () => {
    it("returns false for empty history", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      expect(store.hasVisibleStatusState(session)).toBe(false);
    });

    it("returns false for active-memory placeholder only", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      session.toolHistory.push({
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "pending",
      });
      expect(store.hasVisibleStatusState(session)).toBe(false);
    });

    it("returns false for skill-harness placeholder only", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      session.toolHistory.push({
        toolCallId: "skill-harness",
        toolName: "skill-harness",
        params: {},
        status: "pending",
      });
      expect(store.hasVisibleStatusState(session)).toBe(false);
    });

    it("returns false for active-memory and skill-harness placeholders only", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      session.toolHistory.push(
        {
          toolCallId: "active-memory",
          toolName: "active-memory",
          params: {},
          status: "pending",
        },
        {
          toolCallId: "skill-harness",
          toolName: "skill-harness",
          params: {},
          status: "pending",
        },
      );
      expect(store.hasVisibleStatusState(session)).toBe(false);
    });

    it("returns true for active-memory error state", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      session.toolHistory.push({
        toolCallId: "active-memory",
        toolName: "active-memory",
        params: {},
        status: "error",
      });
      expect(store.hasVisibleStatusState(session)).toBe(true);
    });

    it("returns true for real tool entries", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      session.toolHistory.push({
        toolCallId: "call_1",
        toolName: "bash",
        params: {},
        status: "pending",
      });
      expect(store.hasVisibleStatusState(session)).toBe(true);
    });
  });

  describe("clearSessionState", () => {
    it("removes session and context", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      store.clearSessionState("discord:channel:123", session);
      expect(store.sessions.has("discord:channel:123")).toBe(false);
      expect(store.contexts.has("discord:channel:123")).toBe(false);
    });

    it("skips when generation mismatch", () => {
      store.contexts.set("discord:channel:123", { actualChannelId: "123" });
      const session = store.getOrCreateSession("discord:channel:123")!;
      store.clearSessionState("discord:channel:123", session, 999);
      expect(store.sessions.has("discord:channel:123")).toBe(true);
    });
  });
});
