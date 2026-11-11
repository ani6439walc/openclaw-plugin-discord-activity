import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSystemPrompt,
  collapseRepetition,
  createLearnedNoticeHandler,
  normalizeNoticeReply,
  resolveLearnedNoticeOwner,
  type LearnedNoticeCompletion,
} from "./learned-notice-hook.js";
import type { ThinkingLevel } from "./config.js";
import type { MessageContext } from "./types.js";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const RECENT_VERSION = "20261020T115900000Z-patch";
const notice = (body: string) =>
  `💾 Learned: ${body}. Say "undo" to revert this skill change.`;
const discordCtx: MessageContext = {
  channelId: "discord",
  conversationId: "channel:123",
  sessionKey: "agent:main:discord:channel:123",
};

describe("createLearnedNoticeHandler", () => {
  let agentDir: string;
  let complete: ReturnType<typeof vi.fn<LearnedNoticeCompletion>>;

  async function write(relative: string, content: string) {
    const target = path.join(agentDir, "workshop-skills", relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  function handler(
    model?: string,
    promptAppend?: string,
    thinking?: ThinkingLevel,
  ) {
    return createLearnedNoticeHandler({
      resolveAgentDir: () => agentDir,
      resolveAgentId: (sessionKey) => sessionKey.split(":")[1],
      complete,
      resolveModel: model ? () => model : undefined,
      promptAppend,
      thinking,
      now: () => NOW,
    });
  }

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "learned-hook-"));
    complete = vi.fn<LearnedNoticeCompletion>();
    await write("alpha/SKILL.md", "step 1\nstep 2 checked\n");
    await write(
      `.archive/alpha/${RECENT_VERSION}/SKILL.md`,
      "step 1\nstep 2\n",
    );
  });

  afterEach(async () => {
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("returns nothing for an ordinary Discord reply", async () => {
    const text = "Done. 💾 Learned: is just a phrase here.";
    expect(
      await handler()({ to: "channel:123", content: text }, discordCtx),
    ).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns nothing outside Discord", async () => {
    expect(
      await handler()(
        { to: "x", content: notice("updated `alpha` (tweak)") },
        { channelId: "telegram", sessionKey: "agent:main:telegram:1" },
      ),
    ).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it("sends the model's whole message, built from the original notice and the diff", async () => {
    const original = notice("updated `alpha` (tweak)");
    complete.mockResolvedValue({
      text: "Updated `alpha` so step 2 is now checked.",
    });
    const result = await handler()(
      { to: "channel:123", content: original },
      discordCtx,
    );
    expect(result).toEqual({
      content: "Updated `alpha` so step 2 is now checked.",
    });
    const params = complete.mock.calls[0]![0];
    expect(params).not.toHaveProperty("model");
    const prompt = params.messages[0].content;
    expect(prompt).toContain(`Original notice: ${original}`);
    expect(prompt).toContain("## alpha");
    expect(prompt).toContain("-step 2\n+step 2 checked");
  });

  it("still asks the model when no diff or session is available", async () => {
    complete.mockResolvedValue({ text: "Archived `beta`." });
    expect(
      await handler()(
        { to: "c", content: notice("archived `beta` (unused)") },
        { channelId: "discord" },
      ),
    ).toEqual({ content: "Archived `beta`." });
    expect(complete.mock.calls[0]![0].messages[0].content).not.toContain(
      "```diff",
    );
  });

  it("passes the configured model and appends promptAppend to the system prompt", async () => {
    complete.mockResolvedValue({ text: "`alpha` changed." });
    await handler("bifrost/gpt-6-luna", "  Write in Traditional Chinese. ")(
      { to: "channel:123", content: notice("updated `alpha` (tweak)") },
      discordCtx,
    );
    const params = complete.mock.calls[0]![0];
    expect(params.model).toBe("bifrost/gpt-6-luna");
    expect(params.systemPrompt).toBe(
      `${buildSystemPrompt()}\n\nWrite in Traditional Chinese.`,
    );
  });

  it("passes the configured thinking level as reasoning, and none when unset", async () => {
    complete.mockResolvedValue({ text: "`alpha` changed." });
    const event = {
      to: "channel:123",
      content: notice("updated `alpha` (tweak)"),
    };
    await handler()(event, discordCtx);
    await handler(undefined, undefined, "medium")(event, discordCtx);
    expect(complete.mock.calls[0]![0]).not.toHaveProperty("reasoning");
    expect(complete.mock.calls[1]![0].reasoning).toBe("medium");
  });

  it("resolves the model for the notice's agent", async () => {
    complete.mockResolvedValue({ text: "`alpha` changed." });
    const resolveModel = vi.fn(() => "bifrost/gpt-6-luna");
    await createLearnedNoticeHandler({
      resolveAgentDir: () => agentDir,
      resolveAgentId: (sessionKey) => sessionKey.split(":")[1],
      complete,
      resolveModel,
      now: () => NOW,
    })(
      { to: "channel:123", content: notice("updated `alpha` (tweak)") },
      discordCtx,
    );
    expect(resolveModel).toHaveBeenCalledWith("main");
    expect(complete.mock.calls[0]![0].model).toBe("bifrost/gpt-6-luna");
  });

  it("sends the original notice when resolving the model throws", async () => {
    const result = await createLearnedNoticeHandler({
      resolveAgentDir: () => agentDir,
      resolveAgentId: (sessionKey) => sessionKey.split(":")[1],
      complete,
      resolveModel: () => {
        throw new Error("bad config");
      },
      now: () => NOW,
    })(
      { to: "channel:123", content: notice("updated `alpha` (tweak)") },
      discordCtx,
    );
    expect(result).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the completion throws",
      () =>
        complete.mockRejectedValue(
          Object.assign(new Error("x"), { code: "LLM_COMPLETION_TIMEOUT" }),
        ),
    ],
    [
      "the reply drops a skill name",
      () => complete.mockResolvedValue({ text: "Something changed." }),
    ],
    ["the reply is empty", () => complete.mockResolvedValue({ text: "  " })],
  ])("sends the original notice when %s", async (_label, arrange) => {
    arrange();
    expect(
      await handler()(
        { to: "channel:123", content: notice("updated `alpha` (tweak)") },
        discordCtx,
      ),
    ).toBeUndefined();
  });

  it("never sends files outside the workshop when a skill root is a symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "learned-out-"));
    try {
      await fs.writeFile(path.join(outside, "private-marker.txt"), "secret\n");
      await fs.symlink(outside, path.join(agentDir, "workshop-skills", "beta"));
      complete.mockResolvedValue({ text: "Created `beta`." });
      expect(
        await handler()(
          { to: "c", content: notice("created `beta` (new)") },
          discordCtx,
        ),
      ).toEqual({ content: "Created `beta`." });
      const prompt = complete.mock.calls[0]![0].messages[0].content;
      expect(prompt).not.toContain("private-marker");
      expect(prompt).not.toContain("secret");
      expect(prompt).not.toContain("```diff");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it.each([
    ["the workshop root", "root"],
    ["the archive after its listing", "archive"],
  ])(
    "keeps outside files out of the prompt when %s is a symlink",
    async (_label, target) => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "learned-out-"));
      const marker = "SYNTHETIC_OUTSIDE_MARKER";
      const skillsRoot = path.join(agentDir, "workshop-skills");
      const versionsDir = path.join(skillsRoot, ".archive", "alpha");
      try {
        if (target === "root") {
          await fs.mkdir(path.join(outside, "alpha"), { recursive: true });
          await fs.writeFile(path.join(outside, "alpha", "SKILL.md"), marker);
          await fs.rm(skillsRoot, { recursive: true });
          await fs.symlink(outside, skillsRoot);
        } else {
          await fs.mkdir(path.join(outside, RECENT_VERSION), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(outside, RECENT_VERSION, "SKILL.md"),
            marker,
          );
          const realReaddir = fs.readdir;
          vi.spyOn(fs, "readdir").mockImplementation(
            async (...args: unknown[]) => {
              const entries = await (
                realReaddir as (...a: unknown[]) => unknown
              )(...args);
              if (String(args[0]) === versionsDir) {
                await fs.rename(versionsDir, `${versionsDir}-moved`);
                await fs.symlink(outside, versionsDir);
              }
              return entries as never;
            },
          );
        }
        // A created notice reads the live tree with no baseline, so the root case is exercised.
        const verb = target === "root" ? "created" : "updated";
        complete.mockResolvedValue({ text: "Changed `alpha`." });
        expect(
          await handler()(
            { to: "c", content: notice(`${verb} \`alpha\` (tweak)`) },
            discordCtx,
          ),
        ).toEqual({ content: "Changed `alpha`." });
        const prompt = complete.mock.calls[0]![0].messages[0].content;
        expect(prompt).not.toContain(marker);
        expect(prompt).not.toContain("```diff");
      } finally {
        vi.restoreAllMocks();
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it("still rewrites without diffs when the agent directory cannot be resolved", async () => {
    complete.mockResolvedValue({ text: "`alpha` and `beta` changed." });
    const run = createLearnedNoticeHandler({
      resolveAgentDir: () => {
        throw new Error("no agent dir");
      },
      resolveAgentId: () => "main",
      complete,
      now: () => NOW,
    });
    expect(
      await run(
        {
          to: "c",
          content: notice("updated `alpha` (a); updated `beta` (b)"),
        },
        discordCtx,
      ),
    ).toEqual({ content: "`alpha` and `beta` changed." });
    expect(complete.mock.calls[0]![0].messages[0].content).not.toContain(
      "```diff",
    );
  });
});

describe("normalizeNoticeReply", () => {
  it("keeps one copy when the model writes the message twice", () => {
    const once =
      "🔍 已更新 `dual-remote-pr`：現在會用合成資料重現問題，確認回歸測試在舊版失敗、新版通過。";
    expect(normalizeNoticeReply(`${once}${once}`, ["dual-remote-pr"])).toBe(
      once,
    );
    expect(normalizeNoticeReply(`${once}\n\n${once}`, ["dual-remote-pr"])).toBe(
      once,
    );
  });

  it("strips fences and surrounding quotes", () => {
    expect(
      normalizeNoticeReply('```\n"🔧 Updated `alpha`."\n```', ["alpha"]),
    ).toBe("🔧 Updated `alpha`.");
  });

  it("requires every skill name", () => {
    expect(
      normalizeNoticeReply("Updated `alpha`.", ["alpha", "beta"]),
    ).toBeUndefined();
    expect(
      normalizeNoticeReply("Updated `alpha` and `beta`.", ["alpha", "beta"]),
    ).toBe("Updated `alpha` and `beta`.");
  });

  it("rejects replies over the length limit, counting code points", () => {
    expect(
      normalizeNoticeReply(`\`alpha\` ${"😀".repeat(1_500)}`, ["alpha"]),
    ).toBeUndefined();
    expect(
      normalizeNoticeReply(`\`alpha\` ${"😀".repeat(1_400)}`, ["alpha"]),
    ).toBeDefined();
  });
});

describe("buildSystemPrompt", () => {
  it("is language-neutral and lists the required parts with an example", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toMatch(/Chinese|中文/);
    expect(prompt).toContain("backticks");
    expect(prompt).toContain(
      'Do not include any hint or instruction about saying "undo" or reverting the change',
    );
    expect(prompt).toContain("Example output:");
    expect(prompt).not.toContain(
      'Say "undo" if you want the old version back.',
    );
  });

  it("asks for a leading emoji, no colon after the skill name, and a single version", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "one emoji that fits the change, at the very start",
    );
    expect(prompt).toContain(
      "Put no colon or other punctuation right after the skill name.",
    );
    expect(prompt).toContain("Write exactly one version of the message");
    // The example output follows the same format it asks for.
    expect(prompt).toMatch(
      /Example output:\n🔧 Updated `deploy-staging` to check that the image tag matches the release before deploying\.$/u,
    );
  });
});

