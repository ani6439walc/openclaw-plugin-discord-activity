import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLearnedNoticeHandler,
  parseSummaryReply,
  type LearnedNoticeCompletion,
} from "./learned-notice-hook.js";
import type { MessageContext } from "./types.js";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const RECENT_VERSION = "20261020T115900000Z-patch";
const UNDO = "跟我說還原就可以改回去。";
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
  });

  it("uses the LLM summary of the skill diff", async () => {
    complete.mockResolvedValue({ text: '{"alpha": "第二步會先檢查。"}' });
    const result = await handler()(
      { to: "channel:123", content: notice("updated `alpha` (tweak)") },
      discordCtx,
    );
    expect(result).toEqual({
      content: `已更新技能 \`alpha\`（第二步會先檢查）。${UNDO}`,
    });
    const params = complete.mock.calls[0]![0];
    expect(params).not.toHaveProperty("model");
    const prompt = params.messages[0].content;
    expect(prompt).toContain("## alpha (updated)");
    expect(prompt).toContain("-step 2\n+step 2 checked");
  });

  it("passes the configured summary model", async () => {
    complete.mockResolvedValue({ text: '{"alpha": "會先檢查"}' });
    await handler("bifrost/gpt-6-luna")(
      { to: "channel:123", content: notice("updated `alpha` (tweak)") },
      discordCtx,
    );
    expect(complete.mock.calls[0]![0].model).toBe("bifrost/gpt-6-luna");
  });

  it("appends the configured prompt to the language-neutral base prompt", async () => {
    complete.mockResolvedValue({ text: '{"alpha": "會先檢查"}' });
    await handler()(
      { to: "channel:123", content: notice("updated `alpha` (tweak)") },
      discordCtx,
    );
    await handler(undefined, "  用繁體中文撰寫摘要。 ")(
      { to: "channel:123", content: notice("updated `alpha` (tweak)") },
      discordCtx,
    );
    const base = complete.mock.calls[0]![0].systemPrompt;
    expect(base).not.toMatch(/Chinese|中文/);
    expect(complete.mock.calls[1]![0].systemPrompt).toBe(
      `${base}\n\n用繁體中文撰寫摘要。`,
    );
  });

  it("keeps original summaries for skills the LLM does not describe", async () => {
    complete.mockResolvedValue({ text: '{"alpha": "會先檢查"}' });
    const result = await handler()(
      {
        to: "channel:123",
        content: notice("updated `alpha` (tweak); archived `beta` (unused)"),
      },
      discordCtx,
    );
    expect(result?.content).toBe(
      `已更新技能 \`alpha\`（會先檢查）；已封存技能 \`beta\`（unused）。${UNDO}`,
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
      "the reply is not JSON",
      () => complete.mockResolvedValue({ text: "sorry" }),
    ],
  ])("falls back to the plain rewrite when %s", async (_label, arrange) => {
    arrange();
    const result = await handler()(
      { to: "channel:123", content: notice("updated `alpha` (tweak)") },
      discordCtx,
    );
    expect(result).toEqual({
      content: `已更新技能 \`alpha\`（tweak）。${UNDO}`,
    });
  });

  it("skips the LLM when there is no session agent, no diff, or only archive actions", async () => {
    const run = handler();
    const plain = { content: `已更新技能 \`alpha\`（tweak）。${UNDO}` };
    expect(
      await run(
        { to: "c", content: notice("updated `alpha` (tweak)") },
        { channelId: "discord" },
      ),
    ).toEqual(plain);
    expect(
      await run(
        { to: "c", content: notice("updated `missing` (tweak)") },
        discordCtx,
      ),
    ).toEqual({ content: `已更新技能 \`missing\`（tweak）。${UNDO}` });
    expect(
      await run({ to: "c", content: notice("archived `alpha`") }, discordCtx),
    ).toEqual({ content: `已封存技能 \`alpha\`。${UNDO}` });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("parseSummaryReply", () => {
  it("extracts known skills from a fenced or chatty reply", () => {
    expect(
      parseSummaryReply(
        'Sure:\n```json\n{"alpha": " 會 `先` 檢查。 ", "beta": 3, "other": "x"}\n```',
        ["alpha", "beta"],
      ),
    ).toEqual(new Map([["alpha", "會 先 檢查"]]));
  });

  it("truncates by code point without splitting a surrogate pair", () => {
    const value = `${"字".repeat(119)}😀😀`;
    const summary = parseSummaryReply(JSON.stringify({ alpha: value }), [
      "alpha",
    ]).get("alpha")!;
    expect(Array.from(summary)).toHaveLength(120);
    expect(summary.endsWith("😀")).toBe(true);
    expect(summary).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("returns an empty map for unusable replies", () => {
    expect(parseSummaryReply("[1]", ["alpha"]).size).toBe(0);
    expect(parseSummaryReply("{oops}", ["alpha"]).size).toBe(0);
  });
});
