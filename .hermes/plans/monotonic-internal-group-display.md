# Specification and Implementation Plan: Monotonic Internal-Group Display

## Objective

Prevent `active-memory` and `skill-harness` status groups from visually moving backward within one Discord status session. Once a group is collapsed or removed by renderer-controlled bounding, later tool events must not expand or resurrect it.

The change must also preserve the newest available multiline content. Before a normal tool produces newer multiline content, the newest internal group should remain expanded as long as useful content can fit. Once newer normal-tool multiline content exists, older internal groups may degrade to preserve it.

## Confirmed Behavior Contract

### Monotonic state

Each internal group has one session-scoped display state:

```text
expanded → collapsed → removed
```

Allowed transitions:

- `expanded → expanded | collapsed | removed`
- `collapsed → collapsed | removed`
- `removed → removed`

Disallowed transitions:

- `collapsed → expanded`
- `removed → collapsed`
- `removed → expanded`

`active-memory` and `skill-harness` transition independently.

### State lifetime

- State belongs to one `SessionEntry` generation.
- A replacement session or new generation starts with both groups expanded.
- Session retirement, deletion, or reset clears the state with the rest of the session display data.
- Tool-history reconciliation or later terminal results must not revive a degraded group.
- A group that is temporarily absent from retained history keeps its prior state without advancing to `removed`; if it is later reintroduced in the same generation, the preserved floor applies.
- Default state creation must return a fresh value for every session and render. The renderer must accept deep-frozen input without mutation or aliasing.

### Producer provenance

No event may mutate history or display state unless it is attributable to the current `SessionEntry` generation and run.

- Use available producer `runId` values, including `skill-harness` pipeline events and agent lifecycle events, before mutating history.
- Audit the live OpenClaw hook context for `before_tool_call` and `after_tool_call`; the local `ToolContext` currently omits `runId`, so existing guards are insufficient.
- If a producer truly cannot supply `runId`, establish an explicit run-scoped ownership record for accepted tool-call IDs. A terminal event may update only a call already owned by the current generation; an unowned late terminal event must remain orphaned or be ignored rather than attached to a replacement session.
- A source-driven provenance spike is a prerequisite. Do not claim stale-run isolation from `isCurrentSession()` alone because routing may already have resolved a late event to the replacement entry.

### Commit semantics

The renderer computes a candidate next state without mutating the session. The session tracks two independent values:

- `confirmedDisplayState`: the state known to match a successfully visible Discord message;
- `monotonicSafetyFloor`: the most degraded state that Discord may already have applied after an uncertain network or server outcome.

Every render starts from the more degraded level of the two values for each group.

- Update `confirmedDisplayState` only after a successful create/edit, or when candidate content equals `lastRenderedContent` while the session is still current and the corresponding `statusMessageId` exists.
- On explicit rejection where Discord did not apply the mutation, such as missing token or non-retryable 4xx, update neither value.
- On uncertain outcomes where Discord may have applied the mutation, such as exhausted network errors, final 5xx, or a successful POST response without a usable message ID, raise only `monotonicSafetyFloor`.
- Preserve compatibility wrappers, but add detailed internal mutation outcomes (`applied`, `rejected`, `uncertain`) so `session.ts` does not infer semantics from `boolean` or `undefined`.
- Recheck current session identity/generation after awaited PATCH before committing either state. Per-entry `pendingOp` does not serialize a replacement entry for the same context.
- A late create that is cleaned up or any stale/replaced session path commits neither value.

An uncertain POST can still leave an unaddressable duplicate under the existing API because no message ID is available. This plan prevents display-state resurrection by raising the safety floor; idempotent status-message creation or orphan-message reconciliation is a separate delivery-hardening concern unless official Discord API evidence identifies a small compatible solution during implementation.

### Newest multiline preservation

Determine the newest actually renderable multiline-capable field from source history order after applying prior state, the outer six-entry budget, the normal-entry slice, and each subagent's three-child limit. Fields hidden by any of those rules cannot become the protected owner.

