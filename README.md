# AccordAgents

AccordAgents is an Electron desktop app for **multi-participant AI chat**. Several
AI participants (HTTP providers and local CLI agents) discuss a question or a code
diff, debate individual points, and converge on a consensus answer. It supports
free-form chat, code review, implementation-plan, and general-question
conversations.

> Status: pre-1.0 (`0.1.x`). Interfaces and on-disk formats may still change.

## Features

- **Multiple participants in one conversation** — mix hosted models (OpenAI,
  Anthropic, Gemini) and local CLI agents (`codex`, `claude`).
- **Debate-to-consensus** — participants raise findings, an arbiter merges them,
  and disagreements are resolved point by point.
- **Conversation kinds** — `chat`, `code-review`, `implementation-plan`, and
  `general`.
- **Local-first storage** — conversations live in a local SQLite database under
  the OS app-data directory. Nothing is sent anywhere except to the AI providers
  you explicitly configure.

## Requirements

- Node.js 20+
- npm
- macOS or Linux (primary development targets; the signed release pipeline is
  macOS arm64)
- Optional: the `codex` and/or `claude` CLIs on your `PATH` if you want to use
  local CLI participants
- Optional: API keys for any HTTP providers you want to use (OpenAI, Anthropic,
  Gemini)

## Install

```bash
git clone https://github.com/juliakrivchikova/AccordAgents-desktop-app.git
cd AccordAgents-desktop-app
npm install
```

## Run

The Makefile wraps the npm scripts:

```bash
make dev      # Vite dev server + Electron with live reload
make build    # Compile main process, then build the renderer
make start    # Build, then run Electron from dist
make typecheck
make clean
```

`make dev` is the normal development loop.

## Configuration

- **API keys** are entered in the app's Settings. They are encrypted at rest with
  Electron `safeStorage` and never leave your machine except in requests to the
  provider you configured. Only a `hasApiKey` boolean is exposed to the renderer.
- **Local CLI agents** (`codex`, `claude`) are detected via `which`. They run in a
  permission-scoped sandbox of the selected repository: read-only by default, with
  file/shell/web access granted only through explicit per-participant approval.
- See `docs/chat-roles-and-participants.md` for chat roles and participant
  configuration.

## Data and privacy

- Conversations are stored locally in `accordagents.sqlite3` under Electron's
  `userData` directory.
- Debug logs (raw provider/CLI output) may be written to
  `userData/debug-logs/<date>.jsonl` when running unpackaged. Force on/off with
  `ACCORD_AGENTS_DEBUG_LOGS=1` / `=0`.
- Saved conversations and debug logs contain your prompts, diffs, and raw model
  responses. Treat them as sensitive and do not commit them.

## Releases

Signed macOS arm64 builds are published to a **separate** public release
repository (`juliakrivchikova/accordagents-releases`); the source repository
never hosts release artifacts. The app auto-updates via
`update.electronjs.org`. See `SIGN.md` for the signing, notarization, and release
process.

## Development

See [`CLAUDE.md`](CLAUDE.md) for architecture (main/preload/renderer/shared
layout, the `src/shared/types.ts` IPC contract, service layout) and conventions.

Before submitting changes:

```bash
make typecheck
make build               # for renderer changes
npm run test:permissions # for chat permissions / cancellation / repo-file mentions
npm run test:app-skills  # for app-skill service changes
```

## Contributing

Issues and pull requests are welcome. Please run `make typecheck` (and the
relevant tests above) before opening a PR. By contributing you agree your
contributions are licensed under the project's Apache-2.0 license.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report vulnerabilities.

## License

Licensed under the [Apache License 2.0](LICENSE).
