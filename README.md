# AccordAgents

AccordAgents is an open-source macOS app that runs your CLI coding agents as one
team. Claude Code, Codex CLI, and Antigravity CLI (Gemini) work in one project
chat with shared context, reusable roles, per-member permissions, approval
cards, and a history that carries across sessions and providers.

Instead of copy-pasting context between separate terminals, you mention the
agent you want, let members ask each other for help, approve what needs
approval, and keep decisions, artifacts, and implementation history in one
place.

> Releases ship on a stable channel and a beta channel (Settings → General →
> **Beta updates**) for macOS on Apple Silicon. Interfaces and on-disk formats
> may still change between versions.

## Why

Use the right agent for the task without rebuilding context every time.

AccordAgents lets multiple agents work from the same project, compare
perspectives, and hand work off while you choose how much control they get:
approve once, grant it for the rest of the chat, or use Auto-run for trusted
workflows. A member running on a cloud machine gets the same controls and the
same feedback as a member running on your Mac.

## What you can do

- **Chat with several agents in one project.** `@` mentions a member, `#`
  mentions a repository file or an artifact, `/` opens commands, saved
  prompts, skills, and plugins. Replies open threads; members can ask each other for help through
  member requests, ask you to pick an option with a choice card, post mid-turn
  updates, and react. Paste or attach pictures.
- **Reuse roles and members.** Roles are instruction templates (built-in ones
  include Chat Assistant, Software Engineer, Product Strategist, Arbiter,
  Synthesizer, and Workflow Manager); behavior rules and saved prompts are
  reusable snippets; member presets bind a handle to a role, a CLI, a model,
  reasoning effort, an avatar, and permissions.
- **Control what an agent may do.** Agent modes are Custom access, Plan only,
  and Auto-run. In Custom access you toggle repo read, file editing, web
  access, and shell access per member; anything outside the grant arrives as an
  approval card you can allow once or for the whole chat (Codex's own command
  approvals stay inside that Codex session), and shell rules you save are
  reused.
- **Reach other model vendors through the same CLIs.** Settings → General →
  **Add provider** binds a CLI to a vendor endpoint with your own API key:
  Claude Code reaches Anthropic API, Moonshot Kimi, MiniMax, or DeepSeek; Codex
  reaches OpenAI API; either reaches Z.ai GLM or a custom endpoint. Members on
  an added provider run on this computer only.
- **Keep the outcome, not just the transcript.** Artifacts are chat-scoped
  documents with versions, drafts, diffs, and signatures. *Start an Accord*
  from the composer runs a facilitated agreement: independent drafts, one
  synthesized document, every selected member signs.
- **Run longer work.** `/goal` keeps a member going until an objective is
  finished, `/compact` compacts a member's context, a member can watch new
  chat activity, and every run has a Stop.
- **Run a member in the cloud.** Connect your own AWS account and the app
  provisions an EC2 machine; set a Claude Code or Codex member's *Run on* to
  *Cloud run · AWS* and it works there with the same controls, approvals, and
  Stop as a local member (while the machine is unreachable, Stop shows as
  waiting until the machine confirms). One instance can be shared by several
  of your computers. A cloud member hands over code as a branch and a pull
  request, never by writing into your working tree.
- **Follow along from your phone.** Pair the phone app at
  <https://mobile.accordagents.com/> with a QR code, then read chats with live
  progress, send messages, mentions, and pictures, answer approval and choice
  cards, stop a run, or wake a stopped cloud machine.
- **Find things again.** Chat search covers chat titles and messages. Chats are
  kept across restarts, and a run cut off by a restart is marked in the chat.

## Requirements

- macOS on Apple Silicon for the packaged app (release builds are macOS arm64).
- At least one supported CLI installed and signed in: Claude Code (`claude`),
  Codex CLI (`codex`), or Antigravity CLI (`agy`); a member bound to an added
  provider needs only its API key. First-run setup shows the
  install and login commands for each; it copies them only when you choose
  Copy and never installs software or signs in for you.
- `git` for repository features and the `sqlite3` command-line tool for
  storage (`sqlite3` is preinstalled on macOS; `git` comes with the Xcode
  Command Line Tools).
- Optional: an AWS account for Cloud run; a phone with a modern browser for
  the phone app.

To run from source you also need Node.js 20+ and npm.

## Install

