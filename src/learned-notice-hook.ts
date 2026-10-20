import { logger } from "../api.js";
import { parseLearnedNotice, type LearnedChange } from "./learned-notice.js";
import { loadSkillDiff } from "./learned-notice-diff.js";
import type { MessageContext, MessageSendingEvent } from "./types.js";

/** Hook budget; operators can still override it with `plugins.entries.<id>.hooks.timeouts`. */
export const LEARNED_NOTICE_HOOK_TIMEOUT_MS = 60_000;
const LLM_TIMEOUT_MS = 45_000;
const MAX_PROMPT_DIFF_CHARS = 24_000;
/** Well under Discord's 2000-character message limit. */
const MAX_NOTICE_CHARS = 1_500;

const BASE_SYSTEM_PROMPT = `You rewrite a notice that tells the person chatting with an AI assistant that a background review changed the assistant's learned skills.

The message you write must include:
- every changed skill name, exactly as given, wrapped in backticks;
- what happened to each skill (created, updated, archived, or restored);
- for created or updated skills, a short description of what the assistant will now do differently, based on the diff; describe the practical effect, not file names or diff mechanics;
- a closing hint that the person can ask to undo or revert the change.

Keep it to one or two short sentences, in the same order as the original notice, and write the message exactly once. Reply with only the message text: no quotes, no code fences, no preamble.

Example input:
Original notice: 💾 Learned: updated \`deploy-staging\` (tightened the rollback step). Say "undo" to revert this skill change.
## deploy-staging (updated)
\`\`\`diff
*** SKILL.md
 1. Build the image.
+2. Check that the image tag matches the release before deploying.
-2. Deploy.
+3. Deploy.
\`\`\`

Example output:
Updated \`deploy-staging\`: it now checks that the image tag matches the release before deploying. Say "undo" if you want the old version back.`;

/** Base instructions plus operator-supplied text such as the language and tone. */
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
  /** Model ref for the rewrite; undefined uses the host's default agent model. */
  model?: string;
  /** Appended to the system prompt, e.g. the language and tone of the message. */
  promptAppend?: string;
  now?: () => number;
};

function isDiscordMessage(ctx: MessageContext): boolean {
  return ctx.channelId === "discord" || ctx.messageProvider === "discord";
}

/**
 * Models occasionally emit the whole message twice. When the reply, ignoring whitespace, is one
 * block repeated, keep only the first copy; any other text is returned unchanged.
 */
export function collapseRepetition(message: string): string {
  const chars = Array.from(message);
  const compact = chars.filter((char) => !/\s/.test(char));
  const length = compact.length;
  for (let period = 1; period <= length / 2; period++) {
    if (length % period !== 0) continue;
    let repeats = true;
    for (let i = period; i < length && repeats; i++) {
      repeats = compact[i] === compact[i - period];
    }
    if (!repeats) continue;
    // Cut the original text right after the first block's last non-space character.
    let seen = 0;
    for (const [index, char] of chars.entries()) {
      if (/\s/.test(char)) continue;
      seen++;
      if (seen === period) return chars.slice(0, index + 1).join("");
    }
  }
  return message;
}

/**
 * Accepts the model's message only when it names every changed skill and fits the limit;
 * otherwise returns undefined so the original notice is sent unchanged.
 */
export function normalizeNoticeReply(
  text: string,
  skillNames: readonly string[],
): string | undefined {
  const message = collapseRepetition(
    text
      .trim()
      .replace(/^```[a-z]*\n?|\n?```$/g, "")
      .trim()
      .replace(/^"([\s\S]*)"$/, "$1")
      .trim(),
  );
  if (!message || Array.from(message).length > MAX_NOTICE_CHARS) {
    return undefined;
  }
  return skillNames.every((name) => message.includes(name))
    ? message
    : undefined;
}

function buildPrompt(
  original: string,
  diffs: ReadonlyMap<string, string>,
): string {
  const budget = Math.floor(MAX_PROMPT_DIFF_CHARS / Math.max(diffs.size, 1));
  const sections = [...diffs].map(([name, diff]) => {
    const body =
      diff.length > budget ? `${diff.slice(0, budget)}\n… (truncated)` : diff;
    return [`## ${name}`, "```diff", body, "```"].join("\n");
  });
  return [`Original notice: ${original}`, ...sections].join("\n\n");
}

async function collectDiffs(
  changes: readonly LearnedChange[],
  agentDir: string,
  nowMs: number,
): Promise<Map<string, string>> {
  const diffs = new Map<string, string>();
  for (const change of changes) {
    if (change.verb !== "created" && change.verb !== "updated") continue;
    try {
      const diff = await loadSkillDiff({
        agentDir,
        skillName: change.skillName,
        created: change.verb === "created",
        nowMs,
      });
      if (diff) diffs.set(change.skillName, diff);
    } catch (error) {
      logger.debug("learned notice: skill diff unavailable", {
        skill: change.skillName,
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return diffs;
}

/**
 * Rewrites the background skill-review notice on Discord. The model writes the whole message
 * from the original notice and, where available, each skill's diff. Any failure sends the
 * original notice unchanged; the message is never cancelled, and undo still works because core
 * queues its own system event.
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

    const agentId = ctx.sessionKey
      ? deps.resolveAgentId(ctx.sessionKey)
      : undefined;
    let diffs = new Map<string, string>();
    if (agentId) {
      try {
        diffs = await collectDiffs(
          changes,
          deps.resolveAgentDir(agentId),
          now(),
        );
      } catch (error) {
        logger.debug("learned notice: skill diffs unavailable", {
          agentId,
          error: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    try {
      const result = await deps.complete({
        ...(deps.model ? { model: deps.model } : {}),
        messages: [
          { role: "user", content: buildPrompt(event.content, diffs) },
        ],
        systemPrompt,
        purpose: "discord-activity.learned-notice",
        maxTokens: 600,
        temperature: 0.2,
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      const content = normalizeNoticeReply(
        result.text,
        changes.map((change) => change.skillName),
      );
      if (!content) {
        logger.warn(
          "learned notice: rewrite was not usable, sending original",
          {
            agentId,
          },
        );
        return undefined;
      }
      return { content };
    } catch (error) {
      logger.warn("learned notice: rewrite failed, sending original", {
        agentId,
        code: (error as { code?: unknown } | null)?.code,
        error: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  };
}
