import { describe, expect, it } from "vitest";
import { CodeModeActivities } from "./code-mode-activity.js";
import type { SessionEntry } from "./types.js";
const makeSession = (): SessionEntry => ({
  contextKey: "discord:channel:123",
  channelId: "123",
  ownerSessionKey: "agent:main:discord:channel:123",
  generation: 1,
  runId: "agent-run",
  toolHistory: [],
});
const ctx = {
  toolName: "exec",
  sessionKey: "agent:main:discord:channel:123",
  runId: "agent-run",
};
const exec = {
  toolName: "exec",
  toolCallId: "cell",
  toolKind: "code_mode_exec" as const,
  params: { title: "Inspect", code: "return 1", command: "return 1" },
};
const result = (details: unknown) => ({
  content: [{ type: "text", text: "ignored" }],
  details,
});
function setup(ttl?: number) {
  const tracker = new CodeModeActivities(ttl);
  const s = makeSession();
  const entry = tracker.before(s, exec, ctx, 0)!.entry;
  s.toolHistory.push(entry);
  return { tracker, s, entry };
}
const wait = {
  toolName: "wait",
  toolCallId: "w1",
  params: { runId: "continuation" },
};
describe("Code Mode activity lifecycle", () => {
  it("requires host identity even with code-shaped shell params", () => {
    expect(
      new CodeModeActivities().before(
        makeSession(),
        { ...exec, toolKind: undefined },
        ctx,
        0,
      ),
    ).toBeUndefined();
  });
  it("uses the host envelope, not errors inside a successful returned value", () => {
    const { tracker, s, entry } = setup();
    tracker.after(
      s,
      {
        ...exec,
        result: result({
          status: "completed",
          value: { status: "failed", error: "user data" },
        }),
      },
      ctx,
      10,
    );
    expect(entry.codeMode?.state).toBe("completed");
    expect(entry.error).toBeUndefined();
  });
  it("recognizes structured failure and prioritizes explicit hook errors", () => {
    const { tracker, s, entry } = setup();
    tracker.after(
      s,
      {
        ...exec,
        result: result({ status: "failed", error: "TypeError: broken" }),
      },
      ctx,
      10,
    );
    expect(entry.error).toBe("TypeError: broken");
    expect(entry.status).toBe("error");
    const other = setup();
    other.tracker.after(
      other.s,
      { ...exec, error: "cancelled", result: result({ status: "completed" }) },
      ctx,
      10,
    );
    expect(other.entry.error).toBe("cancelled");
  });
  it("does not infer success from unknown or text-only results", () => {
    const { tracker, s, entry } = setup();
    tracker.after(
      s,
      {
        ...exec,
        result: { content: [{ type: "text", text: '{"status":"completed"}' }] },
      },
      ctx,
      10,
    );
    expect(entry.codeMode?.state).toBe("unknown");
    expect(entry.status).not.toBe("completed");
  });
  it("resumes one row through repeated waits and counts durations once", () => {
    const { tracker, s, entry } = setup();
    tracker.after(
      s,
      {
        ...exec,
        result: result({ status: "waiting", runId: "continuation" }),
        durationMs: 10,
      },
      ctx,
      10,
    );
    expect(entry.codeMode?.state).toBe("waiting");
    expect(tracker.before(s, wait, ctx, 20)?.entry).toBe(entry);
    tracker.after(
      s,
      {
        ...wait,
        result: result({ status: "waiting", runId: "continuation" }),
        durationMs: 4,
      },
      ctx,
      24,
    );
    const w2 = { ...wait, toolCallId: "w2" };
    tracker.before(s, w2, ctx, 30);
    tracker.after(
      s,
      {
        ...w2,
        result: result({ status: "completed", value: 1 }),
        durationMs: 3,
      },
      ctx,
      33,
    );
    tracker.after(
      s,
      {
        ...w2,
        result: result({ status: "waiting", runId: "continuation" }),
        durationMs: 3,
      },
      ctx,
      34,
    );
    expect(entry.codeMode?.state).toBe("completed");
    expect(entry.durationMs).toBe(17);
    expect(
      tracker.before(s, { ...wait, toolCallId: "w3" }, ctx, 40),
    ).toBeUndefined();
  });
  it("does not attach concurrent or foreign-run waits", () => {
    const { tracker, s, entry } = setup();
    tracker.after(
      s,
      { ...exec, result: result({ status: "waiting", runId: "continuation" }) },
      ctx,
      10,
    );
    expect(
      tracker.before(s, wait, { ...ctx, runId: "foreign" }, 11),
    ).toBeUndefined();
    expect(tracker.before(s, wait, ctx, 12)).toBeDefined();
    const concurrent = { ...wait, toolCallId: "w2" };
    expect(tracker.before(s, concurrent, ctx, 13)).toBeUndefined();
    expect(
      tracker.after(
        s,
        {
          ...concurrent,
          result: result({ status: "failed", error: "already resuming" }),
        },
        ctx,
        14,
      ),
    ).toBe(false);
    expect(entry.codeMode?.state).toBe("running");
  });
  it("expires correlation, invalidates generations, and never fabricates success at cleanup", () => {
    const { tracker, s, entry } = setup(10);
    tracker.after(
      s,
      { ...exec, result: result({ status: "waiting", runId: "continuation" }) },
      ctx,
      1,
    );
    expect(tracker.before(s, wait, ctx, 12)).toBeUndefined();
    s.generation++;
    expect(tracker.before(s, wait, ctx, 13)).toBeUndefined();
    tracker.clear(s);
    expect(entry.codeMode?.state).not.toBe("completed");
  });
  it("does not reset terminal cells on duplicate before events", () => {
    const { tracker, s, entry } = setup();
    tracker.after(
      s,
      { ...exec, result: result({ status: "completed", value: 1 }) },
      ctx,
      10,
    );
    tracker.before(s, exec, ctx, 11);
    expect(entry.codeMode?.state).toBe("completed");
  });
  it("matches the host wait run_id alias and trims continuation IDs", () => {
    const { tracker, s, entry } = setup();
    tracker.after(
      s,
      { ...exec, result: result({ status: "waiting", runId: "continuation" }) },
      ctx,
      1,
    );
    expect(
      tracker.before(
        s,
        { ...wait, params: { run_id: " continuation " } },
        ctx,
        2,
      )?.entry,
    ).toBe(entry);
  });
  it("flags conflicting aliases instead of displaying either as executed source", () => {
    const tracker = new CodeModeActivities();
    const s = makeSession();
    const entry = tracker.before(
      s,
      { ...exec, params: { code: "first()", command: "second()" } },
      ctx,
      0,
    )!.entry;
    expect(entry.codeMode?.code).toBeUndefined();
    expect(entry.codeMode?.error).toContain("code and command");
  });

  it("accepts a steering run already admitted to the activity while keeping continuations separate", () => {
    const tracker = new CodeModeActivities();
    const s = makeSession();
    s.activeRunIds = new Set(["agent-run", "steer-run"]);
    const steer = { ...ctx, runId: "steer-run" };
    const entry = tracker.before(s, exec, steer, 0)!.entry;
    s.toolHistory.push(entry);
    tracker.after(
      s,
      { ...exec, result: result({ status: "waiting", runId: "continuation" }) },
      steer,
      1,
    );
    expect(tracker.before(s, wait, ctx, 2)).toBeUndefined();
    expect(tracker.before(s, wait, steer, 3)?.entry).toBe(entry);
  });

  it("shows the accepted adjusted source from the after hook", () => {
    const { tracker, s, entry } = setup();
    tracker.after(
      s,
      {
        ...exec,
        params: { title: "Adjusted", code: "return 2", command: "return 2" },
        result: result({ status: "completed", value: 2 }),
      },
      ctx,
      1,
    );
    expect(entry.codeMode?.code).toBe("return 2");
    expect(entry.codeMode?.title).toBe("Adjusted");
  });
});
