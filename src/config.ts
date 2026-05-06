import { z } from "openclaw/plugin-sdk/zod";

export const DEFAULT_MAX_TOOL_HISTORY_LENGTH = 10;
export const DEFAULT_MAX_STATUS_MESSAGE_LENGTH = 1700;
export const DEFAULT_ORPHAN_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CLEANUP_DELAY_MS = 1000;
export const DEFAULT_AGENT_END_DELAY_MS = 1500;

const DiscordToolStatusConfigSchema = z.object({
  maxToolHistoryLength: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(DEFAULT_MAX_TOOL_HISTORY_LENGTH),
  maxStatusMessageLength: z
    .number()
    .int()
    .min(100)
    .max(4000)
    .default(DEFAULT_MAX_STATUS_MESSAGE_LENGTH),
  orphanTtlMs: z.number().int().positive().default(DEFAULT_ORPHAN_TTL_MS),
});

export type PluginConfig = z.infer<typeof DiscordToolStatusConfigSchema>;

export function resolveConfig(raw: unknown): PluginConfig {
  return DiscordToolStatusConfigSchema.parse(raw ?? {});
}
