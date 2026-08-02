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
  DEFAULT_CLEANUP_DELAY_MS,
  DEFAULT_AGENT_END_DELAY_MS,
  DEFAULT_MAX_DISPLAY_SECONDS,
} from "./constants.js";

const DEFAULT_CONFIG = {
  maxToolHistoryLength: DEFAULT_MAX_TOOL_HISTORY_LENGTH,
  maxStatusMessageLength: DEFAULT_MAX_STATUS_MESSAGE_LENGTH,
  orphanTtlSeconds: DEFAULT_ORPHAN_TTL_SECONDS,
  maxDisplaySeconds: DEFAULT_MAX_DISPLAY_SECONDS,
};

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
  })
  .catch(DEFAULT_CONFIG);

export type PluginConfig = z.infer<typeof DiscordActivityConfigSchema>;

export function resolveConfig(raw: unknown): PluginConfig {
  return DiscordActivityConfigSchema.parse(raw);
}
