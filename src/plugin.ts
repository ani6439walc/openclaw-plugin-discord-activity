import { definePluginEntry, type OpenClawPluginApi } from "../api.js";
import { resolveDiscordToken } from "../token.js";
import { defaultStore, defaultOrphans } from "./session.js";
import { createHookHandlers } from "./hooks.js";
import { resolveConfig } from "./config.js";
import { SKILL_HARNESS_EVENT_STREAM } from "./skill-harness-status.js";
import { HINDSIGHT_EVENT_STREAM } from "./hindsight-status.js";

export function createPlugin(
  api: OpenClawPluginApi,
): ReturnType<typeof definePluginEntry> {
  const config = resolveConfig(api.pluginConfig ?? {});
  const getToken = (accountId?: string) =>
    resolveDiscordToken(api.config, { accountId }).token;

  const store = defaultStore;
  const orphans = defaultOrphans;
  const handlers = createHookHandlers({
    store,
    orphans,
    getToken,
    config,
  });

  return definePluginEntry({
    id: "discord-activity",
    name: "Discord Activity",
    description:
      "Shows live agent and tool activity as a Discord message that is updated and deleted when the agent finishes.",
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
      api.on("before_compaction", handlers.onBeforeCompaction);
      api.on("after_compaction", handlers.onAfterCompaction);
      registerAgentEventSubscription?.({
        id: "discord-activity:skill-harness-pipeline",
        streams: [SKILL_HARNESS_EVENT_STREAM],
        handle: handlers.onSkillHarnessPipelineEvent,
      });
      registerAgentEventSubscription?.({
        id: "discord-activity:hindsight-pipeline",
        streams: [HINDSIGHT_EVENT_STREAM],
        handle: handlers.onHindsightPipelineEvent,
      });
    },
  });
}
