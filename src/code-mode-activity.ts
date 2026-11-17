import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  CodeModeDisplay,
  SessionEntry,
  ToolContext,
  ToolEntry,
} from "./types.js";

const MAX_TRACKED_CALLS = 128;
const MAX_CONTINUATIONS = 64;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

type Call = {
  entry: ToolEntry;
  agentRunId?: string;
  startedAt: number;
  settled: boolean;
  continuationId?: string;
};
type Continuation = {
  entry: ToolEntry;
  agentRunId: string;
  expiresAt: number;
  inFlight?: string;
};
type Scope = {
  generation: number;
  calls: Map<string, Call>;
  continuations: Map<string, Continuation>;
};

export function codeModeDisplay(
  event: BeforeToolCallEvent,
  ctx: ToolContext,
): CodeModeDisplay | undefined {
  if (event.toolKind !== "code_mode_exec" && ctx.toolKind !== "code_mode_exec")
    return;
  const codeAlias =
    typeof event.params.code === "string" && event.params.code.trim()
      ? event.params.code
      : undefined;
  const commandAlias =
    typeof event.params.command === "string" && event.params.command.trim()
      ? event.params.command
      : undefined;
  const conflict =
    codeAlias !== undefined &&
    commandAlias !== undefined &&
    codeAlias !== commandAlias;
  return {
    kind: "exec",
    state: "running",
    code: conflict ? undefined : (commandAlias ?? codeAlias),
    title:
      typeof event.params.title === "string" ? event.params.title : undefined,
    ...(conflict
      ? { error: "code and command differ; source preview unavailable." }
      : {}),
  };
}

/** Display correlation only; never executes or resumes a tool. Scopes are weakly owned by activity generations. */
export class CodeModeActivities {
  private scopes = new WeakMap<SessionEntry, Scope>();
  constructor(private readonly ttlMs = 900_000) {}

  private scope(session: SessionEntry, now: number): Scope {
    let scope = this.scopes.get(session);
    if (!scope || scope.generation !== session.generation) {
      scope = {
        generation: session.generation,
        calls: new Map(),
        continuations: new Map(),
      };
      this.scopes.set(session, scope);
    }
    for (const [id, continuation] of scope.continuations) {
      if (continuation.expiresAt <= now && !continuation.inFlight)
        scope.continuations.delete(id);
    }
    return scope;
  }