- If the newest multiline content is in a non-internal block, including a normal tool or main-agent failure, degrade internal groups in this order when required: collapse `active-memory`, collapse `skill-harness`, remove `active-memory`, remove `skill-harness`, then truncate eligible non-internal multiline fields oldest first within the lowest active retention-priority tier.
- If the newest multiline content is in `skill-harness`, degrade `active-memory` before truncating `skill-harness`; do not collapse `skill-harness` merely to reserve space for a normal multiline field that does not exist yet.
- If the newest multiline content is in `active-memory`, degrade the older `skill-harness` block before truncating `active-memory`; do not retain the current global order that would collapse the protected `active-memory` first.
- If no multiline-capable field is present, use semantic bounding without inventing a protected multiline block.
- A protected internal group may still collapse as an emergency fallback after its eligible details have been truncated or removed and only its header can fit. It may be removed only if the hard bound cannot retain that header.

Existing error-retention priorities remain authoritative. Recency is applied within the lowest active retention-priority tier so a newer ordinary command does not displace an older concrete main-agent error prematurely.

### All omission paths participate

Monotonic state must reflect every renderer-controlled path that hides an existing internal group:

- whole-message internal-group collapse/removal;
- outer six-entry budget rollout;
- emergency header-only removal.

A group that is absent from tool history is not marked removed. Only an existing group omitted from the rendered result advances to `removed`.

State-aware rendering must be a fixed point: rendering identical history from the returned candidate state must reproduce identical content and identical state for ordinary collapse/removal, outer-budget rollout, and emergency fallback. Same-frame omission markers must already reflect the returned state; they must not change only after state is persisted and rendered again.

### Omission markers

- A collapsed group rebuilds the omission baseline without descendants; hidden descendants do not count toward `(+N lines)`.
- A removed group is treated as collapsed for the baseline, then contributes one omitted header line.
- Persisted collapsed/removed state must reproduce the same omission-marker semantics on later renders.

## Architecture Decisions

### Keep the renderer pure

Do not pass `SessionEntry` into `render.ts` and do not mutate session state from the renderer.

Add a state-aware rendering API that accepts prior display state and returns both content and candidate next state. Preserve the existing `renderStatusContent(...): string` export as a compatibility wrapper using the default expanded state.

Proposed shape:

```ts
type InternalGroupName = "active-memory" | "skill-harness";
type InternalGroupDisplayLevel = "expanded" | "collapsed" | "removed";
type InternalGroupDisplayState = Record<
  InternalGroupName,
  InternalGroupDisplayLevel
>;

type StatefulStatusRenderResult = {
  content: string;
  candidateDisplayState: InternalGroupDisplayState;
};
```

The exact names may follow neighboring conventions, but the state must be explicit and typed. Do not parse ANSI output or `lastRenderedContent` to reconstruct it.

### Persist state in `SessionEntry`

`SessionEntry` owns optional `confirmedDisplayState` and `monotonicSafetyFloor` values. Missing values normalize to fresh expanded defaults for backward compatibility. `updateStatusMessage()` passes their per-group maximum to the state-aware renderer and handles the returned candidate under the confirmed delivery semantics.

`pendingOp` already serializes status operations, so candidate computation and commit remain ordered without an additional lock.

### Preserve compatibility

- Keep `renderStatusContent()` returning a string for existing callers and possible published deep imports.
- Add a focused state-aware entry point for `session.ts` and tests.
- Do not repurpose the currently unused exported `StatusRenderResult` unless compatibility is explicitly audited; adding a new type is safer than changing an existing exported shape.
- Keep new `SessionEntry` state fields optional because `dist/src/types.d.ts` is published without a restrictive exports map and external deep-import consumers may construct entries.
- Preserve existing boolean/string wrappers around Discord send/edit APIs; add detailed-result variants for internal use instead of changing published return types in place.
- Add no dependencies.

## Dependency Graph

```text
Producer provenance / stale-run ownership
        │
Detailed Discord mutation outcomes
        │
        ├── Typed display-state contract
        │       │
        │       ├── state-aware pure renderer
        │       │       ├── visible newest-owner policy
        │       │       ├── monotonic transition merge
        │       │       └── fixed-point omission reporting
        │       │
        │       └── SessionEntry dual-state persistence
        │               ├── confirmed success commit
        │               ├── uncertain-attempt safety floor
        │               └── reset/replacement initialization
        │
        └── hook-level generation isolation
```

## Implementation Phases

### Phase 0: Producer provenance and delivery outcomes

