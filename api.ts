export {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
export type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
export const logger = createSubsystemLogger("plugins/discord-tool-status");
