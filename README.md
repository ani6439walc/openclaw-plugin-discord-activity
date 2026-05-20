# Discord Tool Status Extension for OpenClaw

[![OpenClaw](https://img.shields.io/badge/Platform-OpenClaw-blue.svg)](https://github.com/openclaw/openclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Discord Tool Status is a high-performance extension for the OpenClaw platform that provides real-time, visual feedback of an AI agent's tool execution flow directly within Discord. It streamlines the monitoring process by displaying a dynamic status message that tracks active tool calls, parameters, and execution outcomes.

![Discord Tool Status Example](example.png)

## 🚀 Key Features

- **Live Execution Monitoring**: Instantly updates Discord status messages when an agent initiates or completes a tool call (e.g., `web_search`, `read_file`, `shell_execute`).
- **Sophisticated Rendering**: Utilizes a clean, YAML-formatted code block for maximum readability, complete with semantic iconography for different tool categories.
- **Intelligent Lifecycle Management**: Automatically handles message creation, incremental updates, and final cleanup (deletion) once the agent concludes its task or prepares a final response.
- **Active Memory Integration**: Specialized handling for internal "active-memory" processes, providing a transparent view of the agent's cognitive overhead without cluttering the main interaction.
- **Robust API Resilience**: Built-in exponential backoff and retry logic specifically tuned for Discord's global rate limits and transient network issues.
- **Context-Aware Routing**: Precise session tracking across diverse Discord contexts, including public channels, private threads, and direct messages (DMs).

## 🛠 Installation

As a system-level extension, ensure the package is located in your OpenClaw extensions directory (typically `~/.openclaw/extensions/discord-tool-status`).

Enable the extension in your `openclaw.plugin.json` or main configuration:

```json
{
  "plugins": {
    "entries": {
      "discord-tool-status": {
        "enabled": true,
        "config": {
          "maxToolHistoryLength": 10,
          "maxDisplayMs": 600000
        }
      }
    }
  }
}
```

## ⚙️ Configuration

The extension can be customized via the `config` object in your OpenClaw settings:

| Property                 | Type     | Default  | Description                                                                           |
| :----------------------- | :------- | :------- | :------------------------------------------------------------------------------------ |
| `maxToolHistoryLength`   | `number` | `10`     | Maximum number of tool calls to display in the status message.                        |
| `maxStatusMessageLength` | `number` | `1700`   | Character limit for the Discord message (Discord's limit is 2000).                    |
| `maxDisplayMs`           | `number` | `600000` | Force-delete the status message after this duration (ms) to prevent stale indicators. |
| `orphanTtlMs`            | `number` | `300000` | Time to keep "orphaned" tool calls in memory while waiting for a session link.        |

## Companion X/Twitter workflows

Discord Tool Status makes long-running OpenClaw tool calls visible in Discord. If those calls include public X/Twitter automation, install [TweetClaw](https://github.com/Xquik-dev/tweetclaw) beside it:

```bash
openclaw plugins install @xquik/tweetclaw
```

Use Discord Tool Status to show live progress for TweetClaw tool calls such as search tweets, search tweet replies, follower export, user lookup, media upload/download, monitor tweets, webhooks, and giveaway draws. For visible actions such as post tweets, post tweet replies, and direct messages, keep the status message visible while OpenClaw collects approval. Keep Discord credentials in this extension's config or OpenClaw secret store; keep TweetClaw/Xquik credentials in TweetClaw's plugin config or host environment.

## 🏗 Architecture

The extension operates by subscribing to the OpenClaw plugin hook system:

1.  **`message_received`**: Initializes the session context and maps the Discord channel/message metadata.
2.  **`before_tool_call`**: Triggers the creation or update of the status message with a "pending" (←) state.
3.  **`after_tool_call`**: Updates the entry with success (✔) or error (✘) indicators and execution duration.
4.  **`agent_end` / `message_sending`**: Finalizes the status view and schedules a secure deletion of the message to keep the conversation clean.

## 🔒 Security & Performance

- **Token Protection**: Resolves Discord credentials securely through the OpenClaw secret management system.
- **Minimal Overhead**: Uses a non-blocking, asynchronous architecture to ensure that status updates do not increase agent latency.
- **Rate Limit Awareness**: Implements a centralized request queue per session to prevent race conditions and minimize Discord API "429 Too Many Requests" errors.

---

_🌸　Powered by Ａni | [OpenClaw Plugin] © 2026_
