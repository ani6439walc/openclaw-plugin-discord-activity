import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import { createMessageReactionHandler } from "./message-reaction.js";

const message = {
  messageId: "234567890123456789",
  content: "Finished the release!",
};
const context = {
  channelId: "discord",
  accountId: "default",
  sessionKey: "agent:main:discord:direct:123456789012345678",
};

function decision(choice: string) {
  return {
    status: "ok" as const,
    result: {
      model: "jev-latest",
      answers: {
        reaction: {
          type: "choice" as const,
          choice,
          probabilities: {},
        },
      },
    },
    provenance: {
      providerId: "typesafe",
      rubricVersion: "1",
      runtimeGeneration: "test",
    },
  };
}

function setup(
  emojis: unknown[] = ["🎉", "🐶"],
  decisionModel = "typesafe/jev-latest",
) {
  const evaluate = vi.fn(async () => decision("emoji_0"));
  const getSessionEntry = vi.fn(async () => ({
    activitySummary: { text: "The user was preparing a release." },
  }));
  const resolveDmChannel = vi.fn(async () => "345678901234567890");
  const addReaction = vi.fn(async () => ({
    outcome: "applied" as const,
    reason: "created",
  }));
  const handler = createMessageReactionHandler({
    config: resolveConfig({ messageReaction: { enabled: true, emojis } })
      .messageReaction,
    resolveDecisionModel: () => decisionModel,
    getSessionEntry,
    evaluate,
    getToken: () => "token",
    resolveDmChannel,
    addReaction,
    random: () => 0,
  });
  return { handler, evaluate, getSessionEntry, resolveDmChannel, addReaction };
}

