import { describe, expect, it } from "vitest";
import {
  DEFAULT_REACTION_EMOJIS,
  DEFAULT_REACTION_EMOJI_CATEGORIES,
} from "./default-reaction-emojis.js";

describe("default reaction emoji snapshot", () => {
  it("contains the seven selected PiliApp categories without flags", () => {
    expect(Object.keys(DEFAULT_REACTION_EMOJI_CATEGORIES)).toEqual([
      "smileysPeople",
      "animalsNature",
      "foodDrink",
      "activities",
      "travelPlaces",
      "objects",
      "symbols",
    ]);
    expect(DEFAULT_REACTION_EMOJI_CATEGORIES.smileysPeople).toContain("😀");
    expect(DEFAULT_REACTION_EMOJI_CATEGORIES.animalsNature).toContain("🐶");
    expect(DEFAULT_REACTION_EMOJI_CATEGORIES.foodDrink).toContain("🍇");
    expect(DEFAULT_REACTION_EMOJI_CATEGORIES.activities).toContain("⚽");
    expect(DEFAULT_REACTION_EMOJI_CATEGORIES.travelPlaces).toContain("🌍");
    expect(DEFAULT_REACTION_EMOJI_CATEGORIES.objects).toContain("👓");
    expect(DEFAULT_REACTION_EMOJI_CATEGORIES.symbols).toContain("🏧");
    expect(DEFAULT_REACTION_EMOJIS).not.toContain("🇹🇼");
  });

  it("ships a complete deduplicated static pool", () => {
    expect(DEFAULT_REACTION_EMOJIS).toHaveLength(1644);
    expect(new Set(DEFAULT_REACTION_EMOJIS).size).toBe(1644);
    for (const entries of Object.values(DEFAULT_REACTION_EMOJI_CATEGORIES)) {
      expect(entries.length).toBeGreaterThan(100);
      expect(
        entries.every((emoji) => emoji.length > 0 && !/\s/u.test(emoji)),
      ).toBe(true);
    }
  });
});
