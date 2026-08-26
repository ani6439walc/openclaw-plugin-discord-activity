# Agent Guide: Discord Activity

This repository is an OpenClaw plugin. It shows live tool-call status in Discord by creating one ANSI-colored status message per Discord conversation, editing it as tools run, folding in internal `active-memory` and `skill-harness` subagent status, and deleting the message after the agent finishes.

Use this file as the working contract for coding agents. The README explains the product behavior; this guide explains how to change the code safely.

## First Checks

Before editing, inspect the current state:

```bash
git status --short
pnpm run typecheck
pnpm run test
```

If tests already fail, capture the failure before changing code. Do not hide pre-existing failures inside unrelated edits.

## Commands

```bash
pnpm run typecheck          # TypeScript, no emit
pnpm run test               # Full Vitest suite
pnpm run build              # Compile to dist/
pnpm run format             # Prettier for md/json/ts files
```

Run `pnpm run typecheck` and `pnpm run test` before handing off code changes. Run `pnpm run build` when changing plugin registration, package metadata, SDK imports, emitted behavior, or anything that depends on `dist/` output. Run `pnpm run format` after editing Markdown, JSON, or TypeScript.

Package-shape rule: `package.json` publishes `dist`, and `pnpm run build` cleans `dist/` before compiling with `tsconfig.build.json`. The build config intentionally includes only runtime entries (`api.ts`, `index.ts`, `token.ts`, `src/**/*.ts`) while excluding tests and root tooling such as `test-helpers.ts` and `vitest.config.ts`. If you touch package/build/release behavior, verify with `pnpm run build` and `pnpm pack --dry-run`, and check that the tarball does not include `dist/vitest.config.*`, `dist/test-helpers.*`, stale renamed files, or missing runtime files.

## Source Map

Load module details only when needed through CodeGraph; do not maintain a duplicated per-file inventory here. Start with the prompt closest to the change:

```bash
codegraph explore "plugin lifecycle hooks rendering discord status"
codegraph explore "message_received before_tool_call after_tool_call agent_end session routing"
codegraph explore "updateStatusMessage Discord create edit delete retry DM fallback"
codegraph explore "renderStatusContent ANSI status bounds tool history"
codegraph explore "plugin config manifest token resolver registration"
codegraph explore "<target symbol or behavior> affected tests"
```

Use the returned source and call paths to load only the necessary symbols. If exploration is insufficient, narrow with `codegraph query`, `codegraph node`, `codegraph callers`, `codegraph callees`, or `codegraph impact`.

## Runtime Behavior

The core flow is:

1. `message_received` resolves Discord context and starts or replaces a session for the conversation.
2. `before_tool_call` adds a pending tool entry, or stores an orphan when no Discord session is known yet.
3. `after_tool_call` marks entries completed, errored, or orphan-reconciled, then updates the Discord status message.
4. `before_agent_reply` and `message_sending` finalize visible status before the final user-facing reply.
5. `agent_end` records main-agent failure state, handles main-session cleanup, and captures final `active-memory` output and failure details from its internal session. Legacy `skill-harness` `agent_end` result rendering is intentionally ignored.
6. `skill-harness` status comes from the `plugin:skill-harness` pipeline event subscription, not from ordinary tool-call hooks.

Important behavior to preserve:

