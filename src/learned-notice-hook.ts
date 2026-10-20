import { logger } from "../api.js";
import {
  formatLearnedNotice,
  parseLearnedNotice,
  type LearnedChange,
} from "./learned-notice.js";
import { loadSkillDiff } from "./learned-notice-diff.js";
import type { MessageContext, MessageSendingEvent } from "./types.js";

/** Hook budget; operators can still override it with `plugins.entries.<id>.hooks.timeouts`. */
export const LEARNED_NOTICE_HOOK_TIMEOUT_MS = 60_000;
const LLM_TIMEOUT_MS = 45_000;
const MAX_PROMPT_DIFF_CHARS = 24_000;
const MAX_SUMMARY_CHARS = 120;

const BASE_SYSTEM_PROMPT = [
  "You describe changes to an AI assistant's learned skills for the person chatting with it.",
  "For each skill, write one short phrase, at most 60 characters, saying what the assistant will now do differently.",
  "Describe the practical effect, not file names or diff mechanics. No markdown, no trailing punctuation.",
  'Reply with only a JSON object mapping each skill name to its phrase, e.g. {"deploy-staging": "checks the image tag before deploying"}.',
].join("\n");

/** Base instructions plus operator-supplied text such as the reply language. */
export function buildSystemPrompt(extra?: string): string {
  const appended = extra?.trim();
  return appended ? `${BASE_SYSTEM_PROMPT}\n\n${appended}` : BASE_SYSTEM_PROMPT;
}

export type LearnedNoticeCompletion = (params: {
  model?: string;
  messages: [{ role: "user"; content: string }];
  systemPrompt: string;
  purpose: string;
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
}) => Promise<{ text: string }>;

export type LearnedNoticeDeps = {
  /** Agent state directory for an agent id, e.g. `resolveAgentDir(config, agentId)`. */
  resolveAgentDir: (agentId: string) => string;
  /** Agent id encoded in a session key, or undefined when it has none. */
  resolveAgentId: (sessionKey: string) => string | undefined;
  complete: LearnedNoticeCompletion;
  /** Model ref for the summary; undefined uses the host's default agent model. */
  model?: string;
  /** Appended to the system prompt, e.g. the language the summary should use. */
  promptAppend?: string;
  now?: () => number;
};

function isDiscordMessage(ctx: MessageContext): boolean {
  return ctx.channelId === "discord" || ctx.messageProvider === "discord";
}

export function parseSummaryReply(
  text: string,
  skillNames: readonly string[],
): Map<string, string> {
  const summaries = new Map<string, string>();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return summaries;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return summaries;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return summaries;
  }
  const record = parsed as Record<string, unknown>;
  for (const name of skillNames) {
    const value = record[name];
    if (typeof value !== "string") continue;
    const summary = value
      .replace(/\s+/g, " ")
      .replaceAll("`", "")
      .trim()
      .replace(/[。.！!]+$/, "")
      .slice(0, MAX_SUMMARY_CHARS);
    if (summary) summaries.set(name, summary);
  }
  return summaries;
}

function buildPrompt(
  diffs: ReadonlyArray<{ change: LearnedChange; diff: string }>,
): string {
  const budget = Math.floor(MAX_PROMPT_DIFF_CHARS / diffs.length);
  return diffs
    .map(({ change, diff }) => {
      const body =
        diff.length > budget ? `${diff.slice(0, budget)}\n… (truncated)` : diff;
      return [
        `## ${change.skillName} (${change.verb})`,
        `Reviewer note: ${change.summary || "(none)"}`,
        "```diff",
        body,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * Rewrites the background skill-review notice on Discord. Created and updated skills get an
 * LLM summary of their diff; anything that fails keeps the deterministic rewrite, and the
 * message is never cancelled. Undo still works because core queues its own system event.
 */
export function createLearnedNoticeHandler(deps: LearnedNoticeDeps) {
  const now = deps.now ?? Date.now;
  const systemPrompt = buildSystemPrompt(deps.promptAppend);

  return async function onLearnedNoticeSending(
    event: MessageSendingEvent,
    ctx: MessageContext,
  ): Promise<{ content: string } | undefined> {
    if (!isDiscordMessage(ctx)) return undefined;
    const changes = parseLearnedNotice(event.content);
    if (!changes) return undefined;

    const fallback = formatLearnedNotice(changes);
    const describable = changes.filter(
      (change) => change.verb === "created" || change.verb === "updated",
    );
    const agentId = ctx.sessionKey
      ? deps.resolveAgentId(ctx.sessionKey)
      : undefined;
    if (describable.length === 0 || !agentId) return { content: fallback };

    try {
      const agentDir = deps.resolveAgentDir(agentId);
      const nowMs = now();
      const diffs: Array<{ change: LearnedChange; diff: string }> = [];
      for (const change of describable) {
        const diff = await loadSkillDiff({
          agentDir,
          skillName: change.skillName,
          created: change.verb === "created",
          nowMs,
        });
        if (diff) diffs.push({ change, diff });
      }
      if (diffs.length === 0) {
        logger.debug("learned notice: no skill diff found", {
          agentId,
          skills: describable.length,
        });
        return { content: fallback };
      }

      const result = await deps.complete({
        ...(deps.model ? { model: deps.model } : {}),
        messages: [{ role: "user", content: buildPrompt(diffs) }],
        systemPrompt,
        purpose: "discord-activity.learned-notice",
        maxTokens: 600,
        temperature: 0.2,
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      const summaries = parseSummaryReply(
        result.text,
        diffs.map(({ change }) => change.skillName),
      );
      if (summaries.size === 0) {
        logger.warn("learned notice: summary reply was not usable", {
          agentId,
        });
        return { content: fallback };
      }
      return { content: formatLearnedNotice(changes, summaries) };
    } catch (error) {
      logger.warn("learned notice: summary failed, using plain rewrite", {
        agentId,
        code: (error as { code?: unknown } | null)?.code,
        error: error instanceof Error ? error.name : typeof error,
      });
      return { content: fallback };
    }
  };
}