  before(
    session: SessionEntry,
    event: BeforeToolCallEvent,
    ctx: ToolContext,
    now = Date.now(),
  ): { entry: ToolEntry } | undefined {
    if (!event.toolCallId || ctx.sessionKey !== session.ownerSessionKey) return;
    const agentRunId = event.runId ?? ctx.runId;
    if (
      agentRunId &&
      session.runId &&
      session.runId !== agentRunId &&
      !session.activeRunIds?.has(agentRunId)
    )
      return;
    const scope = this.scope(session, now);
    const previous = scope.calls.get(event.toolCallId);
    if (previous)
      return previous.agentRunId === agentRunId
        ? { entry: previous.entry }
        : undefined;
    const display = codeModeDisplay(event, ctx);
    let entry: ToolEntry;
    let continuationId: string | undefined;
    if (display) {
      entry = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        params: event.params,
        status: "pending",
        startedAtMs: now,
        codeMode: display,
      };
    } else {
      // Host identity suffices for an individual exec, but a wait needs proven run ownership.
      if (!agentRunId) return;
      const rawRunId = event.params.runId ?? event.params.run_id;
      if (event.toolName !== "wait" || typeof rawRunId !== "string") return;
      continuationId = rawRunId.trim();
      const continuation = scope.continuations.get(continuationId);
      if (
        !continuation ||
        continuation.agentRunId !== agentRunId ||
        continuation.inFlight
      )
        return;
      continuation.inFlight = event.toolCallId;
      entry = continuation.entry;
      if (entry.codeMode) entry.codeMode.state = "running";
    }
    scope.calls.set(event.toolCallId, {
      entry,
      agentRunId,
      startedAt: now,
      settled: false,
      continuationId,
    });
    // Evict settled bookkeeping first. Capacity pressure falls back to ordinary rendering.
    for (const [id, call] of scope.calls) {
      if (scope.calls.size <= MAX_TRACKED_CALLS) break;
      if (call.settled) scope.calls.delete(id);
    }
    if (scope.calls.size > MAX_TRACKED_CALLS) {
      scope.calls.delete(event.toolCallId);
      if (continuationId)
        scope.continuations.get(continuationId)!.inFlight = undefined;
      return;
    }
    return { entry };
  }

  /** Recover a host-identified before event that arrived before Discord routing was known. */
  adopt(
    session: SessionEntry,
    entry: ToolEntry,
    agentRunId: string | undefined,
    now: number,
  ): void {
    if (!entry.codeMode) return;
    const scope = this.scope(session, now);
    if (scope.calls.size >= MAX_TRACKED_CALLS)
      scope.calls.delete(scope.calls.keys().next().value!);
    scope.calls.set(entry.toolCallId, {
      entry,
      agentRunId,
      startedAt: entry.startedAtMs ?? now,
      settled: false,
    });
  }

  after(
    session: SessionEntry,
    event: AfterToolCallEvent,
    ctx: ToolContext,
    now = Date.now(),
  ): boolean {
    if (!event.toolCallId || ctx.sessionKey !== session.ownerSessionKey)
      return false;
    const scope = this.scope(session, now);
    const call = scope.calls.get(event.toolCallId);
    if (!call || call.agentRunId !== (event.runId ?? ctx.runId)) return false;
    if (call.settled) return true;
    call.settled = true;
    const entry = call.entry;
    const display = entry.codeMode!;
    if (!call.continuationId) {
      const accepted = codeModeDisplay(
        { ...event, toolKind: "code_mode_exec" },
        ctx,
      );
      if (accepted) {
        display.code = accepted.code;
        display.title = accepted.title;
        entry.params = event.params;
      }
    }
    // The installed host's formatToolSearchControlResult uses textResult(text, payload):
    // the authoritative CodeModeResult is in details, not output/value or rendered text.
    const outcome = record(record(event.result)?.details);
    const state = event.error ? "failed" : outcome?.status;
    display.state =
      state === "completed" || state === "waiting" || state === "failed"
        ? state
        : "unknown";
    display.error =
      event.error ||
      (state === "failed" && typeof outcome?.error === "string"
        ? outcome.error
        : undefined);
    if (display.state === "failed" && !display.error)
      display.error = "Code execution failed.";
    entry.error = display.error;
    entry.status =
      display.state === "failed"
        ? "error"
        : display.state === "completed"
          ? "completed"
          : "pending";
    const duration =
      typeof event.durationMs === "number" &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0
        ? event.durationMs
        : Math.max(0, now - call.startedAt);
    entry.durationMs = (entry.durationMs ?? 0) + duration;
    if (call.continuationId) scope.continuations.delete(call.continuationId);
    if (
      display.state === "waiting" &&
      call.agentRunId &&
      typeof outcome?.runId === "string" &&
      outcome.runId
    ) {
      if (scope.continuations.size >= MAX_CONTINUATIONS)
        scope.continuations.delete(scope.continuations.keys().next().value!);
      scope.continuations.set(outcome.runId, {
        entry,
        agentRunId: call.agentRunId,
        expiresAt: now + this.ttlMs,
      });
    }
    return true;
  }

  clear(session: SessionEntry): void {
    const scope = this.scopes.get(session);
    if (scope)
      for (const { entry } of scope.calls.values()) {
        if (
          entry.codeMode?.state === "running" ||
          entry.codeMode?.state === "waiting"
        )
          entry.codeMode.state = "unknown";
      }
    this.scopes.delete(session);
  }
}