describe("message reaction handler", () => {
  afterEach(() => vi.useRealTimers());

  it("uses recap and latest text, then reacts on the original DM message", async () => {
    const {
      handler,
      evaluate,
      getSessionEntry,
      resolveDmChannel,
      addReaction,
    } = setup();
    await handler.onMessageReceived(message, context);

    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledTimes(1));
    expect(getSessionEntry).toHaveBeenCalledWith("main", context.sessionKey);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {
          previousRecap: "The user was preparing a release.",
          latestMessage: message.content,
        },
        questions: {
          reaction: expect.objectContaining({
            type: "choice",
            criteria: expect.objectContaining({ none: expect.any(String) }),
          }),
        },
      }),
      expect.objectContaining({
        agentId: "main",
        purpose: "discord-activity.message-reaction",
        rubricVersion: "1",
        timeoutMs: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(resolveDmChannel).toHaveBeenCalledWith(
      "123456789012345678",
      "token",
      expect.any(AbortSignal),
      "default",
    );
    expect(addReaction).toHaveBeenCalledWith(
      "345678901234567890",
      message.messageId,
      "🎉",
      "token",
      expect.any(AbortSignal),
    );
  });

  it("does not react for none, invalid answers, or missing recap", async () => {
    const { handler, evaluate, getSessionEntry, addReaction } = setup();
    getSessionEntry.mockResolvedValueOnce({
      activitySummary: { text: "" },
    });
    evaluate.mockResolvedValueOnce(decision("none"));
    await handler.onMessageReceived(message, context);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    expect(evaluate.mock.calls[0]?.[0].state).toEqual({
      previousRecap: "",
      latestMessage: message.content,
    });
    expect(addReaction).not.toHaveBeenCalled();

    evaluate.mockResolvedValueOnce(decision("some-other-emoji"));
    await handler.onMessageReceived(
      { ...message, messageId: "234567890123456780" },
      context,
    );
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(2));
    expect(addReaction).not.toHaveBeenCalled();

    evaluate.mockResolvedValueOnce(decision("emoji_00"));
    await handler.onMessageReceived(
      { ...message, messageId: "234567890123456781" },
      context,
    );
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("returns before Jev resolves and deduplicates the same message", async () => {
    const { handler, evaluate, addReaction } = setup();
    let resolveDecision!: (value: ReturnType<typeof decision>) => void;
    evaluate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );

    await handler.onMessageReceived(message, context);
    await handler.onMessageReceived(message, context);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    expect(addReaction).not.toHaveBeenCalled();

    resolveDecision(decision("emoji_0"));
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledTimes(1));
  });

  it("keeps two concurrent messages and their choices separate", async () => {
    const { handler, evaluate, addReaction } = setup();
    const resolveDecisions: Array<
      (value: ReturnType<typeof decision>) => void
    > = [];
    evaluate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDecisions.push(resolve);
        }),
    );
    const secondMessageId = "234567890123456780";
    await handler.onMessageReceived(message, context);
    await handler.onMessageReceived(
      { ...message, messageId: secondMessageId, content: "Look at this dog" },
      context,
    );
    await vi.waitFor(() => expect(resolveDecisions).toHaveLength(2));

    resolveDecisions[1]!(decision("emoji_1"));
    resolveDecisions[0]!(decision("emoji_0"));
    await vi.waitFor(() => expect(addReaction).toHaveBeenCalledTimes(2));
    expect(addReaction).toHaveBeenCalledWith(
      "345678901234567890",
      message.messageId,
      "🎉",
      "token",
      expect.any(AbortSignal),
    );
    expect(addReaction).toHaveBeenCalledWith(
      "345678901234567890",
      secondMessageId,
      "🐶",
      "token",
      expect.any(AbortSignal),
    );
  });

  it("does not react after the total deadline", async () => {
    vi.useFakeTimers();
    const { handler, evaluate, addReaction } = setup();
    let resolveDecision!: (value: ReturnType<typeof decision>) => void;
    evaluate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    await handler.onMessageReceived(message, context);
    await vi.advanceTimersByTimeAsync(7000);
    resolveDecision(decision("emoji_0"));
    await Promise.resolve();
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("continues without recap and skips unavailable decisions", async () => {
    const { handler, getSessionEntry, evaluate, addReaction } = setup();
    getSessionEntry.mockRejectedValueOnce(new Error("store unavailable"));
    evaluate.mockImplementationOnce(
      async () =>
        ({ status: "unavailable", reason: "not-configured" }) as never,
    );

    await handler.onMessageReceived(message, context);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    expect(evaluate.mock.calls[0]?.[0].state).toEqual({
      previousRecap: "",
      latestMessage: message.content,
    });
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("cancels pending work when the plugin stops", async () => {
    const { handler, evaluate, addReaction } = setup();
    let resolveDecision!: (value: ReturnType<typeof decision>) => void;
    evaluate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    await handler.onMessageReceived(message, context);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    handler.stop();
    resolveDecision(decision("emoji_0"));
    await Promise.resolve();
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("offers 30 default emoji plus none when no custom list is configured", async () => {
    const evaluate = vi.fn(async () => decision("none"));
    const handler = createMessageReactionHandler({
      config: resolveConfig({ messageReaction: { enabled: true } })
        .messageReaction,
      resolveDecisionModel: () => "typesafe/jev-latest",
      getSessionEntry: vi.fn(async () => undefined),
      evaluate,
      getToken: () => "token",
      resolveDmChannel: vi.fn(),
      addReaction: vi.fn(),
      random: () => 0,
    });

    await handler.onMessageReceived(message, context);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    const criteria = evaluate.mock.calls[0]?.[0].questions.reaction.criteria;
    expect(Object.keys(criteria)).toHaveLength(31);
    expect(criteria).toHaveProperty("none");
  });

  it("drops overload instead of queueing unbounded reaction work", async () => {
    const { handler, getSessionEntry, evaluate } = setup();
    getSessionEntry.mockImplementation(() => new Promise(() => {}));
    for (let index = 0; index < 9; index += 1) {
      await handler.onMessageReceived(
        { ...message, messageId: String(234567890123456780n + BigInt(index)) },
        context,
      );
    }
    expect(getSessionEntry).toHaveBeenCalledTimes(8);
    expect(evaluate).not.toHaveBeenCalled();
    handler.stop();
  });

  it("skips disabled, non-DM, and non-Jev messages", async () => {
    const { handler, evaluate } = setup();
    await handler.onMessageReceived(message, {
      ...context,
      sessionKey: "agent:main:discord:channel:123456789012345678",
    });
    expect(evaluate).not.toHaveBeenCalled();

    const disabled = createMessageReactionHandler({
      config: resolveConfig({}).messageReaction,
      resolveDecisionModel: () => "typesafe/jev-latest",
      getSessionEntry: vi.fn(),
      evaluate,
      getToken: () => "token",
      resolveDmChannel: vi.fn(),
      addReaction: vi.fn(),
    });
    await disabled.onMessageReceived(message, context);
    expect(evaluate).not.toHaveBeenCalled();

    const otherModel = setup(["🎉"], "openai/gpt-6-luna");
    await otherModel.handler.onMessageReceived(message, context);
    expect(otherModel.evaluate).not.toHaveBeenCalled();
  });

  it("skips missing token or source message ID before evaluating", async () => {
    const evaluate = vi.fn(async () => decision("emoji_0"));
    const handler = createMessageReactionHandler({
      config: resolveConfig({
        messageReaction: { enabled: true, emojis: ["🎉"] },
      }).messageReaction,
      resolveDecisionModel: () => "typesafe/jev-latest",
      getSessionEntry: vi.fn(),
      evaluate,
      getToken: () => "",
      resolveDmChannel: vi.fn(),
      addReaction: vi.fn(),
    });
    await handler.onMessageReceived(message, context);
    await handler.onMessageReceived({ content: message.content }, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(evaluate).not.toHaveBeenCalled();
  });
});
