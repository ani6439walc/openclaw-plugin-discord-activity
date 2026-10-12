/**
 * Helper functions to reduce code duplication in the session management system.
 */

export function clearSessionTimer(session: {
  clearTimer?: ReturnType<typeof setTimeout>;
}) {
  if (session.clearTimer) {
    clearTimeout(session.clearTimer);
    session.clearTimer = undefined;
  }
}

export function clearMaxDisplayTimer(session: {
  maxDisplayTimer?: ReturnType<typeof setTimeout>;
}) {
  if (session.maxDisplayTimer) {
    clearTimeout(session.maxDisplayTimer);
    session.maxDisplayTimer = undefined;
  }
}

export function clearAllSessionTimers(session: {
  clearTimer?: ReturnType<typeof setTimeout>;
  maxDisplayTimer?: ReturnType<typeof setTimeout>;
}) {
  clearSessionTimer(session);
  clearMaxDisplayTimer(session);
}

export function isEmptyStatusContent(content: string | undefined): boolean {
  if (!content) return true;
  const stripped = content
    .replaceAll(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replaceAll("\u001b", "")
    .trim();
  if (!stripped) return true;
  return /^`{3,}\s*(?:ansi)?\s*`{3,}$/i.test(stripped);
}
