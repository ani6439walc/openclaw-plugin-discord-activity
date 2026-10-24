import { TypeSafeClient } from "@typesafe-ai/sdk";
import { resolveReadOnlyEnvSecretRef } from "openclaw/plugin-sdk/secret-ref-readonly";
import type { OpenClawPluginApi } from "../api.js";
import type { PluginConfig } from "./config.js";
import type { ReactionDecisionBatch } from "./message-reaction.js";

const DECISION_TIMEOUT_MS = 5000;

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  return baseUrl?.replace(/\/+$/, "").replace(/\/v1(?:\/systemone)?$/, "");
}

export function createFallbackDecisionEvaluator(
  config: NonNullable<PluginConfig["decisionModel"]>,
  hostConfig: OpenClawPluginApi["config"],
) {
  return async (
    batch: ReactionDecisionBatch,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const resolved = resolveReadOnlyEnvSecretRef({
      value: config.apiKey,
      path: "plugins.entries.discord-activity.config.decisionModel.apiKey",
      cfg: hostConfig,
      expectedEnvId: typeof config.apiKey === "string" ? "" : config.apiKey.id,
      normalizeValue: (value) =>
        typeof value === "string" ? value.trim() || undefined : undefined,
    });
    if (resolved.status !== "available" || signal.aborted) return undefined;

    const client = new TypeSafeClient({
      apiKey: resolved.value,
      baseURL: normalizeBaseUrl(config.baseUrl),
      defaultModel: config.model,
      timeout: DECISION_TIMEOUT_MS,
      retry: { maxRetries: 0 },
      compression: false,
      logLevel: "off",
    });
    const response = await client.systemOne(
      { ...batch, model: config.model },
      { signal, timeout: DECISION_TIMEOUT_MS },
    );
    const answer: unknown = response.answers.reaction;
    if (
      typeof answer === "object" &&
      answer !== null &&
      "type" in answer &&
      answer.type === "choice" &&
      "choice" in answer &&
      typeof answer.choice === "string"
    ) {
      return answer.choice;
    }
    return undefined;
  };
}
