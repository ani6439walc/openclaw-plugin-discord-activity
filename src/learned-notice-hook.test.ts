import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSystemPrompt,
  createLearnedNoticeHandler,
  normalizeNoticeReply,
  type LearnedNoticeCompletion,
} from "./learned-notice-hook.js";
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

  function handler(model?: string, promptAppend?: string) {
    return createLearnedNoticeHandler({
      resolveAgentDir: () => agentDir,
      resolveAgentId: (sessionKey) => sessionKey.split(":")[1],
      complete,
      model,
      promptAppend,
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
      text: "Updated `alpha`: step 2 is now checked. Say undo to revert.",
    });
    const result = await handler()(
      { to: "channel:123", content: original },
      discordCtx,
    );
    expect(result).toEqual({
      content: "Updated `alpha`: step 2 is now checked. Say undo to revert.",
    });
    const params = complete.mock.calls[0]![0];
    expect(params).not.toHaveProperty("model");
    const prompt = params.messages[0].content;
    expect(prompt).toContain(`Original notice: ${original}`);
    expect(prompt).toContain("## alpha");
    expect(prompt).toContain("-step 2\n+step 2 checked");
  });

  it("still asks the model when no diff or session is available", async () => {
    complete.mockResolvedValue({ text: "Archived `beta`. Say undo." });
    expect(
      await handler()(
        { to: "c", content: notice("archived `beta` (unused)") },
        { channelId: "discord" },
      ),
    ).toEqual({ content: "Archived `beta`. Say undo." });
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
    expect(prompt).toContain("undo");
    expect(prompt).toContain("Example output:");
  });
});
