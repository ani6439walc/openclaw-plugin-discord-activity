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
