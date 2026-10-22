# Discord Activity Plugin for OpenClaw

[![OpenClaw](https://img.shields.io/badge/Platform-OpenClaw-blue.svg)](https://clawhub.ai/wei840222/plugins/discord-activity)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Discord Activity is an OpenClaw plugin that shows live agent and tool activity in Discord. For each Discord conversation, it creates one ANSI-colored status message, edits that message as tools run, folds in internal `skill-harness` and Hindsight recall status, then removes the status message after the agent finishes.

## Why this exists

When an OpenClaw agent is working from Discord, long-running tool calls can otherwise look like silence. This plugin gives users and operators a lightweight progress view without changing the final assistant reply.

It helps answer:

- Is the agent currently using tools?
- Which tool or internal pipeline phase is running?
- Did a tool complete, fail, or get reconciled after arriving before a Discord session existed?
- How long did completed tools take?
- Are internal companion workflows such as `skill-harness` and Hindsight still running?

The plugin is designed to fail open: if Discord credentials are missing or Discord API calls fail, it logs the problem and skips status updates instead of blocking the agent flow.

## What it shows

Status messages are Discord ANSI code blocks. The latest non-empty `progress_card` is pinned first, internal subagent groups follow, normal tools come next, and a main-agent failure appears last when present.

### Example display

Colored tool field labels use a single space before the green value, without a
separator colon. Colons inside field names and values are preserved. Plain context
rows and internal workflow details retain their own formatting.

A simplified live status message looks like this:

```ansi
💡 skill-harness ▾ ✔ [450ms]
    ⊹ 2 skills selected: handoff, hindsight-docs (.92)

🔍 web_search ▾ ✔ [450ms]
    ╰─ query OpenClaw plugin SDK
```

`decision_evaluate` uses a dedicated `⚖️` display with the same cyan header,
magenta result labels, green result values, and yellow timing as ordinary tools. It
shows each question's `instructions` (or its ID when omitted) and the input
criteria descriptions alongside the returned probabilities:

```text
⚖️ decision_evaluate ▾ ✔ [952ms]
    ≡ context: Reviewing an incoming support request.
    ≡ detail: {"channel":"support","message":"Checkout is unavailable"}
    » Should this message receive a reply?
    ├─ true Direct question or mention → 82.0%
    ╰─ false No reply needed → 18.0%
    » Which department should handle this? → support
    ├─ support Technical issues → 80.0%
    ╰─ billing Payments and refunds → 20.0%
    » How urgent is this? → score 1.70 / 2
    ├─ 0 Normal operation → 10.0%
    ├─ 1 Partial disruption → 10.0%
    ╰─ 2 Service unavailable → 80.0%
```

Boolean false probability is calculated as `1 - probabilityTrue`. Choice
alternatives and score criteria retain input order. Scores display the provider's
score rounded to two decimal places against `criteria.length - 1`; probabilities
remain a separate distribution. Missing/null/blank descriptions show
`未提供描述`; object and array instructions/descriptions display as JSON.
While running, results show `等待結果…`. Missing or invalid results show
`結果未提供`, and unavailable outcomes show their reason without probabilities.
Shared `state` appears above the questions as flat `≡ field: value` rows in input
order, without a state container. A JSON object string is parsed once and rendered
like object state, with each top-level field trimmed independently. Invalid JSON,
JSON arrays and JSON primitives keep their original string display; nested strings
are not parsed again. These rows use Discord's default text color,
matching skill-harness details; omission hints are light gray. Newlines and adjacent indentation
inside string values, including nested objects and arrays, become one space
before JSON serialization. Each combined `field: value` uses the ordinary-tool
70-code-point limit, including the field name, colon and space, with the same
`... (+N chars)` omission hint. The indent, `≡` marker and omission suffix are
outside this limit; long field names are truncated too. String or array state appears directly
after `≡`; absent/null/blank state and empty fields are omitted, while zero and
false field values remain visible.

Question headings use a yellow `»` and yellow instructions (or question ID),
while selected choices, scores and answer rows keep their result colors.
State markers, question markers and answer tree connectors all use four-space
indentation. Narrow Discord windows can still wrap lines.

The display omits model, provenance and token usage. Sanitization, result parsing
and monotonic message bounding rules are unchanged. Other tools
keep their existing display.

Status markers:

- `▾` details are expanded.
- `▸` details were collapsed to fit the message.
- `←` pending or currently visible as the latest non-final completed entry.
- `✔` completed.
- `✘` errored.
- `♻︎` orphan-reconciled after the tool result arrived before the Discord session was known.

Rendering rules to preserve:

- The latest `progress_card` tool call is rendered as one protected `📋 progress` block above every activity entry instead of appearing as an ordinary tool. Its Markdown note is flattened into a plain-text summary on a separate non-bold blue line below the bold cyan tool-style header, with formatting markers, links, raw HTML, and line breaks removed; a leading `<progress aria-label="…">` contributes a compact label when no plan exists, and every valid plan step remains ordered with `✓` completed, `→` in progress, or `·` pending. A later empty card clears the block. Under the hard message limit, ordinary blocks are collapsed/removed before the progress note is compacted; plan steps remain visible whenever the protected content can fit.
- Normal tools render after `skill-harness` and Hindsight groups.
- `skill-harness` and Hindsight group order is stable.
- Each top-level tree connector starts under the second text character after the header emoji and separating space. Nested connectors and multiline continuation text likewise start under the second text character of their parent text.
- `skill-harness`, Hindsight, and the main-agent failure share one style that reads apart from ordinary tools. Their headers are bold blue, like `📋 progress`, while tool headers are bold cyan. Their detail lines use no tree connectors: each starts with `⊹` at the same indent in Discord's default text color, and error lines use the same mark and alignment with both the mark and text in red. Detail fields with no visible text after sanitizing (for example only control or escape codes) are omitted. Current `skill-harness` and Hindsight producer events retain distinct errors as flat red `⊹ message ✘` rows, followed by only the latest progress or success message. Each new progress/result replaces that bottom row; without errors there is just one row. Hindsight uses accepted event order, including completions of earlier recalls. A group that recovers (`♻︎`) uses this same flat layout for legacy child entries too. The header's `←` / `✔` / `✘` already states progress, so `status`, `result`, and `error` values are shown without their key; any other field keeps `key: value`, and fields on one row stay joined with `·`. Truncation hints stay gray. Legacy child-only input can still render phase details before recovery; current producers do not create nested phases. Multiline values continue under the text after the mark.
- A failed main agent renders once as `💥 agent ✘` at the bottom, with its error as a red line below it. It occupies one slot in the shared 6-entry budget and is protected from normal block removal.
- `skill-harness` keeps one current message from the fixed `status` / `result` fields and a separate error history. During pipeline execution the bottom message shows phase status and confidence (`(.xx)`); on completion it shows selected skills with confidence.
- The `skill-harness` status follows its explicit lifecycle: it remains `←` while running, including after a phase fails, and changes to `✔` on `pipeline:completed`, or `♻︎` if errors were retained. A phase failure preserves the last progress message and candidate metadata so later phases can continue. `pipeline:failed` or unobserved completion renders `✘` with error text.
- Tool-provided durations take precedence. When a completion omits `durationMs`, elapsed time falls back to the first observed `before_tool_call`; duplicate terminal events preserve that value instead of recalculating it.
- The `skill-harness` group duration comes directly from the producer's terminal parent lifecycle event. Individual phase durations still fall back to locally observed start/completion timing when the event does not provide `durationMs`.
- Durations up to and including 1000ms render in milliseconds. Durations above 1000ms and under 10 seconds round to at most two decimal places; durations of 10 seconds or more round to at most one decimal place. Trailing fractional zeros and a leftover decimal point are omitted.
- Status output keeps up to 3 child entries independently inside each of the `skill-harness` and Hindsight groups. Internal groups, normal tools, and a main-agent failure share one 6-entry outer budget; the failure uses the last slot when present. Older eligible blocks are removed from the top without mutating retained `toolHistory`.
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
7. **Main `agent_end`** records and displays the concrete main-agent error, owns main-session finalization, and schedules cleanup.
8. **`plugin:skill-harness` pipeline events** feed `skill-harness` status. No Skill Harness enablement configuration is read and no placeholder is created before an event arrives. Background `skill-harness-review` tool hooks are ignored so they cannot enter the user activity history or orphan cache. Legacy `:skill-harness:` sessions are no longer supported or specially filtered.

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

### Hindsight automatic recall

The [Hindsight integration fork](https://github.com/ani6439walc/openclaw-plugin-hindsight-memory)
uses plugin ID `hindsight-memory` and emits `plugin:hindsight-memory` events with
kind `hindsight-memory.recall` before the model receives its prompt. Each recall
is correlated by `recallId`; Discord Activity subscribes with ID
`discord-activity:hindsight-memory-pipeline`.
Discord Activity subscribes automatically; no extra Discord Activity configuration
is needed. The official Hindsight OpenClaw v0.13.0 does not emit these events.
Install the fork in place of the official integration as described in its README.

A `hindsight-memory` row shows progress while the integration prepares its client
and retrieves memories, then displays the number of memories injected (or an
explicit empty result), elapsed time, timeout, cancellation, or failure. The
duration includes client initialization. Queries, bank IDs, recalled text, and
raw error messages are never copied from these events into Discord.

```text
🧠 hindsight-memory ▾ ←
    ⊹ recalling memories

🧠 hindsight-memory ▾ ✔ [1.24s]
    ⊹ 3 memories recalled
```

Each recall invocation has its own ID, including concurrent invocations that
share an upstream request. Duplicate or late start events cannot reset a terminal
status. Events from old runs, internal subagent sessions, and finalized turns are
ignored. If the turn ends without a terminal recall event, the row explicitly
reports `recall outcome unavailable` instead of implying success. Prechecks that
skip automatic recall produce no row. Older hosts without the optional agent
event API continue to support the existing tool activity display.

### Learned-skill notice

After a background skill review changes a learned skill, OpenClaw sends
`💾 Learned: ... Say "undo" to revert this skill change.` to the conversation.
On Discord, a separate `message_sending` handler replaces that whole notice with
a message written by `api.runtime.llm.complete`. The plugin has no message
template: the model receives the original notice and, for created and updated
skills, a diff of each skill, and writes the whole message. The built-in system
prompt is language-neutral; it requires a leading emoji, every skill name in
backticks followed directly by its description (no colon after the name), what
happened to each skill, what the assistant will now do differently, and a hint
that the change can be undone. It asks for exactly one version of the message and
includes one example. Set the language with `skillLearnedNotice.promptAppend`,
for example:

```json
"skillLearnedNotice": {
  "model": "bifrost/gpt-6-luna",
  "promptAppend": "Write the message in Traditional Chinese as used in Taiwan."
}
```

The diff comes from the live skill under `<agentDir>/workshop-skills/<name>/`
and the archived version the change most likely started from. The notice carries
no version id, so the baseline is the newest archived version, extended back
through versions written within ten minutes of each other, and ignored when the
newest is more than an hour old. Without a session agent or a baseline, the model
still rewrites the notice from its original text alone.

Skill files are read only inside the workshop tree. The real agent directory plus
a `workshop-skills` entry that is not a link is the one trusted anchor; every
path component from there down to the skill or archive version must be a real
directory and is resolved from that anchor, never from a re-canonicalized child,
files are opened without following symlinks, and each open file is checked
through `/proc/self/fd` to still lie inside its skill directory; hard links are
refused. Any violation drops that skill's diff, and the notice is rewritten from
its original text alone. Without `/proc` (non-Linux hosts), diffs are never sent.

A reply that repeats the same message several times is cut to its first copy.
If the model call fails, or its reply is empty, longer than 1500 characters, or
missing any skill name, the original notice is sent unchanged.

The message is never cancelled, and undo still works because OpenClaw queues its
own undo instruction separately. Other text, including replies that only quote the
prefix, is unchanged. Control UI sessions never send this notice through
`message_sending`, so they keep the original sentence. The handler's budget is 60
seconds; override it with `plugins.entries.discord-activity.hooks.timeouts.message_sending`.
Skill contents and message text are not logged.

## Architecture

The repository is a small TypeScript plugin with focused runtime modules and colocated tests. The main runtime hotspot is `src/hooks.ts`; keep new behavior in smaller helpers when possible instead of growing hook orchestration unnecessarily.

| Path                                | Responsibility                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugin.ts`                     | Plugin assembly: config resolution, token resolver, shared runtime state, and hook registration.                                            |
| `src/hooks.ts`                      | OpenClaw hook orchestration: session routing, tool lifecycle updates, pipeline status updates, orphan reconciliation, and finalization.     |
| `src/session.ts`                    | Discord status lifecycle: serialized send/edit/delete, confirmed display state, uncertain-delivery safety floor, create nonce, and cleanup. |
| `src/store.ts`                      | Active session and Discord context tracking.                                                                                                |
| `src/orphans.ts`                    | Temporary storage and lookup helpers for tool calls that arrive before a Discord session is available.                                      |
| `src/parser.ts`                     | Session-key parsing, Discord context extraction, sender/channel ID extraction, and final subagent result extraction.                        |
| `src/render.ts`                     | Pure state-aware rendering from tool history to bounded, monotonic semantic ANSI status content.                                            |
| `src/formatting.ts`                 | Icons, display-field formatting, and local Unicode-safe value truncation.                                                                   |
| `src/tool-name.ts`                  | Shared OpenClaw/Codex tool-name canonicalization for hook dedupe and first-render display.                                                  |
| `src/skill-harness-status.ts`       | Skill-harness pipeline single-row status tracking, confidence formatting, and turn finalization.                                            |
| `src/discord-api.ts`                | Discord REST calls, mutation outcome classification, idempotent create nonce, bounded retries, and DM channel resolution.                   |
| `src/discord-message-operations.ts` | Token-gated send/edit/delete outcomes around the Discord API layer, and DM fallback.                                                        |
| `src/tool-history-manager.ts`       | Tool-history add/update/replace/trim helpers and subagent group operations.                                                                 |
| `src/learned-notice*.ts`            | Learned-skill notice parsing, workshop skill diff, and LLM rewrite handler.                                                                 |
| `src/config.ts`                     | Zod-backed plugin config parsing and defaults.                                                                                              |
| `src/types.ts`                      | Shared event, session, store, and tool-entry types.                                                                                         |
| `api.ts`, `index.ts`, `token.ts`    | Plugin SDK bridge, exported plugin entrypoint, and Discord token resolution.                                                                |

## Installation

The pinned OpenClaw 2026.10.3 requires Node.js `>=24.16.0 <25 || >=26.1.0`.
CI validates Node.js 24 and 26.

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

This release targets OpenClaw/plugin SDK `2026.10.3`, declares `2026.10.3` as the minimum gateway version, and loads `openclaw/plugin-sdk/plugin-entry` plus `openclaw/plugin-sdk/runtime-env` directly. The integration suite verifies those entrypoints and version declarations together.

## Configuration

| Property                          | Type     | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxToolHistoryLength`            | `number` | `30`    | Maximum number of tool entries retained in memory before trimming.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `maxStatusMessageLength`          | `number` | `1700`  | Maximum rendered status length; allowed range is 100–1700.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `maxDisplaySeconds`               | `number` | `180`   | Maximum idle time after status activity before force cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `orphanTtlSeconds`                | `number` | `300`   | Time to keep orphaned tool calls while waiting for a session link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `replyMode`                       | `string` | `all`   | `all` replies wherever a source message exists; `direct` replies only in canonical private-message sessions, while channel/group statuses remain standalone.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `skillLearnedNotice.model`        | `string` | unset   | Model ref that writes the learned-skill notice, for example `bifrost/gpt-6-luna`. Unset falls back to the agent's explicit `utilityModel` (`agents.entries.<id>.utilityModel`, then `agents.defaults.utilityModel`); an empty or unset utility model leaves the choice to the host, which uses its default model (the ambient owner agent's, not necessarily the notice agent's own). Any resolved model, including a utility fallback, requires `plugins.entries.discord-activity.llm.allowModelOverride: true` and, when present, an `llm.allowedModels` entry for that ref. |
| `skillLearnedNotice.thinking`     | `string` | unset   | Requested thinking level for the notice rewrite: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, or `ultra`. Unset sends none, so the host and model decide. It is a request: the host and provider may map or clamp it to what the selected model supports (for example down to `off`) without an error or warning, so an unsupported level is not rejected. Only an actual completion failure logs a `learned notice:` warning with its error code and sends the original notice.                                                                     |
| `skillLearnedNotice.promptAppend` | `string` | unset   | Extra instructions appended to the notice system prompt. The built-in prompt sets the format but no language, so use this for the language.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Runtime display limits are stricter than `maxToolHistoryLength`: the renderer keeps up to 6 outer blocks shared by internal groups, normal tools, and a protected bottom main-agent failure, plus up to 3 children independently inside each `skill-harness` and Hindsight group.

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
