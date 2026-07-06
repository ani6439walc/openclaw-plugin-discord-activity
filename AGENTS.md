# Agent Guide: Discord Tool Status

This repository is an OpenClaw plugin. It shows live tool-call status in Discord by creating one YAML-formatted status message per Discord conversation, editing it as tools run, folding in internal `active-memory` and `skill-harness` subagent status, and deleting the message after the agent finishes.

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

## Source Map

Keep the current module boundaries:

- `src/plugin.ts`: assembly layer. Resolve plugin config, token resolver, companion-plugin enablement checks, instantiate shared runtime state, and register OpenClaw hooks.
- `src/hooks.ts`: OpenClaw hook behavior. Own session routing, tool lifecycle updates, subagent placeholder/result handling, orphan reconciliation, and finalization.
- `src/session.ts`: Discord status message lifecycle. Send, edit, retire, delete, serialize pending message operations, handle DM fallback, and enforce max display cleanup.
- `src/store.ts`: active session and Discord context tracking.
- `src/orphans.ts`: temporary storage for tool calls that arrive before a Discord session is available.
- `src/parser.ts`: session-key parsing, Discord context extraction, sender/channel ID extraction, and final subagent result extraction.
- `src/render.ts`: convert tool history into YAML Discord status content.
- `src/formatting.ts`: icons and parameter formatting helpers.
- `src/discord-api.ts`: Discord REST calls, rate-limit retry, server-error retry, and DM channel resolution.
- `src/config.ts`: Zod-backed plugin config parsing and defaults.
- `src/types.ts`: shared event, session, store, and tool-entry types.
- `src/*.test.ts`: colocated Vitest coverage for each module.
- `openclaw.plugin.json`: manifest-visible activation and config schema.
- `README.md`: user-facing behavior, config, architecture, and workflows.

## Runtime Behavior

The core flow is:

1. `message_received` resolves Discord context and starts or replaces a session for the conversation.
2. `before_tool_call` adds a pending tool entry, or stores an orphan when no Discord session is known yet.
3. `after_tool_call` marks entries completed, errored, or orphan-reconciled, then updates the Discord status message.
4. `before_agent_reply` and `message_sending` finalize visible status before the final user-facing reply.
5. `agent_end` handles main-session cleanup and captures final internal subagent output for `active-memory` and `skill-harness` sessions.

Important behavior to preserve:

- Status messages are YAML code blocks.
- Normal tools render after internal subagent groups.
- `active-memory` and `skill-harness` groups stay in stable order before normal tools.
- `skill-harness` JSON object results flatten to key-value fields.
- `skill-harness` plain text results render as `result: <text>`; do not let them become unlabeled list items.
- `active-memory` result text renders as `result: <text>`.
- Finalized sessions should not create duplicate status messages from late tool events.
- Per-session Discord operations must remain serialized through `pendingOp` to avoid create/edit/delete races.
- DM sessions may need `resolveDmChannel()` before sending.
- Missing Discord token or Discord API failures should fail open by logging and skipping status updates, not by blocking the agent flow.
- Status messages are limited to `STATUS_MAX_ENTRIES` (6 entries) independently for normal tools, `active-memory` children, and `skill-harness` children, plus `STATUS_MAX_LENGTH` (1700 characters) to prevent excessive message length.

## Coding Rules

- Use ESM imports with `.js` suffix for local TypeScript modules.
- Prefer focused functions over broad abstractions. Do not introduce framework-style layers for one caller.
- Avoid `any` in new code unless matching an existing plugin SDK boundary that is already untyped; prefer `unknown` plus narrowing for untrusted input.
- Keep `src/plugin.ts` thin. If behavior grows, put it in `hooks.ts`, `session.ts`, or a focused helper module.
- Keep Discord API logic in `src/discord-api.ts`; do not call `fetch()` directly from hooks or renderers.
- Keep rendering pure in `src/render.ts` and `src/formatting.ts`; do not add Discord API calls or session mutation there.
- Keep hook code fail-open. Log non-fatal failures with `logger.warn()` and avoid blocking the main agent reply.
- Do not remove cleanup guards involving `generation`, `ownerSessionKey`, `finalized`, or `isCurrentSession()` unless tests prove the race is impossible.
- Do not broaden a bugfix PR with unrelated renderer, store, or SDK refactors.

## Testing Expectations

Add or update focused tests with behavior changes.

Typical mapping:

- Config parsing/defaults: `src/config.test.ts`.
- Discord API retry, rate limit, and response handling: tests near `src/discord-api.ts` if added.
- Rendering behavior: `src/render.test.ts`.
- Session message lifecycle, pending operation serialization, cleanup, and DM fallback: `src/session.test.ts`.
- Store ownership/current-session behavior: `src/store.test.ts`.
- Orphan tool behavior: `src/orphans.test.ts`.
- Hook-level routing and lifecycle behavior: `src/hooks.test.ts`.
- Plugin registration and manifest-facing behavior: `src/plugin.test.ts`.

Bug fixes should include a regression test that fails before the fix. For formatter changes, include both direct renderer tests and hook-level tests when the issue appears in real Discord status content.

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

If CodeGraph was used for analysis and code changed afterward, run `codegraph sync` before handing off.

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