- Status messages are ANSI code blocks. Sanitize untrusted tool names and visible values before inserting them; never allow an external ANSI sequence, control character, newline, or backtick to escape the renderer's own structure.
- Normal tools render after internal subagent groups.
- `active-memory` and `skill-harness` groups stay in stable order; `💥 agent ✘` renders after all retained normal tools.
- `skill-harness` JSON object results flatten to key-value fields.
- `skill-harness` plain text results render as `result: <text>`; do not let them become unlabeled list items.
- Failed `skill-harness` phases render one concrete phase-local `error`. The canonical producer field is `error`; tolerate legacy failed-event `reason` and `result` with `error → reason → result` precedence, and do not repeat the same error at group level.
- Drive the `skill-harness` group status from its explicit parent lifecycle entry: remain pending through child phase completions and show `✔` only after `pipeline:completed`, when the producer guarantees no further phase will run. `pipeline:failed` or any failed child renders `✘`.
- `active-memory` result text renders as `result: <text>`.
- Failed `active-memory` children preserve live terminal `error` and `durationMs` when final transcript parsing omits or contradicts them. Render each child error phase-locally, keep distinct parent errors, and deduplicate identical parent/child text.
- Keep the `active-memory` group pending through completed child tools until its terminal `agent_end` parent succeeds; a failed child may still make the group fail. Show the group duration only from that terminal parent. If the parent remains pending or omits `durationMs`, omit the group duration instead of deriving it from child timings; keep individual child durations visible.
- Final `active-memory` transcripts may use tool-call IDs that differ from live hook events. Reconcile them occurrence-by-occurrence by tool name and stable parameters without collapsing genuinely repeated calls.
- Main-agent failure renders once as the detail-free `💥 agent ✘` bottom block. It occupies one protected slot in the shared 6-entry budget.
- Codex/OpenClaw-prefixed tool names such as `openclawskill_view` should display as their canonical tool names (`skill_view`) immediately; avoid visible name flicker.
- Prefer a tool-provided `durationMs`; when it is absent, derive elapsed time from the first observed `before_tool_call`. Preserve that value across duplicate terminal events instead of erasing or recalculating it.
- Use the producer-provided `durationMs` from the terminal skill-harness parent lifecycle event for the group duration. Keep locally observed start/completion fallback only for individual legacy phase events.
- Render durations up to and including 1000ms in milliseconds. Above 1000ms and under 10 seconds, round seconds to at most two decimal places; from 10 seconds onward, round to at most one decimal place. Omit trailing fractional zeros and a leftover decimal point.
- Finalized sessions should not create duplicate status messages from late tool events.
- `maxDisplaySeconds` is an idle timeout, not a total status lifetime: arm it after a confirmed create, then re-arm it for each current-session status update before queued Discord work. Convert it to milliseconds only at timer boundaries. Normal final cleanup and replacement retirement still take precedence.
- Tool, agent, and skill-harness lifecycle events with a mismatched `runId` must not mutate or finalize a replacement session for the same Discord conversation. Guard provenance before any history mutation.
- Per-session Discord operations must remain serialized through `pendingOp` to avoid create/edit/delete races. Capture generation and owner before awaiting Discord, then revalidate before committing message IDs, rendered content, or display state.
- Top-level block display state is generation-scoped and monotonic: `expanded → collapsed → removed`. Stable `displayId` values keep ordinary tools from resurrecting when dedupe changes `toolCallId`. Confirmed Discord creates/edits advance `confirmedDisplayState`; exhausted network or final `5xx` outcomes advance `monotonicSafetyFloor`; explicit rejection advances neither. Render from their per-block maximum, and reset both on replacement or cleanup.
- Discord status creates use `nonce` with `enforce_nonce`. Preserve one `statusCreateNonce` across uncertain high-level retries, including intervening missing-token rejections, and clear it only after a usable message ID or session reset. A replayed create may return older content, so immediately PATCH the current render before committing it. Track uncertain PATCH delivery separately and do not use the unchanged-content shortcut until a later PATCH is confirmed.
- DM sessions may need `resolveDmChannel()` before sending.
- Missing Discord token or Discord API failures should fail open by logging and skipping status updates, not by blocking the agent flow.
- Treat Discord delete `404` as success. Only `429`, `5xx`, and network exhaustion may schedule one detached delete recovery after `DELETE_RECOVERY_DELAY_MS` (5 seconds); missing tokens and `401`/`403` are terminal. Detached recovery must use captured immutable identifiers and must not mutate session maps.
- Each `active-memory` and `skill-harness` group independently displays up to `STATUS_MAX_SUBAGENT_ENTRIES` (3 children). Internal groups, normal tools, and main-agent failure share the outer `STATUS_MAX_ENTRIES` (6 blocks) budget. Main-agent failure uses the last slot when present. Older eligible blocks are removed from the top without mutating `toolHistory`; `STATUS_MAX_LENGTH` (1700 characters) independently bounds rendered length.
- Global bounding is block-based and monotonic. Apply prior display state, the shared outer limit, and per-group child limits first. If content remains too long, collapse every eligible block from top to bottom; only after all are collapsed, remove blocks from top to bottom. Never remove the protected bottom main-agent failure during normal degradation. The state-aware renderer must reach a fixed point: rendering the same history with its returned state produces identical content and state.
- Root tree connectors begin under the second text character after the header emoji and separating space. Nested connectors and multiline continuation text likewise begin under the second text character of their parent text.
- Every visible field keeps at most 70 Unicode code points after sanitization and serialization. Truncated values append an exact gray `(+N chars)` hint (`char` when singular) without splitting surrogate pairs. Preserve producer field order and supplied line breaks within the fixed prefix; do not add hard wraps.
- Bounded output counts ANSI sequences and fence overhead, emits no global `(+N items)` or `(+N lines)` marker, and ends with a complete ANSI fence. Direct renderer limits below the 12-code-unit empty-fence minimum are invalid; an empty fence is the final fallback when even protected content cannot fit. Runtime config remains constrained to 100–1700.
- Compact metadata rows include any single-line fields whose total formatted width (key + value + colon/space/omission hint) is less than or equal to 34 characters, regardless of their data types.

## Coding Rules