1. Trace authoritative run identity through every hook producer, including tool hooks, active-memory `agent_end`, and `skill-harness` pipeline events.
2. Add or correct stale-run guards before any history mutation; if tool contexts lack `runId`, introduce current-generation tool-call ownership rather than guessing from the resolved session.
3. Add detailed Discord send/edit outcomes while preserving existing compatibility wrappers.
4. Classify explicit rejection separately from uncertain network/server outcomes.

Checkpoint: real hook-level late-event tests cannot mutate replacement history, and API tests distinguish applied, rejected, and uncertain outcomes.

### Phase 1: Renderer state contract

1. Add display-state types and a default expanded-state helper.
2. Add a state-aware render result while preserving `renderStatusContent()` as a string compatibility wrapper.
3. Apply prior collapsed/removed state as a floor before new bounding.
4. Merge candidate transitions with rank-based monotonic logic rather than scattered conditionals.
5. Require fresh defaults, immutable inputs, and same-history fixed-point output.

Checkpoint: focused renderer tests compile and existing string-output tests remain unchanged when default state is used.

### Phase 2: Newest multiline policy and complete omission reporting

1. Identify each actually renderable multiline field's owning block and source order after all pre-bounding visibility limits.
2. Protect the newest multiline owner according to the confirmed policy.
3. Record state transitions caused by sequential collapse/removal.
4. Record removals caused by the outer entry budget and emergency header fallback.
5. Preserve state while a group is absent and reapply its floor if the group returns.
6. Preserve omission-marker and error-priority behavior in the same frame as each state transition.

Checkpoint: two-frame renderer tests prove that a removed group cannot reappear and a collapsed group cannot expand.

### Phase 3: Session persistence

1. Add optional confirmed state and safety floor to `SessionEntry` and test fixtures.
2. Have `updateStatusMessage()` render from their per-group maximum.
3. Commit confirmed state after successful create/edit or guarded identical visible content.
4. Raise only the safety floor after uncertain delivery; explicit rejection changes neither state.
5. Recheck current session/generation after awaited edit before state commit.
6. Reset both values in session reset, store creation, replacement-session construction, and no-message cleanup paths.

Checkpoint: session and hook tests prove commit, noncommit, serialization, and generation reset behavior.

### Phase 4: Documentation and final review

1. Update `README.md` rendering rules.
2. Update `AGENTS.md` invariants and test expectations.
3. Run full verification and inspect the final diff for compatibility, dead code, and unrelated changes.

## Testing Strategy

Use Vitest and strict TDD for each behavior slice.

### Renderer regression tests

Add focused cases in `src/render-truncation.test.ts`:

- `active-memory` removed while `skill-harness` is newest remains removed after a normal tool appears.
- `active-memory` collapsed in one frame cannot expand in a later shorter frame.
- `skill-harness` remains expanded before any newer normal multiline field exists.
- a newer normal multiline field permits both internal groups to degrade in the configured order.
- prior `removed` input suppresses a group even when the current content would otherwise fit.
- outer-entry rollout and emergency header removal advance candidate state.
- persisted removed groups contribute exactly one omitted header line and no descendant lines.
- error retention still outranks newer ordinary multiline fields.
- the newest owner ignores fields hidden by prior state, outer budget, normal slice, or child limit.
- active-memory as newest degrades older skill-harness before its own truncation.
- absent groups preserve state and reintroduced groups inherit the prior floor.
- rendering identical history from returned state is a content-and-state fixed point for every omission path.
- two fresh defaults do not alias, and deep-frozen prior state remains unchanged.

### Session tests

Add focused cases in `src/session.test.ts`:

- successful create/edit commits a candidate strictly more degraded than prior confirmed state;
- identical content commits a strictly more degraded candidate only when the session is current and has the corresponding status message;
- missing-message and stale-session equality do not commit;
- explicit rejection changes neither confirmed state nor safety floor;
- uncertain network/5xx outcomes raise only the safety floor;
- retry after uncertainty changes history and recomputes from the confirmed/safety maximum rather than a cached candidate;
- replacement during a deferred PATCH prevents post-await commit to the replacement and does not alter its state.

### Lifecycle tests

Add focused cases in `src/hooks.test.ts` or the nearest existing replacement-session test:

- a successfully degraded old generation is replaced by fresh expanded defaults;
- real hook-level late tool, active-memory, and skill-harness events from an old run cannot mutate replacement history or display state;
- reset/retirement clears both state values with tool history, including a degraded session with no status message.

