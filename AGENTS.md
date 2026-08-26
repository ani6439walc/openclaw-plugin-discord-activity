# Repository Guidelines

## Project Structure & Module Organization

This repository contains a TypeScript OpenClaw plugin that reports live tool activity in Discord. Runtime code lives in `src/`; tests are colocated as `src/*.test.ts`. Keep plugin assembly in `src/plugin.ts`, hook orchestration in `src/hooks.ts`, Discord message lifecycle in `src/session.ts`, REST behavior in `src/discord-api.ts`, and pure ANSI rendering in `src/render.ts`. Root entrypoints (`api.ts`, `index.ts`, and `token.ts`) bridge the OpenClaw SDK. User-facing configuration is declared in `openclaw.plugin.json`; `example.png` documents the rendered Discord status.

For targeted discovery, prefer CodeGraph prompts such as:

```bash
codegraph explore "plugin lifecycle hooks rendering discord status"
codegraph explore "<target symbol or behavior> affected tests"
```

Load detailed source only as needed.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile` installs the pinned dependency graph.
- `pnpm run typecheck` runs strict TypeScript checks without emitting files.
- `pnpm run test` runs the complete Vitest suite.
- `pnpm run format` formats Markdown, JSON, and TypeScript with Prettier.
- `pnpm run build` cleans and compiles runtime files into `dist/`.
- `pnpm pack --dry-run` verifies the published package contents.

Run format, typecheck, and tests before handoff. Also run build and package checks for runtime, manifest, SDK, or release changes.

## Coding Style & Naming Conventions

Use Prettier defaults with two-space indentation. Keep TypeScript strict, prefer `unknown` plus narrowing over `any`, and use ESM imports with `.js` suffixes for local modules. Name functions and variables in `camelCase`, types in `PascalCase`, constants in `UPPER_SNAKE_CASE`, and files with descriptive kebab-case names. Keep rendering pure and Discord API calls out of hooks and renderers.

## Testing Guidelines

Tests use Vitest and follow `*.test.ts`. Add focused regression coverage beside the affected module; there is no numeric coverage threshold. Assert observable behavior, including failure and race-sensitive paths. Never delete or weaken tests to obtain a passing build.

## Commit & Pull Request Guidelines

Follow the repository’s summary-only conventional style, for example `fix: preserve direct reply routing` or `docs: clarify package checks`. Keep commits narrowly scoped. Pull requests should explain behavior, verification commands, and related issues; include screenshots only for visible Discord output changes. Confirm CI passes on supported Node versions before merging.

## Security & Configuration

Never commit Discord tokens or OpenClaw secrets. Keep public defaults synchronized across `src/config.ts`, `openclaw.plugin.json`, and `README.md`. Discord failures must remain fail-open so status reporting never blocks the agent reply.
