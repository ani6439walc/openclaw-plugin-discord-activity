import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawConfig,
} from "../api.js";
import { resolveDiscordToken } from "../token.js";
import { defaultStore, defaultOrphans } from "./session.js";
import { createHookHandlers } from "./hooks.js";
import { resolveConfig } from "./config.js";

export function buildIsPluginEnabledForAgent(
  openClawConfig: OpenClawConfig,
  pluginId: string,
): (agentId: string) => boolean {
  return (agentId: string): boolean => {
    const plugins = openClawConfig.plugins;
    if (!plugins) return false;
    if (plugins.deny?.includes(pluginId)) return false;
    if (plugins.allow && !plugins.allow.includes(pluginId)) return false;

    const entry = plugins.entries?.[pluginId];
    if (!entry?.enabled) return false;

    const agents = entry.config?.agents;
    if (!Array.isArray(agents)) return false;

    return agents.includes(agentId);
  };
}

export function createPlugin(
  api: OpenClawPluginApi,
): ReturnType<typeof definePluginEntry> {
  const config = resolveConfig(api.pluginConfig ?? {});
  const getToken = (accountId?: string) =>
    resolveDiscordToken(api.config, { accountId }).token;

  const isActiveMemoryEnabled = buildIsPluginEnabledForAgent(
    api.config,
    "active-memory",
  );
  const isIntentionHintEnabled = buildIsPluginEnabledForAgent(
    api.config,
    "intention-hint",
  );

  const store = defaultStore;
  const orphans = defaultOrphans;
  const handlers = createHookHandlers({
    store,
    orphans,
    getToken,
    config,
    isActiveMemoryEnabled,
    isIntentionHintEnabled,
  });

  return definePluginEntry({
    id: "discord-tool-status",
    name: "Discord Tool Status",
    description:
      "Shows live tool-call status as a Discord message that is updated and deleted when the agent finishes.",
    register() {
      const registerAgentEventSubscription =
        api.agent?.events?.registerAgentEventSubscription;
      if (!registerAgentEventSubscription) {
        throw new Error(
          "discord-tool-status requires agent event subscriptions",
        );
      }

      api.on("message_received", handlers.onMessageReceived);
      api.on("before_tool_call", handlers.onBeforeToolCall);
      api.on("after_tool_call", handlers.onAfterToolCall);
      api.on("message_sending", handlers.onMessageSending);
      api.on("before_agent_reply", handlers.onBeforeAgentReply);
      api.on("agent_end", handlers.onAgentEnd);
      registerAgentEventSubscription({
        id: "discord-tool-status:intention-hint-pipeline",
        streams: ["plugin:intention-hint"],
        handle: handlers.onIntentionHintPipelineEvent,
      });
    },
  });
}
