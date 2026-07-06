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
  const isSkillHarnessEnabled = buildIsPluginEnabledForAgent(
    api.config,
    "skill-harness",
  );

  const store = defaultStore;
  const orphans = defaultOrphans;
  const handlers = createHookHandlers({
    store,
    orphans,
    getToken,
    config,
    isActiveMemoryEnabled,
    isSkillHarnessEnabled,
  });

  return definePluginEntry({
    id: "discord-tool-status",
    name: "Discord Tool Status",
    description:
      "Shows live tool-call status as a Discord message that is updated and deleted when the agent finishes.",
    register() {
      const runtimeApi = api as unknown as {
        agent?: {
          events?: {
            registerAgentEventSubscription?: OpenClawPluginApi["agent"]["events"]["registerAgentEventSubscription"];
          };
        };
      };
      const registerAgentEventSubscription =
        runtimeApi.agent?.events?.registerAgentEventSubscription;

      api.on("message_received", handlers.onMessageReceived);
      api.on("before_tool_call", handlers.onBeforeToolCall);
      api.on("after_tool_call", handlers.onAfterToolCall);
      api.on("message_sending", handlers.onMessageSending);
      api.on("before_agent_reply", handlers.onBeforeAgentReply);
      api.on("agent_end", handlers.onAgentEnd);
      registerAgentEventSubscription?.({
        id: "discord-tool-status:skill-harness-pipeline",
        streams: ["plugin:skill-harness"],
        handle: handlers.onSkillHarnessPipelineEvent,
      });
    },
  });
}
