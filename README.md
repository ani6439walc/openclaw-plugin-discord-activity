# Discord Activity Plugin for OpenClaw

[![OpenClaw](https://img.shields.io/badge/Platform-OpenClaw-blue.svg)](https://clawhub.ai/wei840222/plugins/discord-activity)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Discord Activity is an OpenClaw plugin that shows live agent and tool activity in Discord. For each Discord conversation, it creates one ANSI-colored status message, edits that message as tools run, folds in internal `active-memory` and `skill-harness` status, then removes the status message after the agent finishes.

## Why this exists

When an OpenClaw agent is working from Discord, long-running tool calls can otherwise look like silence. This plugin gives users and operators a lightweight progress view without changing the final assistant reply.

It helps answer:

- Is the agent currently using tools?
- Which tool or internal pipeline phase is running?
- Did a tool complete, fail, or get reconciled after arriving before a Discord session existed?
- How long did completed tools take?
- Are internal companion workflows such as `active-memory` and `skill-harness` still running?

The plugin is designed to fail open: if Discord credentials are missing or Discord API calls fail, it logs the problem and skips status updates instead of blocking the agent flow.

## What it shows

Status messages are Discord ANSI code blocks. The latest non-empty `progress_card` is pinned first, internal subagent groups follow, normal tools come next, and a main-agent failure appears last when present.

### Example display

The image below is an example of how a live tool-status message appears in Discord:

![Discord Activity showing nested companion workflows, tool durations, compact metadata, and exact truncation hints](https://raw.githubusercontent.com/ani6439walc/openclaw-plugin-discord-activity/main/example.png)

This example shows `active-memory` and `skill-harness` groups, nested tool parameters, compact metadata rows, duration badges, and exact character-omission hints in one continuously edited Discord message. The same structure in simplified text form is:

```ansi
🧩 active-memory ▾ ✔ [120ms]
    ├─ memory_search ✔ [120ms]
    │   └─ query: project notes
    └─ result: Relevant memory found

💡 skill-harness ▾ ✔
    └─ intent ✔
        ├─ reason: User asked for a review
        └─ confidence: 0.92

🔍 web_search ▾ ✔ [450ms]
    └─ query: OpenClaw plugin SDK
```

Status markers:

- `▾` details are expanded.
- `▸` details were collapsed to fit the message.
- `←` pending or currently visible as the latest non-final completed entry.
- `✔` completed.
- `✘` errored.
- `♻︎` orphan-reconciled after the tool result arrived before the Discord session was known.

Rendering rules to preserve:

- The latest `progress_card` tool call is rendered as one protected `📋 progress` block above every activity entry instead of appearing as an ordinary tool. Its Markdown note is flattened into a plain-text summary on a separate non-bold blue line below the bold cyan tool-style header, with formatting markers, links, raw HTML, and line breaks removed; a leading `<progress aria-label="…">` contributes a compact label when no plan exists, and every valid plan step remains ordered with `✓` completed, `→` in progress, or `·` pending. A later empty card clears the block. Under the hard message limit, ordinary blocks are collapsed/removed before the progress note is compacted; plan steps remain visible whenever the protected content can fit.
- Normal tools render after `active-memory` and `skill-harness` groups.
- `active-memory` and `skill-harness` group order is stable.
- Each top-level tree connector starts under the second text character after the header emoji and separating space. Nested connectors and multiline continuation text likewise start under the second text character of their parent text.
- A failed main agent renders once as `💥 agent ✘` at the bottom. It occupies one slot in the shared 6-entry budget, has no detail row, and is protected from normal block removal.
- `skill-harness` JSON object results flatten to key-value fields.
- `skill-harness` plain text results render as `result: <text>`.
- Failed `skill-harness` phases render their concrete `error` beneath the failed phase exactly once. During rolling upgrades, legacy failed-event `reason` and `result` fields are normalized to the same phase-local error.
- The `skill-harness` group status follows its explicit parent lifecycle: it remains `←` while phases run and changes to `✔` only when the producer declares `pipeline:completed`, after no further phase can run. `pipeline:failed` or any failed child renders `✘`.
- `active-memory` result text renders as `result: <text>`. Fastpath context observed through `llm_input` renders as `fastpath`: a memory hit uses `status: observed`, while the explicit no-recall and unavailable outcomes use `status: skipped` and `status: unavailable`. Direct-message sessions also show sanitized, bounded memory text; shared or unknown session types retain status only. If no observable Active Memory child or prompt context appears before finalization, the group falls back to `status: inferred` without claiming a memory hit.
- Failed `active-memory` child tools keep their own phase-local errors and durations. A distinct parent failure is also shown; identical parent/child error text is rendered once.
- The `active-memory` group remains `←` while its parent awaits terminal `agent_end`, even when all child tools have completed; a failed child may still render the group as `✘`. A successful terminal parent changes the group to `✔`. Group duration is shown only from that terminal parent, so a pending parent or one without `durationMs` leaves the group duration blank while individual child durations remain visible.
- Tool-provided durations take precedence. When a completion omits `durationMs`, elapsed time falls back to the first observed `before_tool_call`; duplicate terminal events preserve that value instead of recalculating it.
- The `skill-harness` group duration comes directly from the producer's terminal parent lifecycle event. Individual phase durations still fall back to locally observed start/completion timing when the event does not provide `durationMs`.
- Durations up to and including 1000ms render in milliseconds. Durations above 1000ms and under 10 seconds round to at most two decimal places; durations of 10 seconds or more round to at most one decimal place. Trailing fractional zeros and a leftover decimal point are omitted.
- Status output keeps up to 3 child entries independently inside each of the `active-memory` and `skill-harness` groups. Internal groups, normal tools, and a main-agent failure share one 6-entry outer budget; the failure uses the last slot when present. Older eligible blocks are removed from the top without mutating retained `toolHistory`.
- Every visible field keeps at most 70 Unicode code points after sanitization and serialization. Truncated values append an exact gray `(+N chars)` hint (`char` when singular) without splitting surrogate pairs. Producer field order and supplied line breaks are preserved within that fixed prefix; the renderer does not add hard wraps.
- Compact metadata rows pack any single-line fields whose total formatted width (key + value + colon/space/omission hint) is less than or equal to 34 characters, regardless of their data types.
- Every internal group and normal tool header shows a non-bold light-gray disclosure marker: `▾` while details are expanded and `▸` after bounding collapses the block. A stable per-entry display identity keeps each block monotonic within one session generation: `expanded → collapsed → removed`. Confirmed Discord mutations advance confirmed state; uncertain delivery advances a conservative safety floor; later frames cannot resurrect or re-expand a degraded block.
- Bounded output counts ANSI sequences and fence overhead. If the fixed 70-code-point fields still exceed the configured length, the renderer first collapses eligible blocks from top to bottom. Only after every eligible block is collapsed does it remove blocks from top to bottom, while preserving a bottom main-agent failure. It emits no global `(+N items)` or `(+N lines)` marker and falls back to a complete empty ANSI fence only when even protected content cannot fit.

## How it works

The plugin listens to OpenClaw runtime events and maps them to one active Discord status message per Discord conversation.

1. **`message_received`** resolves the Discord context, captures inbound channel/message routing metadata, and may establish the initial activity generation for the conversation.
2. **Awaited `before_agent_reply`** admits each main run before Skill Harness and tool events. It binds an admitted run to an unbound initial generation, or creates exactly one fresh successor generation for a queued followup/collect run when no second `message_received` occurs.
   Admission is non-terminal and always returns `{ handled: false }`.
3. **`before_tool_call`** adds a pending tool entry. If the Discord session is not known yet, the tool call is stored as an orphan.
4. **`after_tool_call`** marks the matching entry completed, errored, or orphan-reconciled, preserves or derives completed duration data, and updates the status message.
5. **`message_sending`** finalizes visible status before the final user-facing reply is sent.
6. **`before_compaction` / `after_compaction`** preserve the active status across context compaction, show the compaction as pending/completed with duration, cancel attempt-level cleanup, and suspend the idle timer until the compacted run resumes.
7. **`llm_input`** observes only a complete `<active_memory_plugin>` prompt block, never logs the full assembled prompt, and upgrades the Active Memory fastpath from inferred to observed. Memory text is retained only for canonical Discord direct-message sessions.
8. **Main `agent_end`** records and displays the concrete main-agent error, owns main-session finalization and schedules cleanup, and captures final `active-memory` output and failure details from its internal session.
9. **`plugin:skill-harness` pipeline events** feed `skill-harness` status. The plugin intentionally ignores legacy `skill-harness` `agent_end` result rendering.

Session and race-safety behavior:

- Each session serializes Discord create/edit/delete operations through `pendingOp`.
- The awaited `before_agent_reply` admission is idempotent for a run already bound to the current generation, so repeated admission does not create another generation or status message.
- In the plugin's tested lifecycle, queued `followup`/`collect` runs can create one successor generation without another `message_received`; this describes the plugin behavior covered by tests, not a universal upstream guarantee.
- A replacement preserves the newest known channel, account, sender, owner, and user-message routing metadata, installs the fresh generation before retiring the old one, and keeps direct-reply references intact.
- Generation, owner, and superseded-run fencing on tool, agent, and `skill-harness` producer events preserves the current replacement state: OpenClaw `runId` provenance, `generation`, `ownerSessionKey`, `finalized`, and current-session checks prevent a superseded run from mutating it before or after an awaited Discord request.
- The renderer returns content plus a per-block display state. Confirmed Discord creates/edits advance confirmed state; exhausted network or final `5xx` outcomes advance a conservative safety floor without pretending delivery was confirmed; explicit rejection leaves both unchanged. Rendering always starts from the more degraded state, so ambiguous delivery cannot cause a later visual resurrection.
- Status creates use Discord `nonce` with `enforce_nonce`. An uncertain create preserves and reuses the same nonce across later high-level retries until Discord returns a usable message ID or the session is reset. Because a nonce replay can return the earlier message after history has changed, the plugin immediately PATCHes the current rendered content before marking that retry confirmed. An uncertain PATCH disables the unchanged-content shortcut until a later PATCH is confirmed.
- Finalized sessions do not create duplicate status messages from late tool events.
- Direct-message sessions can resolve a Discord DM channel before sending.
- Codex/OpenClaw-prefixed tool names such as `openclawskill_view` display immediately as canonical names such as `skill_view`.
- Discord deletes treat `404` as already deleted. Retryable `429`, `5xx`, and network failures use the normal bounded API retry policy, then schedule one detached recovery attempt after 5 seconds. Missing tokens and `401`/`403` failures do not schedule delayed retries.
- Detached delete recovery captures the original channel, message, account, and session identifiers, so it cannot delete or mutate a replacement session's status message.

## Architecture

The repository is a small TypeScript plugin with focused runtime modules and colocated tests. The main runtime hotspot is `src/hooks.ts`; keep new behavior in smaller helpers when possible instead of growing hook orchestration unnecessarily.

| Path                                | Responsibility                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugin.ts`                     | Plugin assembly: config resolution, token resolver, companion-plugin enablement checks, shared runtime state, and hook registration.          |
| `src/hooks.ts`                      | OpenClaw hook orchestration: session routing, tool lifecycle updates, subagent placeholders/results, orphan reconciliation, and finalization. |
| `src/session.ts`                    | Discord status lifecycle: serialized send/edit/delete, confirmed display state, uncertain-delivery safety floor, create nonce, and cleanup.   |
| `src/store.ts`                      | Active session and Discord context tracking.                                                                                                  |
| `src/orphans.ts`                    | Temporary storage and lookup helpers for tool calls that arrive before a Discord session is available.                                        |
| `src/parser.ts`                     | Session-key parsing, Discord context extraction, sender/channel ID extraction, and final subagent result extraction.                          |
| `src/render.ts`                     | Pure state-aware rendering from tool history to bounded, monotonic semantic ANSI status content.                                              |
| `src/formatting.ts`                 | Icons, display-field formatting, and local Unicode-safe value truncation.                                                                     |
| `src/tool-name.ts`                  | Shared OpenClaw/Codex tool-name canonicalization for hook dedupe and first-render display.                                                    |
| `src/skill-harness-status.ts`       | Skill-harness pipeline parsing, visible-field filtering, child duration calculation, and duplicate phase merging.                             |
| `src/discord-api.ts`                | Discord REST calls, mutation outcome classification, idempotent create nonce, bounded retries, and DM channel resolution.                     |
| `src/discord-message-operations.ts` | Token-gated send/edit/delete outcomes around the Discord API layer, compatibility wrappers, and DM fallback.                                  |
| `src/tool-history-manager.ts`       | Tool-history add/update/replace/trim helpers and subagent group operations.                                                                   |
| `src/config.ts`                     | Zod-backed plugin config parsing and defaults.                                                                                                |
| `src/types.ts`                      | Shared event, session, store, and tool-entry types.                                                                                           |
| `api.ts`, `index.ts`, `token.ts`    | Plugin SDK bridge, exported plugin entrypoint, and Discord token resolution.                                                                  |

## Installation

Install the published plugin from [ClawHub](https://clawhub.ai/wei840222/plugins/discord-activity):

```bash
openclaw plugins install clawhub:discord-activity
```

For local development, install the plugin package wherever your OpenClaw deployment loads local plugins, then install dependencies and build the extension:

```bash
pnpm install
pnpm run build
```

Enable the plugin in your OpenClaw plugin configuration:

```json
{
  "plugins": {
    "entries": {
      "discord-activity": {
        "enabled": true,
        "config": {
          "maxToolHistoryLength": 30,
          "maxDisplaySeconds": 180,
          "replyMode": "all"
        }
      }
    }
  }
}
```

The plugin manifest activates on startup for the `discord` channel:

```json
{
  "activation": {
    "onStartup": true,
    "onChannels": ["discord"]
  }
}
```

Discord bot credentials are resolved through OpenClaw account/secret configuration by the plugin SDK. Keep Discord credentials in the OpenClaw Discord channel/account configuration or secret store; do not hard-code credentials in this plugin.

This release targets OpenClaw/plugin SDK `2026.6.11`, declares `2026.6.11` as the minimum gateway version, and loads `openclaw/plugin-sdk/plugin-entry` plus `openclaw/plugin-sdk/runtime-env` directly. The integration suite verifies those entrypoints and version declarations together.

## Configuration

| Property                 | Type     | Default | Description                                                                                                                                                  |
| ------------------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxToolHistoryLength`   | `number` | `30`    | Maximum number of tool entries retained in memory before trimming.                                                                                           |
| `maxStatusMessageLength` | `number` | `1700`  | Maximum rendered status length; allowed range is 100–1700.                                                                                                   |
| `maxDisplaySeconds`      | `number` | `180`   | Maximum idle time after status activity before force cleanup.                                                                                                |
| `orphanTtlSeconds`       | `number` | `300`   | Time to keep orphaned tool calls while waiting for a session link.                                                                                           |
| `replyMode`              | `string` | `all`   | `all` replies wherever a source message exists; `direct` replies only in canonical private-message sessions, while channel/group statuses remain standalone. |

Runtime display limits are stricter than `maxToolHistoryLength`: the renderer keeps up to 6 outer blocks shared by internal groups, normal tools, and a protected bottom main-agent failure, plus up to 3 children independently inside each `active-memory` and `skill-harness` group.

## Companion workflows

Discord Activity is useful beside plugins that run longer tool workflows from Discord. For example, if public X/Twitter automation is handled by TweetClaw, install and configure TweetClaw separately while using Discord Activity for progress visibility.

Visible external actions such as posting tweets, sending replies, or direct messages should still use OpenClaw's normal approval flow. This plugin only reports progress; it does not grant approval or bypass safety controls.

## Development guide

Use `pnpm` for all local commands.

```bash
pnpm run format      # Prettier for Markdown, JSON, and TypeScript
pnpm run typecheck   # TypeScript, no emit
pnpm run test        # Full Vitest suite
pnpm run build       # Clean and compile runtime files to dist/
```

Before handing off code changes, run at least:

```bash
pnpm run format
pnpm run typecheck
pnpm run test
```

Run `pnpm run build` when changing plugin registration, package metadata, SDK imports, emitted behavior, release artifacts, or anything that depends on `dist/` output. The build uses `tsconfig.build.json` so publish output stays runtime-only.

Testing map:

- Config parsing/defaults: `src/config.test.ts`.
- Rendering behavior: `src/render.test.ts`.
- Session message lifecycle, pending operation serialization, cleanup, and DM fallback: `src/session.test.ts`.
- Store ownership/current-session behavior: `src/store.test.ts`.
- Orphan tool behavior: `src/orphans.test.ts`.
- Hook-level routing and lifecycle behavior: `src/hooks.test.ts`.
- Plugin registration and manifest-facing behavior: `src/plugin.test.ts` and `src/plugin.integration.test.ts`.
- Tool-history helper behavior: `src/tool-history-manager.test.ts`.

Package hygiene note: this package publishes `dist/`. `pnpm run build` cleans `dist/` and compiles through `tsconfig.build.json`, which includes runtime entries while excluding tests and root tooling. If you change build or release behavior, verify with `pnpm run build` and `pnpm pack --dry-run`; the tarball should not contain outputs such as `dist/vitest.config.*` or `dist/test-helpers.*`.

## Security and performance

- Discord tokens are resolved through OpenClaw configuration/secret handling.
- Discord API failures are logged and skipped so agent replies are not blocked.
- Discord REST calls retry rate limits, transient server errors, and network errors.
- Per-session message operations are serialized to avoid create/edit/delete races.
- Finalized status messages are deleted after cleanup. Active status messages are force-cleaned only after `maxDisplaySeconds` without further status activity.

---

_🌸 Powered by Ani, Wan Jiun Wei © 2026_
