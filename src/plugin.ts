import {
  definePluginEntry,
  setApiLogger,
  type OpenClawPluginApi,
} from "../api.js";
import { resolveDiscordToken } from "../token.js";
import { defaultStore, defaultOrphans } from "./session.js";
import { createHookHandlers } from "./hooks.js";
import { resolveConfig } from "./config.js";
import { SKILL_HARNESS_EVENT_STREAM } from "./skill-harness-status.js";
import { HINDSIGHT_MEMORY_EVENT_STREAM } from "./hindsight-memory-status.js";
import {
  createLearnedNoticeHandler,
  LEARNED_NOTICE_HOOK_TIMEOUT_MS,
} from "./learned-notice-hook.js";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";

export default definePluginEntry({
  id: "discord-activity",
  name: "Discord Activity",
  description:
    "Shows live agent and tool activity as a Discord message that is updated and deleted when the agent finishes.",
  register(api: OpenClawPluginApi) {
    if (api.logger) {
      setApiLogger(api.logger);
    }

    const config = resolveConfig(api.pluginConfig ?? {});
    const handlers = createHookHandlers({
      store: defaultStore,
      orphans: defaultOrphans,
      getToken: (accountId?: string) =>
        resolveDiscordToken(api.config, { accountId }).token,
      config,
    });

    api.on("message_received", handlers.onMessageReceived);
    api.on("before_tool_call", handlers.onBeforeToolCall);
    api.on("after_tool_call", handlers.onAfterToolCall);
    api.on("message_sending", handlers.onMessageSending);
    api.on(
      "message_sending",
      createLearnedNoticeHandler({
        resolveAgentDir: (agentId) => resolveAgentDir(api.config, agentId),
        resolveAgentId: (sessionKey) =>
          parseAgentSessionKey(sessionKey)?.agentId,
        complete: (params) => api.runtime.llm.complete(params),
        model: config.skillLearnedNotice?.model,
        promptAppend: config.skillLearnedNotice?.promptAppend,
      }),
      { timeoutMs: LEARNED_NOTICE_HOOK_TIMEOUT_MS },
    );
    api.on("before_agent_reply", handlers.onBeforeAgentReply, {
      eligibleTriggers: ["user"],
    });
    api.on("agent_end", handlers.onAgentEnd);
    api.on("before_compaction", handlers.onBeforeCompaction);
    api.on("after_compaction", handlers.onAfterCompaction);
    api.agent.events.registerAgentEventSubscription({
      id: "discord-activity:skill-harness-pipeline",
      streams: [SKILL_HARNESS_EVENT_STREAM],
      handle: handlers.onSkillHarnessPipelineEvent,
    });
    api.agent.events.registerAgentEventSubscription({
      id: "discord-activity:hindsight-memory-pipeline",
      streams: [HINDSIGHT_MEMORY_EVENT_STREAM],
      handle: handlers.onHindsightMemoryPipelineEvent,
    });
  },
});
