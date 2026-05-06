import {
  createSubsystemLogger,
  definePluginEntry,
  type OpenClawPluginApi,
} from "../api.js";
import { resolveDiscordToken } from "../token.js";
import { defaultStore, defaultOrphans } from "./session.js";
import { createHookHandlers } from "./hooks.js";
import { resolveConfig } from "./config.js";

const logger = createSubsystemLogger("plugins");

export function createPlugin(api: OpenClawPluginApi) {
  const config = resolveConfig(
    api.config.plugins?.entries?.["discord-tool-status"] ?? {},
  );
  const getToken = (accountId?: string) =>
    resolveDiscordToken(api.config, { accountId }).token;

  const store = defaultStore;
  const orphans = defaultOrphans;
  const handlers = createHookHandlers({ store, orphans, getToken, config });

  return definePluginEntry({
    id: "discord-tool-status",
    name: "Discord Tool Status",
    description:
      "Shows live tool-call status as a Discord message that is updated and deleted when the agent finishes.",
    register() {
      api.on("message_received", handlers.onMessageReceived);
      api.on("before_tool_call", handlers.onBeforeToolCall);
      api.on("after_tool_call", handlers.onAfterToolCall);
      api.on("message_sending", handlers.onMessageSending);
      api.on("before_agent_reply", handlers.onBeforeAgentReply);
      api.on("agent_end", handlers.onAgentEnd);

      logger.debug("discord-tool-status: Plugin registered.", {
        subsystem: "plugins",
      });
    },
  });
}