Download the latest DMG from the
[releases repository](https://github.com/juliakrivchikova/AccordAgents-Releases/releases/latest).
The app checks for updates through `update.electronjs.org` and asks before
restarting once no member is running; turn on Settings → General → **Beta updates** to follow the beta
channel instead.

## Run from source

```bash
git clone https://github.com/juliakrivchikova/AccordAgents-desktop-app.git
cd AccordAgents-desktop-app
npm install
make dev
```

The Makefile wraps the npm scripts:

```bash
make dev        # Vite dev server + Electron with live reload
make build      # Main process, renderer, phone app shell, and machine runtime bundle
make start      # Build, then run Electron from dist
make typecheck  # Strict TypeScript checks for main and renderer
make clean      # Remove dist, out, and signed
```

`make dev` is the normal development loop.

## Configuration

- **Local CLI setup** (Settings → General) reports detection, whether the CLI
  runs, and sign-in state separately for each CLI; several ready CLIs stay an
  equal choice until you pick one, and new chats start with a built-in
  Assistant on the default CLI you choose here. Members start read-only in the
  selected repository, with file editing, shell, and web access granted per
  member through approval cards, saved rules, or Auto-run. Codex runs under its
  OS sandbox and Claude Code under its native permission modes; Antigravity has
  no OS-enforced sandbox, so its read-only mode is best effort.
- **Add provider** (Settings → General) adds a vendor endpoint reached through
  Claude Code or Codex. API keys are stored encrypted, never shown to the UI again, and passed
  only to the CLI process that uses them.
- **AWS** (Settings → General) connects your AWS account: run one setup command
  in Terminal with an AWS administrator account (or send it to your
  administrator), paste its result, pick a region, then start, stop, resize, and
  delete the cloud machine from the same panel. AWS bills the instance while it
  runs; stop it from Settings when you are done. Choose Cloud run in a member's
  settings to finish the setup for that member; the choice is locked after the
  member's first run.
- **Device Pairing** (Settings → General) generates the QR code for the phone
  app and revokes a paired phone. A pairing covers the whole app, not a single
  chat.
- **Environment** holds the variables your agents run with; they travel to a
  cloud machine together with your settings.
- Roles, rules, prompts, plugins & skills, and members each have their own
  Settings section. See `docs/chat-roles-and-participants.md` before changing
  role presets or member behavior, and `docs/parity-requirements.md` for the
  two rules every feature must satisfy: a cloud member behaves exactly like a
  local one, and a local member behaves exactly like its dedicated CLI.

## Data and privacy

- Everything is stored locally under Electron's `userData` directory:
  `accordagents.sqlite3` (chats, messages, artifacts, search index),
  `settings.json` (added-provider API keys, AWS credentials, and environment
  values, encrypted with Electron `safeStorage` when the OS keychain is
  available), `chats/<conversation-id>/` (pictures you attached),
  `avatars/`, and paired-phone records.
- Prompts, diffs, and repository content go to the provider behind each CLI,
  exactly as they do when you use that CLI directly.
- Cloud run mirrors the selected project and a snapshot of your settings
  (including environment values you configured) to your own machine, and every
  message between the desktop, a machine, and the phone is sealed end to end.
  The relay at `relay.accordagents.com` (source in `cloudflare/relay/`) stores
  message bodies only as ciphertext, keeps routing metadata (chat id, event
  kind, sender id, timestamps) in the clear, and drops events after 72 hours by
  default; phone push notifications carry no content.
- Diagnostic logs (progress events and raw CLI output) are written to
  `userData/debug-logs/<date>.jsonl` when running unpackaged; force them on or
  off with `ACCORD_AGENTS_DEBUG_LOGS=1` / `=0`. The CLI readiness probe logs
  omit account fields, executable paths, and environment values, but treat the
  logs and saved chats as sensitive and never commit them.

## Releases

Signed and notarized macOS arm64 builds are published to separate public
release repositories:
[`AccordAgents-Releases`](https://github.com/juliakrivchikova/AccordAgents-Releases)
for the stable channel and
[`AccordAgents-Beta-Releases`](https://github.com/juliakrivchikova/AccordAgents-Beta-Releases)
for betas. The source repository never hosts release artifacts. Windows x64
packaging and publishing scripts exist, but no Windows build is published yet.
See `SIGN.md` for signing, notarization, and the release process, and
`docs/deploying-the-phone-app.md` for the phone app, which is deployed
separately from the desktop app.

## Development

See [`CLAUDE.md`](CLAUDE.md) for the architecture (main/preload/renderer/shared
layout, the `src/shared/types.ts` IPC contract, the service layout, chat
concurrency rules) and conventions, `docs/machines/03-machine-runtime.md` for the cloud
machine runtime, and `docs/inspecting-the-desktop-app.md` for driving the running app
through the Chrome DevTools Protocol.

Before submitting changes:

```bash
make typecheck
make build                   # for renderer changes
npm run test:permissions     # chat permissions, cancellation, repo-file mentions, CLI behavior
npm run test:app-skills      # bundled app skills
npm run test:artifacts       # artifacts
npm run test:machines        # machine runtime and relay link
npm run test:mobile-control  # phone pairing, relay control, push
```

`npm run | grep test:` lists every focused suite. Known open defects are
listed in `docs/parity-requirements.md` (the parity register) and
[`KNOWN_ISSUES.md`](KNOWN_ISSUES.md).

## Contributing

Issues and pull requests are welcome. Please run `make typecheck` (and the
relevant tests above) before opening a PR. By contributing you agree your
contributions are licensed under the project's Apache-2.0 license.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report vulnerabilities.

## License

Open source. Licensed under the [Apache License 2.0](LICENSE).
