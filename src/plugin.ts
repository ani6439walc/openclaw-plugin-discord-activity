import {
  definePluginEntry,
  setApiLogger,
  type OpenClawConfig,
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
  resolveLearnedNoticeOwner,
} from "./learned-notice-hook.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  tryResolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveLearnedNoticeModel } from "./learned-notice-model.js";
import {
  normalizeAccountId,
  parseAgentSessionKey,
} from "openclaw/plugin-sdk/routing";
import { createMessageReactionHandler } from "./message-reaction.js";
import {
  addReactionWithResult,
  removeAckReactionWithResult,
  resolveDmChannel,
} from "./discord-api.js";
import { createFallbackDecisionEvaluator } from "./decision-model.js";
import { resolveAckReaction } from "openclaw/plugin-sdk/channel-feedback";

function readCurrentHostConfig(api: OpenClawPluginApi): OpenClawConfig {
  return api.runtime?.config?.current
    ? (api.runtime.config.current() as OpenClawConfig)
    : api.config;
}

function resolveAmbientNoticeOwnerId(
  cfg: OpenClawConfig,
  configuredAgentIds: readonly string[],
): string | undefined {
  const rawSystemAgent = (
    cfg.agents?.defaults as { systemAgent?: { agentId?: unknown } } | undefined
  )?.systemAgent?.agentId;
  if (typeof rawSystemAgent === "string") {
    const trimmed = rawSystemAgent.trim();
    if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) {
      const normalized = trimmed.toLowerCase();
      if (configuredAgentIds.includes(normalized)) {
        return normalized;
      }
    }
  }
  return tryResolveDefaultAgentId(cfg);
}

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
        resolveDiscordToken(readCurrentHostConfig(api), { accountId }).token,
      config,
    });

    if (config.messageReaction?.enabled) {
      const lifecycle = api.lifecycle;
      const runInBackgroundContext =
        lifecycle?.runInBackgroundContext?.bind(lifecycle);
      const reactionHandler = createMessageReactionHandler({
        config: config.messageReaction,
        runInBackgroundContext,
        prepareOperation: () => {
          const cfg = readCurrentHostConfig(api);
          return {
            resolveDecisionModel: (agentId) =>
              resolveAgentConfig(cfg, agentId)?.decisionModel,
            resolveGlobalDecisionModel: () =>
              cfg.agents?.defaults?.decisionModel,
            evaluateFallback: config.decisionModel
              ? createFallbackDecisionEvaluator(config.decisionModel, cfg)
              : undefined,
            getToken: (accountId) =>
              resolveDiscordToken(cfg, { accountId }).token,
            resolveAckReaction: (agentId, accountId) =>
              resolveAckReaction(cfg, agentId, {
                channel: "discord",
                accountId: normalizeAccountId(accountId),
              }),
          };
        },
        getSessionEntry: (agentId, sessionKey) =>
          api.runtime.agent.session.getSessionEntryAsync({
            agentId,
            sessionKey,
            readConsistency: "latest",
          }),
        evaluate: (batch, options) =>
          api.runtime.decisions.evaluate(batch, options),
        resolveDmChannel,
        addReaction: addReactionWithResult,
        removeAckReaction: removeAckReactionWithResult,
      });
      const onLifecycleAbort = () => {
        void reactionHandler.stop();
      };
      if (lifecycle?.signal) {
        if (lifecycle.signal.aborted) {
          void reactionHandler.stop();
        } else {
          lifecycle.signal.addEventListener("abort", onLifecycleAbort, {
            once: true,
          });
        }
      }
      lifecycle?.onDispose?.(() => {
        lifecycle.signal?.removeEventListener("abort", onLifecycleAbort);
        return reactionHandler.stop();
      });
      api.on("message_received", reactionHandler.onMessageReceived);
      api.on("gateway_stop", () => {
        lifecycle?.signal?.removeEventListener("abort", onLifecycleAbort);
        return reactionHandler.stop();
      });
    }
    api.on("message_received", handlers.onMessageReceived);
    api.on("before_tool_call", handlers.onBeforeToolCall);
    api.on("after_tool_call", handlers.onAfterToolCall);
    api.on("message_sending", handlers.onMessageSending);
    api.on(
      "message_sending",
      createLearnedNoticeHandler({
        prepareOperation: () => {
          const cfg = readCurrentHostConfig(api);
          const configuredAgentIds = listAgentIds(cfg);
          const ambientOwnerId = resolveAmbientNoticeOwnerId(
            cfg,
            configuredAgentIds,
          );
          return {
            resolveNoticeOwner: (sessionKey) =>
              resolveLearnedNoticeOwner({
                sessionKey,
                parseSessionAgentId: (key) =>
                  parseAgentSessionKey(key)?.agentId,
                configuredAgentIds,
                ambientOwnerId,
              }),
            resolveAgentDir: (agentId) => resolveAgentDir(cfg, agentId),
            resolveModel: (agentId) =>
              resolveLearnedNoticeModel({
                configured: config.skillLearnedNotice?.model,
                cfg,
                agentId,
                resolveAgentConfig,
              }),
          };
        },
        complete: (params) => api.runtime.llm.complete(params),
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
