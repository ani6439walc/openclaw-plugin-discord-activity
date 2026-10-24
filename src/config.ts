import { z } from "zod";
import {
  DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  DEFAULT_ORPHAN_TTL_SECONDS,
  DEFAULT_MAX_DISPLAY_SECONDS,
} from "./constants.js";
export {
  DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  DEFAULT_ORPHAN_TTL_SECONDS,
  DEFAULT_MAX_DISPLAY_SECONDS,
} from "./constants.js";

const DEFAULT_CONFIG = {
  maxToolHistoryLength: DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  maxStatusMessageLength: DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  orphanTtlSeconds: DEFAULT_ORPHAN_TTL_SECONDS,
  maxDisplaySeconds: DEFAULT_MAX_DISPLAY_SECONDS,
  replyMode: "all" as const,
};

const OptionalText = z.string().trim().min(1).optional().catch(undefined);
const emojiSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
const emojiCodePoint =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;

const EmojiText = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      emojiCodePoint.test(value) &&
      [...emojiSegmenter.segment(value)].length === 1,
  );
const EmojiConfigEntry = z.union([
  EmojiText,
  z.object({
    emoji: EmojiText,
    meaning: z.string().trim().min(1).max(120).optional().catch(undefined),
  }),
]);

/** OpenClaw's canonical thinking levels; the host maps each to what the selected model supports. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const DiscordActivityConfigSchema = z
  .object({
    maxToolHistoryLength: z
      .number()
      .int()
      .min(1)
      .max(50)
      .catch(DEFAULT_MAX_TOOL_HISTORY_LENGTH),
    maxStatusMessageLength: z
      .number()
      .int()
      .min(100)
      .max(DEFAULT_MAX_STATUS_MESSAGE_LENGTH)
      .catch(DEFAULT_MAX_STATUS_MESSAGE_LENGTH),
    orphanTtlSeconds: z
      .number()
      .int()
      .positive()
      .catch(DEFAULT_ORPHAN_TTL_SECONDS),
    maxDisplaySeconds: z
      .number()
      .int()
      .positive()
      .catch(DEFAULT_MAX_DISPLAY_SECONDS),
    replyMode: z.enum(["all", "direct"]).catch(DEFAULT_CONFIG.replyMode),
    skillLearnedNotice: z
      .object({
        model: OptionalText,
        promptAppend: OptionalText,
        thinking: z.enum(THINKING_LEVELS).optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    messageReaction: z
      .object({
        enabled: z.boolean().catch(false),
        emojis: z
          .array(z.unknown())
          .max(2000)
          .transform((items) =>
            items.flatMap((item) => {
              const parsed = EmojiConfigEntry.safeParse(item);
              return parsed.success ? [parsed.data] : [];
            }),
          )
          .optional()
          .catch([]),
      })
      .optional()
      .catch(undefined),
  })
  .catch(DEFAULT_CONFIG);

export type PluginConfig = z.infer<typeof DiscordActivityConfigSchema>;

export function resolveConfig(raw: unknown): PluginConfig {
  return DiscordActivityConfigSchema.parse(raw);
}
