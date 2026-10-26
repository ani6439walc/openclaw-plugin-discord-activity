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

const SAMPLE_COUNT = 10;
const RECENT_EMOJI_LIMIT = 10;

export function rememberRecentEmoji(
  recent: readonly string[],
  emoji: string,
): string[] {
  const next = recent.filter((entry) => entry !== emoji);
  next.push(emoji);
  return next.slice(-RECENT_EMOJI_LIMIT);
}

export function sampleReactionCandidates(
  pool: readonly ReactionEmoji[],
  random: () => number = Math.random,
  recent: readonly string[] = [],
): ReactionEmoji[] {
  const excluded = new Set(recent.slice(-RECENT_EMOJI_LIMIT));
  const available = pool.filter((candidate) => !excluded.has(candidate.emoji));
  const choices = [...(available.length > 0 ? available : pool)];
  const count = Math.min(SAMPLE_COUNT, choices.length);
  for (let index = 0; index < count; index += 1) {
    const swapIndex = index + Math.floor(random() * (choices.length - index));
    [choices[index], choices[swapIndex]] = [
      choices[swapIndex]!,
      choices[index]!,
    ];
  }
  return choices.slice(0, count);
}