describe("collapseRepetition", () => {
  it("collapses any number of identical blocks, ignoring whitespace between them", () => {
    expect(collapseRepetition("Updated `a`. Updated `a`. Updated `a`.")).toBe(
      "Updated `a`.",
    );
    expect(collapseRepetition("A b.\nA b.")).toBe("A b.");
  });

  it("leaves text that is not an exact repetition unchanged", () => {
    const distinct = "Updated `a`: now checks tags. Updated `b`: now retries.";
    expect(collapseRepetition(distinct)).toBe(distinct);
    expect(collapseRepetition("Updated `a`. Updated `a`")).toBe(
      "Updated `a`. Updated `a`",
    );
    expect(collapseRepetition("")).toBe("");
  });
});

describe("resolveLearnedNoticeOwner", () => {
  const parseSessionAgentId = (sessionKey: string) => {
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return match?.[1]?.toLowerCase();
  };

  it("omits completionAgentId when the source agent matches the ambient owner and sets it for non-default agents", () => {
    expect(
      resolveLearnedNoticeOwner({
        sessionKey: "agent:main:discord:channel:123",
        parseSessionAgentId,
        configuredAgentIds: ["main", "work"],
        ambientOwnerId: "main",
      }),
    ).toEqual({
      kind: "agent",
      agentId: "main",
      completionAgentId: undefined,
    });

    expect(
      resolveLearnedNoticeOwner({
        sessionKey: "agent:work:discord:channel:123",
        parseSessionAgentId,
        configuredAgentIds: ["main", "work"],
        ambientOwnerId: "main",
      }),
    ).toEqual({
      kind: "agent",
      agentId: "work",
      completionAgentId: "work",
    });

    // Multi-agent fleet with no ambient owner passes completionAgentId for every configured agent.
    expect(
      resolveLearnedNoticeOwner({
        sessionKey: "agent:main:discord:channel:123",
        parseSessionAgentId,
        configuredAgentIds: ["main", "work"],
        ambientOwnerId: undefined,
      }),
    ).toEqual({
      kind: "agent",
      agentId: "main",
      completionAgentId: "main",
    });
  });

  it("treats missing or legacy unscoped Discord keys as unscoped and rejects internal, malformed, or unknown keys", () => {
    for (const sessionKey of [undefined, "", "  ", "discord:channel:123"]) {
      expect(
        resolveLearnedNoticeOwner({
          sessionKey,
          parseSessionAgentId,
          configuredAgentIds: ["main", "work"],
          ambientOwnerId: "main",
        }),
      ).toEqual({ kind: "unscoped" });
    }

    for (const sessionKey of [
      "agent:work:discord:channel:123:subagent:child",
      "agent:work:discord:channel:123:skill-harness-review:1",
      "agent:work:discord:channel:123:active-memory:1",
    ]) {
      expect(
        resolveLearnedNoticeOwner({
          sessionKey,
          parseSessionAgentId,
          configuredAgentIds: ["main", "work"],
          ambientOwnerId: "main",
        }),
      ).toEqual({ kind: "invalid", reason: "internal-session" });
    }

    for (const sessionKey of [
      "agent:../work:discord:channel:123",
      "agent::discord:channel:123",
      "agent:work",
      "user:work",
      "untrusted-session",
    ]) {
      expect(
        resolveLearnedNoticeOwner({
          sessionKey,
          parseSessionAgentId: () => "main", // Even if parser tried normalizing invalid input to "main"!
          configuredAgentIds: ["main", "work"],
          ambientOwnerId: "main",
        }),
      ).toMatchObject({ kind: "invalid", reason: "invalid-session-key" });
    }

    expect(
      resolveLearnedNoticeOwner({
        sessionKey: "agent:ghost:discord:channel:123",
        parseSessionAgentId,
        configuredAgentIds: ["main", "work"],
        ambientOwnerId: "main",
      }),
    ).toEqual({
      kind: "invalid",
      reason: "unknown-agent",
      rawAgentId: "ghost",
    });
  });

  it("preserves the original notice without cascading when host completion denies agentId override", async () => {
    const complete = vi.fn<LearnedNoticeCompletion>(async () => {
      throw Object.assign(new Error("agentId override denied"), {
        code: "LLM_COMPLETION_NOT_AUTHORIZED",
      });
    });
    const resolveAgentDir = vi.fn(() => "/nonexistent-dir");
    const run = createLearnedNoticeHandler({
      prepareOperation: () => ({
        resolveNoticeOwner: (sessionKey) =>
          resolveLearnedNoticeOwner({
            sessionKey,
            parseSessionAgentId,
            configuredAgentIds: ["main", "work"],
            ambientOwnerId: "main",
          }),
        resolveAgentDir,
        resolveModel: () => "anthropic/claude-haiku-4-5",
      }),
      complete,
      now: () => NOW,
    });

    const result = await run(
      {
        to: "channel:123",
        content: notice("updated `alpha` (tweak)"),
      },
      {
        channelId: "discord",
        sessionKey: "agent:work:discord:channel:123",
      },
    );
    expect(result).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      agentId: "work",
      model: "anthropic/claude-haiku-4-5",
    });
  });
});
