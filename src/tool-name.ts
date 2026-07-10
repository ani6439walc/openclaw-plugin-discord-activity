export type ToolDedupeIdentity = {
  toolCallId: string;
  toolName: string;
  params: unknown;
};

function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

export function getOpenClawToolSuffix(toolName: string): string | undefined {
  const trimmed = toolName.trim();
  const normalized = normalizeToolName(trimmed);
  if (!normalized.startsWith("openclaw")) {
    return undefined;
  }

  let suffix = trimmed.slice("openclaw".length);
  if (!suffix) {
    return undefined;
  }

  if ([".", ":", "/", "_", "-"].includes(suffix[0] ?? "")) {
    suffix = suffix.slice(1);
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(suffix)) {
    return undefined;
  }

  return suffix;
}

export function isCodexOpenClawToolName(toolName: string): boolean {
  return getOpenClawToolSuffix(toolName) !== undefined;
}

export function getDisplayToolName(toolName: string): string {
  return getOpenClawToolSuffix(toolName) ?? toolName;
}

export function canonicalToolNameForDedupe(toolName: string): string {
  return normalizeToolName(getDisplayToolName(toolName));
}

export function preferDisplayToolName(
  existing: string,
  incoming: string,
): string {
  if (isCodexOpenClawToolName(existing) && !isCodexOpenClawToolName(incoming)) {
    return incoming;
  }
  return existing;
}

export function preferToolCallId(
  existing: ToolDedupeIdentity,
  incoming: ToolDedupeIdentity,
): string {
  if (existing.toolCallId === incoming.toolCallId) {
    return existing.toolCallId;
  }
  if (
    isCodexOpenClawToolName(existing.toolName) &&
    !isCodexOpenClawToolName(incoming.toolName)
  ) {
    return incoming.toolCallId;
  }
  return existing.toolCallId;
}
