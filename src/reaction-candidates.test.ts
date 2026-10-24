import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import {
  resolveReactionEmojiPool,
  sampleReactionCandidates,
} from "./reaction-candidates.js";

describe("reaction candidates", () => {
  it("uses the built-in pool only when enabled and no override is present", () => {
    expect(resolveReactionEmojiPool(resolveConfig({}).messageReaction)).toEqual(
      [],
    );
    expect(
      resolveReactionEmojiPool(
        resolveConfig({ messageReaction: { enabled: true } }).messageReaction,
      ),
    ).toHaveLength(1644);
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

  it("samples no more than 30 unique choices without replacement", () => {
    const pool = Array.from({ length: 40 }, (_, index) => ({
      emoji: `item-${index}`,
    }));
    const sample = sampleReactionCandidates(pool, () => 0.5);
    expect(sample).toHaveLength(30);
    expect(new Set(sample.map((candidate) => candidate.emoji)).size).toBe(30);
    expect(sample.every((candidate) => pool.includes(candidate))).toBe(true);
    expect(sampleReactionCandidates(pool.slice(0, 2), () => 0.5)).toHaveLength(
      2,
    );
  });
});
