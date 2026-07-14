# AccordAgents

AccordAgents is an open-source macOS app for coordinating AI agents in one shared project workspace. It supports local CLI participants backed by Antigravity, Claude Code, and Codex.

Instead of copy-pasting context between separate terminals or chats, you keep roles, rules, history, approvals, and decisions in one project workspace.

> Status: pre-1.0 (`0.5.x`). Interfaces and on-disk formats may still change.

## Why

Use the right agent for the task without rebuilding context every time.

AccordAgents lets multiple agents work from the same project, compare perspectives, and hand work off while you choose how much control they get: approve once, allow repeated requests, or use auto mode for trusted workflows.

## What You Can Do

- Create reusable agent roles and participants
- Mention agents directly in task-focused project chats
- Run multiple agents from the same context
- Compare multiple agent perspectives
- Control permissions, tool use, and handoffs
- Keep decisions and implementation history in one place

## Requirements

- Node.js 20+
- npm
- macOS (primary development target; the signed release pipeline is macOS arm64)
- At least one supported CLI (`agy`, `claude`, or `codex`) installed and authenticated; first-run setup guides you when none is ready

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

- **Local CLI agents** (`agy`, `claude`, `codex`) are checked through a refreshed login-shell environment plus AccordAgents' filtered manual agent environment. Detection, runnable state, and authentication are reported separately; multiple ready providers remain an equal, neutral choice until you select one. They run in a
  permission-scoped sandbox of the selected repository: read-only by default, with
  file/shell/web access controlled per participant through approval cards, saved
  allow rules, or auto mode for trusted workflows.
- See `docs/chat-roles-and-participants.md` for chat roles and participant
  configuration.

## Data and privacy

- Conversations are stored locally in `accordagents.sqlite3` under Electron's
  `userData` directory.
- Redacted diagnostic logs may be written to
  `userData/debug-logs/<date>.jsonl` when running unpackaged. Force on/off with
  `ACCORD_AGENTS_DEBUG_LOGS=1` / `=0`.
- Saved conversations contain your prompts, diffs, and model responses. Diagnostic
  logs omit raw CLI readiness output, account fields, executable paths, and environment
  values, but should still be treated as sensitive and never committed.

## Releases

Signed macOS arm64 builds are published to a **separate** public release
repository (`juliakrivchikova/AccordAgents-Releases`); the source repository
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

Open source. Licensed under the [Apache License 2.0](LICENSE).
