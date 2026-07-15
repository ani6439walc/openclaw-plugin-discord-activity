# Task List: Monotonic Internal-Group Display

## Task 0: Prove producer provenance and block stale-run mutation

**Description:** Trace authoritative run identity through every hook producer, then prevent old-run tool, active-memory, and skill-harness events from mutating replacement history. This is a prerequisite because display-state guards cannot repair history that was already routed to the wrong generation.

**Acceptance criteria:**

- [ ] Official/live OpenClaw hook evidence establishes whether tool contexts provide `runId` beyond the current local type.
- [ ] Every producer with `runId` binds it before history mutation.
- [ ] If tool hooks lack `runId`, accepted tool-call IDs are owned by one session generation and unowned late terminal events cannot attach to a replacement.
- [ ] Real hook-level late events leave both replacement history and display state unchanged.

**Verification:**

- [ ] Add failing hook-routing tests for tool, active-memory, and skill-harness late events before implementation.
- [ ] Run `pnpm exec vitest run src/hooks.test.ts src/main-agent-failure.test.ts src/skill-harness-status.test.ts`.
- [ ] Run `pnpm run typecheck`.

**Dependencies:** None.

**Files likely touched:**

- `src/types.ts`
- `src/hooks.ts`
- `src/hooks.test.ts`
- `src/main-agent-failure.test.ts`
- `src/skill-harness-status.test.ts`

**Estimated scope:** Medium.

## Task 1: Classify Discord mutation outcomes

**Description:** Add detailed internal send/edit outcomes so session logic can distinguish confirmed application, explicit rejection, and uncertain network/server results while preserving existing compatibility wrappers.

**Acceptance criteria:**

- [ ] Internal send/edit APIs return `applied`, `rejected`, or `uncertain` with reason/status metadata.
- [ ] Missing token and non-retryable 4xx are explicit rejection; exhausted network errors, final 5xx, and successful POST without a usable ID are uncertain.
- [ ] Existing public boolean/string wrappers retain their current signatures and behavior.
- [ ] Official Discord evidence is checked for a small compatible POST idempotency mechanism; absent one, uncertain duplicate creation remains documented outside this display-state fix.

**Verification:**

- [ ] Add failing API and operation tests for every outcome class before implementation.
- [ ] Run `pnpm exec vitest run src/discord-api.test.ts src/discord-message-operations.test.ts`.
- [ ] Run `pnpm run typecheck`.

**Dependencies:** None.

**Files likely touched:**

- `src/discord-api.ts`
- `src/discord-api.test.ts`
- `src/discord-message-operations.ts`
- `src/discord-message-operations.test.ts`

**Estimated scope:** Medium.

## Task 2: Define the pure display-state contract

**Description:** Add explicit internal-group display types, default state, monotonic rank merge, and a state-aware renderer API while preserving the existing string renderer export.

**Acceptance criteria:**

- [ ] `expanded → collapsed → removed` is represented by a typed contract.
- [ ] Prior state is an input and candidate next state is an output; the renderer does not mutate session state.
- [ ] `renderStatusContent()` remains a string-returning compatibility wrapper.
- [ ] Every default-state call returns a fresh value; two sessions cannot alias.
- [ ] Deep-frozen prior state is accepted unchanged.
- [ ] New `SessionEntry` fields remain optional and normalize to expanded defaults for deep-import compatibility.

**Verification:**

- [ ] Add a failing renderer test for monotonic rank behavior before implementation.
- [ ] Run `pnpm exec vitest run src/render.test.ts src/render-truncation.test.ts`.
- [ ] Run `pnpm run typecheck`.

**Dependencies:** None; may proceed after Task 0 evidence is recorded.

**Files likely touched:**

- `src/types.ts`
- `src/render.ts`
- `src/render.test.ts`
- `src/render-truncation.test.ts`

**Estimated scope:** Medium.

## Task 3: Protect the newest multiline owner and report every omission path

**Description:** Implement the newest-multiline-owner policy, apply prior state as a rendering floor, and include outer-budget and emergency removals in the candidate state.

**Acceptance criteria:**

- [ ] Before normal multiline content exists, the newest internal multiline group remains expanded while useful bounded content can fit.
- [ ] After normal multiline content appears, internal groups degrade in the confirmed order.
- [ ] When active-memory owns the newest visible multiline field, older skill-harness degrades before active-memory truncation.
- [ ] A two-frame render cannot expand or resurrect either group.
- [ ] Outer-entry and emergency removal paths advance state consistently.
- [ ] Omission markers and error priorities remain correct.
- [ ] Owner selection ignores fields hidden by prior state, outer budget, normal slice, and child limits.
- [ ] Absent groups preserve prior state and reintroduced groups inherit the same floor.
- [ ] Rendering identical history from returned state reproduces identical content and state for every omission path.

