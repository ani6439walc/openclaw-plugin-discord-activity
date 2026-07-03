# Discord Tool Status Plugin for OpenClaw

[![OpenClaw](https://img.shields.io/badge/Platform-OpenClaw-blue.svg)](https://github.com/openclaw/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Discord Tool Status is an OpenClaw plugin that makes agent activity visible in Discord. It creates one live YAML-formatted status message per Discord conversation, updates it as tools run, folds in internal `active-memory` and `intention-hint` subagent status, then deletes the message after the agent finishes.

![Discord Tool Status Example](example.png)

## 🚀 Key Features

- **Live Tool Monitoring**: Tracks `before_tool_call` and `after_tool_call` events as pending (`←`), completed (`✔`), errored (`✘`), or orphan-reconciled (`♻︎`) entries.
- **YAML Status Rendering**: Renders compact Discord code blocks with semantic icons, tool parameters, durations, and error details.
- **Subagent Visibility**: Shows `active-memory` and `intention-hint` as stable top-level groups, including final assistant result text when those internal sessions finish.
- **Session Lifecycle Management**: Creates one status message per Discord context, edits it in place, avoids duplicate edits when content is unchanged, and schedules cleanup after finalization.
- **Discord API Resilience**: Retries Discord `429` rate limits, transient `5xx` responses, and network errors with backoff.
- **Context-Aware Routing**: Maps OpenClaw session keys to Discord channels, DMs, and conversations, including DM channel resolution and owner-session replacement.
- **Orphan Tool Reconciliation**: Temporarily stores tool calls that arrive before a Discord session is known, then attaches them when the matching session appears.

## 🛠 Installation

Install the plugin package where OpenClaw loads local plugins, then build it before enabling the extension entry:

```bash
pnpm install
pnpm run build
```

Enable the extension in your `openclaw.plugin.json` or main configuration:

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

The plugin activates on startup for the `discord` channel. Discord bot credentials are resolved from OpenClaw's account/secret configuration through the plugin SDK.

## 🧪 Commands

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run format
```

## ⚙️ Configuration

The plugin can be customized via the `config` object in your OpenClaw settings:

| Property                 | Type     | Default  | Description                                                                           |
| :----------------------- | :------- | :------- | :------------------------------------------------------------------------------------ |
| `maxToolHistoryLength`   | `number` | `30`     | Maximum number of tool calls to keep in history.                                      |
| `maxStatusMessageLength` | `number` | `1700`   | Character limit for the Discord message content.                                      |
| `maxDisplayMs`           | `number` | `600000` | Force-delete the status message after this duration (ms) to prevent stale indicators. |
| `orphanTtlMs`            | `number` | `300000` | Time to keep orphaned tool calls in memory while waiting for a session link.          |

## 🖼 Status Format

Status messages are rendered as YAML code blocks. Normal tools appear after internal subagent groups:

```yaml
🧩 active-memory: ✔
   - memory_search: ✔ (120ms)
     - query: project notes
   - result: Relevant memory found

💡 intention-hint: ✔
   - intent: code-review
     reason: User asked for a review
     confidence: 0.92

🔍 web_search: ✔ (450ms)
   - query: OpenClaw plugin SDK
```

`intention-hint` JSON object results are flattened into key-value fields. Plain text results are labeled as `result:` so they do not appear as unlabeled list items.

The status display keeps up to 6 normal tool entries, up to 6 `active-memory` child entries, and up to 6 `intention-hint` child entries independently. Subagent `result` entries are rendered after other child entries.

## Companion X/Twitter workflows

Discord Tool Status makes long-running OpenClaw tool calls visible in Discord. If those calls include public X/Twitter automation, install [TweetClaw](https://github.com/Xquik-dev/tweetclaw) beside it:

```bash
openclaw plugins install @xquik/tweetclaw
```

Use Discord Tool Status to show live progress for TweetClaw tool calls such as search tweets, search tweet replies, follower export, user lookup, media upload/download, monitor tweets, webhooks, and giveaway draws. For visible actions such as post tweets, post tweet replies, and direct messages, keep the status message visible while OpenClaw collects approval. Keep Discord credentials in this plugin's config or OpenClaw secret store; keep TweetClaw/Xquik credentials in TweetClaw's plugin config or host environment.

## 🏗 Architecture

The plugin is organized around a thin entrypoint and focused runtime modules:

- `src/plugin.ts`: resolves plugin config, token resolution, companion plugin enablement checks, and hook registration.
- `src/hooks.ts`: owns OpenClaw hook behavior, session routing, tool lifecycle updates, subagent placeholders, and finalization.
- `src/session.ts`: sends, edits, retires, and deletes Discord status messages while serializing pending message operations per session.
- `src/store.ts`: tracks active sessions and Discord context metadata.
- `src/orphans.ts`: holds tool calls that arrive before a session can be resolved.
- `src/parser.ts`: extracts Discord context keys, source session keys, and final subagent result entries.
- `src/render.ts` and `src/formatting.ts`: render tool history into YAML-friendly Discord content.
- `src/discord-api.ts`: wraps Discord REST calls with retry and rate-limit handling.

Runtime flow:

1. **`message_received`**: Initializes the session context and maps the Discord channel/message metadata.
2. **`before_tool_call`**: Adds a pending tool entry or stores an orphan when no Discord session is available yet.
3. **`after_tool_call`**: Marks the entry completed, errored, or orphan-reconciled, then updates the status message.
4. **`before_agent_reply` / `message_sending`**: Finalizes visible status before the user-facing reply is sent.
5. **`agent_end`**: Captures `active-memory` and `intention-hint` final results, finalizes the parent Discord status, and schedules cleanup.

## 🔒 Security & Performance

- **Token Protection**: Resolves Discord credentials securely through the OpenClaw secret management system.
- **Minimal Overhead**: Uses a non-blocking, asynchronous architecture to ensure that status updates do not increase agent latency.
- **Per-Session Serialization**: Chains pending Discord message operations to avoid racing create/edit/delete calls for the same status message.
- **Rate Limit Awareness**: Honors Discord `retry-after` values and retries transient failures before giving up.
- **Automatic Cleanup**: Deletes finalized status messages after the configured delay and force-cleans stale messages after `maxDisplayMs`.

---

_🌸 Powered by Ani, Wan Jiun Wei © 2026_
