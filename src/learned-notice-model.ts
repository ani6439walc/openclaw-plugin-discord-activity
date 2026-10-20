import type { OpenClawConfig } from "../api.js";

type AgentConfigReader = (
  cfg: OpenClawConfig,
  agentId: string,
) => { utilityModel?: unknown } | undefined;

/**
 * Model for the learned-skill notice: the plugin's `skillLearnedNotice.model`, otherwise the
 * explicit utility model of the agent (`agents.entries.<id>.utilityModel`, then
 * `agents.defaults.utilityModel`). An empty utility model disables utility routing and an unset
 * one means core's automatic choice, which plugins cannot resolve; both return undefined so the
 * host uses the agent's default model.
 */
export function resolveLearnedNoticeModel(params: {
  configured?: string;
  cfg: OpenClawConfig;
  agentId?: string;
  resolveAgentConfig: AgentConfigReader;
}): string | undefined {
  if (params.configured) return params.configured;
  const agentValue = params.agentId
    ? params.resolveAgentConfig(params.cfg, params.agentId)?.utilityModel
    : undefined;
  const value =
    agentValue ??
    (params.cfg.agents?.defaults as { utilityModel?: unknown } | undefined)
      ?.utilityModel;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