**Verification:**

- [ ] Add failing two-frame regression tests before implementation.
- [ ] Run `pnpm exec vitest run src/render-truncation.test.ts`.
- [ ] Run `pnpm run typecheck`.

**Dependencies:** Task 2.

**Files likely touched:**

- `src/render.ts`
- `src/render-truncation.test.ts`

**Estimated scope:** Medium.

## Checkpoint: Pure renderer

- [ ] Default-state string rendering remains backward compatible.
- [ ] Renderer tests pass.
- [ ] No `SessionEntry` mutation exists in `render.ts`.
- [ ] Review the renderer diff before adding session persistence.

## Task 4: Persist confirmed state and uncertain safety floor

**Description:** Store optional confirmed state and monotonic safety floor in `SessionEntry`, render from their per-group maximum inside the serialized operation, and apply the detailed delivery outcome contract.

**Acceptance criteria:**

- [ ] Successful create/edit commits a candidate strictly more degraded than prior confirmed state.
- [ ] Identical content commits a strictly more degraded candidate only when the session is current and has the corresponding `statusMessageId`.
- [ ] Missing-message and stale-session equality do not commit.
- [ ] Explicit rejection changes neither confirmed state nor safety floor.
- [ ] Uncertain network/5xx outcomes raise only the safety floor.
- [ ] Retry after uncertainty changes history and recomputes from the confirmed/safety maximum rather than reusing a cached candidate.
- [ ] Replacement during a deferred PATCH cannot commit after the await or mutate replacement state.

**Verification:**

- [ ] Add failing session tests before implementation.
- [ ] Run `pnpm exec vitest run src/session.test.ts src/session-delete-recovery.test.ts`.
- [ ] Run `pnpm run typecheck`.

**Dependencies:** Tasks 1 and 3.

**Files likely touched:**

- `src/types.ts`
- `src/session.ts`
- `src/session.test.ts`
- `test-helpers.ts`

**Estimated scope:** Medium.

## Task 5: Reset and isolate state on lifecycle boundaries

**Description:** Initialize expanded defaults for new sessions, clear state during reset/retirement, and ensure replacement generations do not inherit or accept stale state.

**Acceptance criteria:**

- [ ] A successfully degraded old generation is replaced by fresh expanded defaults.
- [ ] Session reset clears confirmed state and safety floor with history and rendered content.
- [ ] A degraded session with no `statusMessageId` is also reset rather than returning early with stale state.
- [ ] Late events from old runs cannot mutate replacement state or history.

**Verification:**

- [ ] Add failing lifecycle tests before implementation.
- [ ] Run `pnpm exec vitest run src/hooks.test.ts src/main-agent-failure.test.ts src/store.test.ts`.
- [ ] Run `pnpm run typecheck`.

**Dependencies:** Tasks 0 and 4.

**Files likely touched:**

- `src/store.ts`
- `src/hooks.ts`
- `src/hooks.test.ts`
- `src/main-agent-failure.test.ts`
- `src/store.test.ts`

**Estimated scope:** Medium.

## Checkpoint: Stateful session lifecycle

- [ ] Renderer remains pure.
- [ ] Confirmed state matches successful visible Discord state; uncertain outcomes affect only the safety floor.
- [ ] Replacement generation resets state.
- [ ] Focused renderer, session, store, and hooks tests pass.

## Task 6: Synchronize documentation and run final gates

**Description:** Update user-facing and agent-facing rendering rules, then perform final quality review and full verification.

**Acceptance criteria:**

- [ ] `README.md` documents monotonic degradation, newest multiline preservation, and confirmed-versus-uncertain state semantics.
- [ ] `AGENTS.md` records provenance, state ownership, outcome classification, reset boundaries, fixed-point behavior, and required tests.
- [ ] Final diff contains only the planned behavior change, tests, and documentation.

**Verification:**

- [ ] Run `pnpm run format`.
- [ ] Run `pnpm run typecheck`.
- [ ] Run `pnpm run test`.
- [ ] Run `pnpm run build`.
- [ ] Run `git diff --check`.
- [ ] Inspect `git status --short` and the complete staged/unstaged diff.

**Dependencies:** Tasks 0–5.

**Files likely touched:**

- `README.md`
- `AGENTS.md`

**Estimated scope:** Small.

## Final Checkpoint

- [ ] Every new behavior was introduced by a failing test.
- [ ] No group regresses from removed/collapsed to a more visible state in one generation.
- [ ] Explicit rejection advances neither state; uncertain delivery advances only the safety floor.
- [ ] New generations start expanded.
- [ ] Late old-run events cannot mutate replacement history or state.
- [ ] Stateful rendering is a content-and-state fixed point.
- [ ] Existing renderer API remains compatible.
- [ ] Full project gates pass.
- [ ] No commit or push occurs without explicit authorization.
