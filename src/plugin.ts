import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawConfig,
} from "../api.js";
import { resolveDiscordToken } from "../token.js";
import { defaultStore, defaultOrphans } from "./session.js";
import { createHookHandlers } from "./hooks.js";
import { resolveConfig } from "./config.js";

function buildIsActiveMemoryEnabled(
  openClawConfig: OpenClawConfig,
): (agentId: string) => boolean {
  return (agentId: string): boolean => {
    const plugins = openClawConfig.plugins;
    if (!plugins) return false;
    if (plugins.deny?.includes("active-memory")) return false;
    if (plugins.allow && !plugins.allow.includes("active-memory")) return false;

    const entry = plugins.entries?.["active-memory"];
    if (!entry?.enabled) return false;

    const agents = entry.config?.agents;
    if (!Array.isArray(agents)) return false;

    return agents.includes(agentId);
  };
}

function buildIsIntentionHintEnabled(
  openClawConfig: OpenClawConfig,
): (agentId: string) => boolean {
  return (agentId: string): boolean => {
    const plugins = openClawConfig.plugins;
    if (!plugins) return false;
    if (plugins.deny?.includes("intention-hint")) return false;
    if (plugins.allow && !plugins.allow.includes("intention-hint")) {
      return false;
    }

    const entry = plugins.entries?.["intention-hint"];
    if (!entry?.enabled) return false;

    const agents = entry.config?.agents;
    if (!Array.isArray(agents)) return false;

    return agents.includes(agentId);
  };
}

export function createPlugin(api: OpenClawPluginApi) {
  const config = resolveConfig(
    api.config.plugins?.entries?.["discord-tool-status"] ?? {},
  );
  const getToken = (accountId?: string) =>
    resolveDiscordToken(api.config, { accountId }).token;

  const isActiveMemoryEnabled = buildIsActiveMemoryEnabled(api.config);
  const isIntentionHintEnabled = buildIsIntentionHintEnabled(api.config);

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
      api.on("message_received", handlers.onMessageReceived);
      api.on("before_tool_call", handlers.onBeforeToolCall);
      api.on("after_tool_call", handlers.onAfterToolCall);
      api.on("message_sending", handlers.onMessageSending);
      api.on("before_agent_reply", handlers.onBeforeAgentReply);
      api.on("agent_end", handlers.onAgentEnd);
    },
  });
}
