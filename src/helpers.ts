/**
 * Helper functions to reduce code duplication in the session management system.
 */

export function clearSessionTimer(session: { clearTimer?: ReturnType<typeof setTimeout> }) {
  if (session.clearTimer) {
    clearTimeout(session.clearTimer);
    session.clearTimer = undefined;
  }
}