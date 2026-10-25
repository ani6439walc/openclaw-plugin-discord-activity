import type { PluginConfig } from "./config.js";
import { DEFAULT_REACTION_EMOJIS } from "./default-reaction-emojis.js";

export type ReactionEmoji = { emoji: string; meaning?: string };

export function resolveReactionEmojiPool(
  config: PluginConfig["messageReaction"],
): ReactionEmoji[] {
  if (!config?.enabled) return [];

  const configured = config.emojis ?? DEFAULT_REACTION_EMOJIS;
  const seen = new Set<string>();
  const pool: ReactionEmoji[] = [];
  for (const item of configured) {
    const candidate = typeof item === "string" ? { emoji: item } : item;
    if (seen.has(candidate.emoji)) continue;
    seen.add(candidate.emoji);
    pool.push(candidate);
  }
  return pool;
}

export function sampleReactionCandidates(
  pool: readonly ReactionEmoji[],
  random: () => number = Math.random,
): ReactionEmoji[] {
  const choices = [...pool];
  const count = Math.min(10, choices.length);
  for (let index = 0; index < count; index += 1) {
    const swapIndex = index + Math.floor(random() * (choices.length - index));
    [choices[index], choices[swapIndex]] = [
      choices[swapIndex]!,
      choices[index]!,
    ];
  }
  return choices.slice(0, count);
}
