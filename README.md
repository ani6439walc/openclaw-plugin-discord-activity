# Discord Tool Status Plugin for OpenClaw

[![OpenClaw](https://img.shields.io/badge/Platform-OpenClaw-blue.svg)](https://github.com/openclaw/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Discord Tool Status is an OpenClaw plugin that shows live agent/tool activity in Discord. For each Discord conversation, it creates one ANSI-colored status message, edits that message as tools run, folds in internal `active-memory` and `skill-harness` status, then removes the status message after the agent finishes.

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

Status messages are Discord ANSI code blocks. Internal subagent groups appear first, followed by a main-agent failure when present, then normal tools:

```ansi
🧩 active-memory ✔ [120ms]
   ├─ memory_search ✔ [120ms]
   │   └─ query: project notes
   └─ result: Relevant memory found

💡 skill-harness ✔
   └─ intent ✔
       ├─ reason: User asked for a review
       └─ confidence: 0.92

🔎 web_search ✔ [450ms]
   └─ query: OpenClaw plugin SDK
```

Status markers:

- `←` pending or currently visible as the latest non-final completed entry.
- `✔` completed.
- `✘` errored.
- `♻︎` orphan-reconciled after the tool result arrived before the Discord session was known.

Rendering rules to preserve:

- Normal tools render after `active-memory` and `skill-harness` groups.
- `active-memory` and `skill-harness` group order is stable.
- Each top-level tree connector starts under the first text character after the header emoji and separating space; nested connectors preserve that alignment.
- A failed main agent renders as `🤖 agent ✘` after internal groups and before normal tools. It is an additional protected block outside the shared 6-entry tool/group budget. The concrete error appears beneath it when OpenClaw provides one; missing error text is not invented.
- `skill-harness` JSON object results flatten to key-value fields.
- `skill-harness` plain text results render as `result: <text>`.
- Failed `skill-harness` phases render their concrete `error` beneath the failed phase exactly once. During rolling upgrades, legacy failed-event `reason` and `result` fields are normalized to the same phase-local error.
- `active-memory` result text renders as `result: <text>`.
- Failed `active-memory` child tools keep their own phase-local errors and durations. A distinct parent failure is also shown; identical parent/child error text is rendered once.
- Tool-provided durations take precedence. When a completion omits `durationMs`, elapsed time falls back to the first observed `before_tool_call`; duplicate terminal events preserve that value instead of recalculating it.
- Durations up to and including 1000ms render in milliseconds. Durations above 1000ms and under 10 seconds render with two decimal places; durations of 10 seconds or more render with one decimal place.
- Status output keeps up to 3 child entries independently inside each of the `active-memory` and `skill-harness` groups. At the outer level, each complete internal group counts as one entry alongside each normal tool in a shared 6-entry budget. With both internal groups visible, the fifth normal tool rolls out the entire `active-memory` group and the sixth rolls out the entire `skill-harness` group; retained `toolHistory` is unchanged.
- Parameter, result, and error values report exact omitted Unicode code-point counts as `(+N chars)` (`char` when singular) without splitting surrogate pairs. Single-line values keep up to 70 code points. Multiline values keep up to five lines and 70 code points per retained line.
- Compact metadata rows pack booleans, finite numbers of up to 12 code points, and explicitly allowlisted short enum strings. String eligibility is scoped by tool or `skill-harness` phase; matching field names from unrelated tools remain on separate rows.
- Overlong status messages remove complete semantic detail nodes instead of slicing rendered lines. Ordinary parameters roll out before results, errors, nested tool headers, and top-level status headers; equal-priority details roll out oldest first. Compact scalar rows and multiline values remain atomic, and tree connectors are recomputed after removal.
- Bounded output includes ANSI and omission-marker overhead in every length check, ends with a complete ANSI fence, emits the exact number of omitted nonblank rendered lines as a gray `(+N lines)` marker (`line` when singular), sanitizes untrusted visible text, and never mutates retained `toolHistory` merely to fit the display.

## How it works

The plugin listens to OpenClaw runtime events and maps them to one active Discord status message per Discord conversation.

1. **`message_received`** resolves the Discord context, records channel/message metadata, and starts or replaces the active session for the conversation.
2. **`before_tool_call`** adds a pending tool entry. If the Discord session is not known yet, the tool call is stored as an orphan.
3. **`after_tool_call`** marks the matching entry completed, errored, or orphan-reconciled, preserves or derives completed duration data, and updates the status message.
4. **`before_agent_reply` / `message_sending`** finalize visible status before the final user-facing reply is sent.
5. **`agent_end`** records main-agent failure state, handles main-session cleanup, and captures final `active-memory` output and failure details from its internal session.
6. **`plugin:skill-harness` pipeline events** feed `skill-harness` status. The plugin intentionally ignores legacy `skill-harness` `agent_end` result rendering.

Session and race-safety behavior:

- Each session serializes Discord create/edit/delete operations through `pendingOp`.
- `generation`, `ownerSessionKey`, `finalized`, and current-session checks prevent stale events from editing a replacement session.
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
| `src/session.ts`                    | Discord status message lifecycle: send, edit, retire, delete, pending operation serialization, cleanup timers, and max-display handling.      |
| `src/store.ts`                      | Active session and Discord context tracking.                                                                                                  |
| `src/orphans.ts`                    | Temporary storage and lookup helpers for tool calls that arrive before a Discord session is available.                                        |
| `src/parser.ts`                     | Session-key parsing, Discord context extraction, sender/channel ID extraction, and final subagent result extraction.                          |
| `src/render.ts`                     | Pure rendering from tool history to bounded semantic ANSI status content.                                                                     |
| `src/formatting.ts`                 | Icons, display-field formatting, and local Unicode-safe value truncation.                                                                     |
| `src/tool-name.ts`                  | Shared OpenClaw/Codex tool-name canonicalization for hook dedupe and first-render display.                                                    |
| `src/skill-harness-status.ts`       | Skill-harness pipeline parsing, visible-field filtering, child duration calculation, and duplicate phase merging.                             |
| `src/discord-api.ts`                | Discord REST calls, rate-limit retry, server-error retry, network-error retry, and DM channel resolution.                                     |
| `src/discord-message-operations.ts` | Token-gated send/edit/delete functions around the Discord API layer, including DM fallback.                                                   |
| `src/tool-history-manager.ts`       | Tool-history add/update/replace/trim helpers and subagent group operations.                                                                   |
| `src/config.ts`                     | Zod-backed plugin config parsing and defaults.                                                                                                |
| `src/types.ts`                      | Shared event, session, store, and tool-entry types.                                                                                           |
| `api.ts`, `index.ts`, `token.ts`    | Plugin SDK bridge, exported plugin entrypoint, and Discord token resolution.                                                                  |

## Installation

Install the plugin package wherever your OpenClaw deployment loads local plugins, then install dependencies and build the extension:

```bash
pnpm install
pnpm run build
```

Enable the plugin in your OpenClaw plugin configuration:

```json
{
  "plugins": {
    "entries": {
      "discord-tool-status": {
        "enabled": true,
        "config": {
          "maxToolHistoryLength": 30,
          "maxDisplayMs": 600000
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

| Property                 | Type     | Default  | Description                                                        |
| ------------------------ | -------- | -------- | ------------------------------------------------------------------ |
| `maxToolHistoryLength`   | `number` | `30`     | Maximum number of tool entries retained in memory before trimming. |
| `maxStatusMessageLength` | `number` | `1700`   | Maximum rendered status length; allowed range is 100–1700.         |
| `maxDisplayMs`           | `number` | `600000` | Maximum time a status message may remain before force cleanup.     |
| `orphanTtlMs`            | `number` | `300000` | Time to keep orphaned tool calls while waiting for a session link. |

Runtime display limits are stricter than `maxToolHistoryLength`: the renderer keeps up to 6 outer tool/group entries, plus a protected main-agent failure when present, and up to 3 children independently inside each `active-memory` and `skill-harness` group.

## Companion workflows

Discord Tool Status is useful beside plugins that run longer tool workflows from Discord. For example, if public X/Twitter automation is handled by TweetClaw, install and configure TweetClaw separately while using Discord Tool Status for progress visibility.

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
- Finalized status messages are deleted after cleanup and force-cleaned after `maxDisplayMs`.

---

Powered by Ani, Wan Jiun Wei © 2026