- Use ESM imports with `.js` suffix for local TypeScript modules.
- Prefer focused functions over broad abstractions. Do not introduce framework-style layers for one caller.
- Avoid `any` in new code unless matching an existing plugin SDK boundary that is already untyped; prefer `unknown` plus narrowing for untrusted input.
- Keep `src/plugin.ts` thin. If behavior grows, put it in `hooks.ts`, `session.ts`, or a focused helper module.
- Keep Discord API logic in `src/discord-api.ts`; do not call `fetch()` directly from hooks or renderers.
- Keep rendering pure in `src/render.ts` and `src/formatting.ts`; do not add Discord API calls or session mutation there.
- Keep OpenClaw/Codex tool-name canonicalization in `src/tool-name.ts`; both hook dedupe and rendering must use the same helper to avoid regex drift or visible prefixed-name flicker.
- Keep hook code fail-open. Log non-fatal failures with `logger.warn()` and avoid blocking the main agent reply.
- Do not remove cleanup guards involving `generation`, `ownerSessionKey`, `finalized`, or `isCurrentSession()` unless tests prove the race is impossible.
- Do not broaden a bugfix PR with unrelated renderer, store, or SDK refactors.

## Testing Expectations

Add or update focused tests with behavior changes.

Typical mapping:

- Config parsing/defaults: `src/config.test.ts`.
- Discord API retry, rate limit, and response handling: tests near `src/discord-api.ts` if added.
- Delete cleanup and replacement-session safety: `src/session-delete-recovery.test.ts`.
- Rendering behavior: `src/render.test.ts`.
- Main-agent failure rendering and lifecycle: `src/main-agent-failure.test.ts`.
- Active-memory failure parsing, merge precedence, and rendering: `src/active-memory-failure.test.ts`.
- Bounded rendering and history preservation: `src/render-truncation.test.ts`.
- Session message lifecycle, pending operation serialization, cleanup, and DM fallback: `src/session.test.ts`.
- Store ownership/current-session behavior: `src/store.test.ts`.
- Orphan tool behavior: `src/orphans.test.ts`.
- Hook-level routing and lifecycle behavior: `src/hooks.test.ts`.
- Plugin registration and manifest-facing behavior: `src/plugin.test.ts`.
- SDK entrypoint and version alignment: `src/runtime-compatibility.test.ts`.
- Tool-history helper behavior: `src/tool-history-manager.test.ts`.
- Package/build hygiene changes: run `pnpm run build` and inspect `pnpm pack --dry-run` output for unwanted `dist/vitest.config.*`, `dist/test-helpers.*`, stale renamed files, or missing runtime files.

Bug fixes should include a regression test that fails before the fix. For formatter changes, include both direct renderer tests and hook-level tests when the issue appears in real Discord status content.

CodeGraph currently reports these affected tests for core runtime files (`src/hooks.ts`, `src/render.ts`, `src/session.ts`, `src/discord-api.ts`): `src/hooks.test.ts`, `src/plugin.integration.test.ts`, `src/plugin.test.ts`, `src/render.test.ts`, `src/session.test.ts`, and `src/store.test.ts`.

## Documentation Updates

Update docs when behavior or public configuration changes:

- `README.md` for user-facing behavior, configuration, status format, architecture, and workflows.
- `openclaw.plugin.json` for manifest-visible config descriptions/defaults.
- `AGENTS.md` for coding-agent rules and known gotchas.

When README behavior claims depend on code, verify against the source before writing. CodeGraph is useful here:

```bash
codegraph sync
codegraph status
codegraph explore "plugin lifecycle hooks rendering discord status"
codegraph node createHookHandlers
codegraph node renderStatusContent
```

For codebase-size or package-shape claims, also verify with `pygount` and `pnpm pack --dry-run`; CodeGraph describes indexed code structure, not publish contents or non-code asset weight. If CodeGraph was used for analysis and code changed afterward, run `codegraph sync` before handing off.

## Git and PR Workflow

- Do not commit, push, merge, or delete branches unless explicitly asked.
- Use summary-only conventional commits, for example:
  - `fix: label skill harness plain text result`
  - `refactor: simplify result label assertions`
  - `docs: document plugin architecture`
- Before pushing to an existing PR branch, check PR state with `gh pr view --json state,headRefName,url`.
- If the PR is already `MERGED`, do not keep pushing to that old branch. Create a fresh branch from `origin/main` and open a follow-up PR containing only the new changes.
- If a reviewer is requested, use `gh pr create --reviewer <user>` or `gh pr edit --add-reviewer <user>`.

## Finish Checklist

Before final handoff:

- `git diff` contains only intentional changes.
- `pnpm run format` passes when Markdown/JSON/TypeScript changed.
- `pnpm run typecheck` passes.
- `pnpm run test` passes.
- `pnpm run build` passes when emitted plugin behavior, package metadata, SDK imports, or release artifacts are touched.
- README, manifest, and AGENTS.md are synchronized with source behavior.
- No unrelated user changes were reverted.
