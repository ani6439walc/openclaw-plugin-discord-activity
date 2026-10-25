import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import {
  rememberRecentEmoji,
  resolveReactionEmojiPool,
  sampleReactionCandidates,
} from "./reaction-candidates.js";

describe("reaction candidates", () => {
  it("uses the built-in pool by default and honors explicit disable or an empty list", () => {
    expect(
      resolveReactionEmojiPool(resolveConfig({}).messageReaction),
    ).toHaveLength(1644);
    expect(
      resolveReactionEmojiPool(
        resolveConfig({ messageReaction: { enabled: false } }).messageReaction,
      ),
    ).toEqual([]);
    expect(
      resolveReactionEmojiPool(
        resolveConfig({ messageReaction: { enabled: true, emojis: [] } })
          .messageReaction,
      ),
    ).toEqual([]);
  });

  it("uses a custom list in place of defaults and deduplicates it", () => {
    const config = resolveConfig({
      messageReaction: {
        enabled: true,
        emojis: ["😀", { emoji: "😀", meaning: "smile" }, "🐶"],
      },
    });
    expect(resolveReactionEmojiPool(config.messageReaction)).toEqual([
      { emoji: "😀" },
      { emoji: "🐶" },
    ]);
  });

  it("samples no more than 10 unique choices without replacement", () => {
    const pool = Array.from({ length: 40 }, (_, index) => ({
      emoji: `item-${index}`,
    }));
    const sample = sampleReactionCandidates(pool, () => 0.5);
    expect(sample).toHaveLength(10);
    expect(new Set(sample.map((candidate) => candidate.emoji)).size).toBe(10);
    expect(sample.every((candidate) => pool.includes(candidate))).toBe(true);
    expect(sampleReactionCandidates(pool.slice(0, 2), () => 0.5)).toHaveLength(
      2,
    );
  });

  it("keeps every entry and meaning when the pool has at most 10 emoji", () => {
    const pool = Array.from({ length: 10 }, (_, index) => ({
      emoji: `item-${index}`,
      meaning: `meaning-${index}`,
    }));
    expect(sampleReactionCandidates(pool, () => 0.5)).toEqual(
      expect.arrayContaining(pool),
    );
    expect(sampleReactionCandidates([])).toEqual([]);
  });

  it("excludes the 10 most recent emoji and keeps the newest unique entry", () => {
    const pool = Array.from({ length: 30 }, (_, index) => ({
      emoji: `item-${index}`,
    }));
    const recent = Array.from({ length: 10 }, (_, index) => `item-${index}`);
    const sample = sampleReactionCandidates(pool, () => 0, recent);
    expect(sample).toHaveLength(10);
    expect(sample.some((candidate) => recent.includes(candidate.emoji))).toBe(
      false,
    );

    const withStale = sampleReactionCandidates(pool, () => 0, recent.slice(1));
    expect(withStale.map((candidate) => candidate.emoji)).toContain("item-0");
    expect(
      withStale.some((candidate) => recent.slice(1).includes(candidate.emoji)),
    ).toBe(false);

    let history: string[] = [];
    for (const emoji of [...recent, "item-3", "item-10"]) {
      history = rememberRecentEmoji(history, emoji);
    }
    expect(history).toEqual([
      ...recent.slice(1).filter((emoji) => emoji !== "item-3"),
      "item-3",
      "item-10",
    ]);
  });

  it("uses the full pool when every emoji was used recently", () => {
    const pool = [{ emoji: "only" }];
    expect(sampleReactionCandidates(pool, () => 0, ["only"])).toEqual(pool);
  });
});