### Verification commands

```bash
pnpm run format
pnpm run typecheck
pnpm run test
pnpm run build
git diff --check
```

Because emitted runtime behavior changes, `pnpm run build` is required.

## Risks and Mitigations

### Ambiguous delivery outcome

Risk: Discord applies a degradation but its response is lost; treating the request as a definite failure allows a later render to expand the visible message.

Mitigation: separate confirmed state from an uncertain monotonic safety floor and classify detailed mutation outcomes instead of relying on boolean success.

### Stale producer reaches replacement

Risk: a late old-run event is resolved directly to the replacement session and mutates its history before display-state guards run.

Mitigation: complete the provenance prerequisite, use available run IDs, and require current-generation ownership for tool-call terminal events when run ID is unavailable.

### Hidden removal path fails to update state

Risk: a group removed by entry budget or emergency fallback later resurrects.

Mitigation: make state part of the render result and test every omission path, not only the primary 1700-character loop.

### Stateful render is not a fixed point

Risk: outer-budget or emergency omission reports `removed`, but the same frame uses a different omission baseline; the next identical render changes content.

Mitigation: require same-history content-and-state idempotence and test each omission path across two renders.

### Renderer API break

Risk: changing `renderStatusContent()` return type breaks internal tests or published deep-import consumers.

Mitigation: preserve the existing string API and add a state-aware API.

### Incorrect reset boundary

Risk: a new user run inherits a previous run's removed groups, or an old run resets a replacement session.

Mitigation: bind state to `SessionEntry` identity/generation, close missing producer provenance, recheck after awaited edits, and test real hook routing rather than only direct calls on stale entries.

### Over-aggressive monotonic degradation

Risk: temporary content growth permanently hides useful details.

Mitigation: this is the explicitly chosen UX contract. Restrict lifetime to one status session/generation and reset on replacement.

### Excess complexity in `render.ts`

Risk: state reporting adds more branching to the renderer hotspot.

Mitigation: use one rank-based transition helper and one explicit render-result type; avoid a generic state machine framework or session mutation inside the renderer.

## Boundaries

### Always

- Preserve ANSI sanitization and complete fences.
- Preserve the 1700 hard bound and 100–1700 runtime config range.
- Preserve error-retention priorities and semantic-node ordering unless this spec explicitly changes them.
- Preserve `toolHistory`; display degradation must not delete history.
- Keep Discord operations serialized through `pendingOp`.
- Use the per-group maximum of confirmed state and safety floor for every render.
- Preserve prior group state while that group is absent from history.
- Add failing regression tests before production changes.

### Ask first

- Changing the outer six-entry budget.
- Allowing a removed/collapsed group to recover within the same generation.
- Changing public config or adding a new user-facing option.
- Changing published exports beyond adding a compatibility-preserving state-aware API.

### Never

- Parse ANSI output to derive state.
- Mutate `SessionEntry` from `render.ts`.
- Treat an uncertain Discord mutation as either confirmed success or explicit rejection; uncertain outcomes update only the safety floor.
- Reset replacement-session state from stale events.
- Share mutable default state objects between sessions or mutate renderer input.
- Commit or push without explicit authorization.

## Success Criteria

- No internal group expands or reappears after degrading within one session generation.
- Before newer normal multiline content exists, the newest internal multiline block remains visible as long as bounded output can retain useful content.
- Confirmed state changes only when it matches a successfully visible Discord message; uncertain outcomes can only raise the separate safety floor.
- Replacement sessions start clean and stale events cannot affect them.
- Rendering identical history from returned state is a content-and-state fixed point.
- Current-generation provenance is enforced before all history mutation paths.
- Existing string renderer callers remain compatible.
- Focused regression tests, full tests, typecheck, formatting, build, and diff checks all pass.

## Open Questions

No product-policy questions remain. Phase 0 must still resolve two technical evidence questions before implementation continues:

1. Whether the live OpenClaw tool-hook context exposes an authoritative `runId` that the local `ToolContext` type currently omits; otherwise the implementation must use current-generation tool-call ownership.
2. Whether official Discord API behavior offers a small compatible idempotency mechanism for status-message POST. If not, uncertain POST duplicate recovery remains explicitly outside this display-state change while still raising the safety floor.
