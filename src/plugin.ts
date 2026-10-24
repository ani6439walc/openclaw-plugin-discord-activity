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
import {
  resolveAgentConfig,
  resolveAgentDir,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveLearnedNoticeModel } from "./learned-notice-model.js";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { createMessageReactionHandler } from "./message-reaction.js";
import { addReactionWithResult, resolveDmChannel } from "./discord-api.js";

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

    if (config.messageReaction?.enabled) {
      const reactionHandler = createMessageReactionHandler({
        config: config.messageReaction,
        resolveDecisionModel: (agentId) =>
          resolveAgentConfig(api.config, agentId)?.decisionModel ??
          api.config.agents?.defaults?.decisionModel,
        getSessionEntry: (agentId, sessionKey) =>
          api.runtime.agent.session.getSessionEntryAsync({
            agentId,
            sessionKey,
            readConsistency: "latest",
          }),
        evaluate: (batch, options) =>
          api.runtime.decisions.evaluate(batch, options),
        getToken: (accountId) =>
          resolveDiscordToken(api.config, { accountId }).token,
        resolveDmChannel,
        addReaction: addReactionWithResult,
      });
      api.on("message_received", reactionHandler.onMessageReceived);
      api.on("gateway_stop", reactionHandler.stop);
    }
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
        resolveModel: (agentId) =>
          resolveLearnedNoticeModel({
            configured: config.skillLearnedNotice?.model,
            cfg: api.config,
            agentId,
            resolveAgentConfig,
          }),
        thinking: config.skillLearnedNotice?.thinking,
        promptAppend: config.skillLearnedNotice?.promptAppend,
      }),
      { timeoutMs: LEARNED_NOTICE_HOOK_TIMEOUT_MS },
    );
    api.on("before_agent_reply", handlers.onBeforeAgentReply, {
      eligibleTriggers: ["user"],
    });
    api.on("agent_end", handlers.onAgentEnd);
    api.agent.events.registerAgentEventSubscription({
      id: "discord-activity:lifecycle",
      streams: ["lifecycle"],
      handle: handlers.onAgentLifecycleEvent,
    });
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
