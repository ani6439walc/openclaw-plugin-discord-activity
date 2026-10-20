/**
 * Parses and rewrites OpenClaw's background skill-review notice:
 *
 *   💾 Learned: updated `name` (summary); created `other`. Say "undo" to revert this skill change.
 *
 * Only a whole notice matches; any other text, including a reply that quotes the prefix, is left alone.
 */

export const LEARNED_NOTICE_PREFIX = "💾 Learned: ";
export const LEARNED_NOTICE_SUFFIX =
  '. Say "undo" to revert this skill change.';

export type LearnedVerb = "created" | "updated" | "archived" | "restored";

export type LearnedChange = {
  verb: LearnedVerb;
  skillName: string;
  summary: string;
};

const VERB_TEXT: Record<LearnedVerb, string> = {
  created: "已新增",
  updated: "已更新",
  archived: "已封存",
  restored: "已還原",
};

const UNDO_HINT = "跟我說還原就可以改回去。";

const CLAUSE_START_PATTERN =
  /(?:^|; )(created|updated|archived|restored) `([a-z0-9][a-z0-9-]{0,254})`/g;

export function parseLearnedNotice(text: string): LearnedChange[] | undefined {
  if (
    !text.startsWith(LEARNED_NOTICE_PREFIX) ||
    !text.endsWith(LEARNED_NOTICE_SUFFIX)
  ) {
    return undefined;
  }
  const body = text.slice(
    LEARNED_NOTICE_PREFIX.length,
    text.length - LEARNED_NOTICE_SUFFIX.length,
  );
  const matches = [...body.matchAll(CLAUSE_START_PATTERN)];
  if (matches.length === 0 || matches[0]!.index !== 0) return undefined;

  const changes: LearnedChange[] = [];
  for (const [i, match] of matches.entries()) {
    const tailStart = match.index + match[0].length;
    const tailEnd = matches[i + 1]?.index ?? body.length;
    const tail = body.slice(tailStart, tailEnd);
    let summary = "";
    if (tail) {
      if (!tail.startsWith(" (") || !tail.endsWith(")")) return undefined;
      summary = tail.slice(2, -1).trim();
    }
    changes.push({
      verb: match[1] as LearnedVerb,
      skillName: match[2]!,
      summary,
    });
  }
  return changes;
}

/**
 * Builds the visible sentence. `summaries` replaces a skill's original summary; a missing or
 * empty entry keeps the original, and an empty original drops the parenthetical.
 */
export function formatLearnedNotice(
  changes: readonly LearnedChange[],
  summaries?: ReadonlyMap<string, string>,
): string {
  const clauses = changes.map((change) => {
    const summary = summaries?.get(change.skillName)?.trim() || change.summary;
    const detail = summary ? `（${summary}）` : "";
    return `${VERB_TEXT[change.verb]}技能 \`${change.skillName}\`${detail}`;
  });
  return `${clauses.join("；")}。${UNDO_HINT}`;
}
