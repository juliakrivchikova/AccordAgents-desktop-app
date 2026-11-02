# AccordAgents

AccordAgents is an open-source desktop app for macOS and Windows that runs your
CLI coding agents as one team. Claude Code, Codex CLI, and Antigravity CLI
(Gemini) work in one project chat with shared context, reusable roles,
per-member permissions, approval cards, and a history that carries across
sessions and providers.

Instead of copy-pasting context between separate terminals, you mention the
agent you want, let members ask each other for help, approve what needs
approval, and keep decisions, artifacts, and implementation history in one
place.

> Releases ship on a stable channel and a beta channel (Settings → General →
> **Beta updates**) for macOS on Apple Silicon; stable releases also ship for
> Windows x64. Interfaces and on-disk formats may still change between versions.

## Why

Use the right agent for the task without rebuilding context every time.

AccordAgents lets multiple agents work from the same project, compare
perspectives, and hand work off while you choose how much control they get:
approve once, grant it for the rest of the chat, or use Auto-run for trusted
workflows. A member running on a cloud machine gets the same controls and the
same feedback as a member running on your computer.

## What you can do

- **Chat with several agents in one project.** `@` mentions a member, `#`
  mentions a repository file or an artifact, `/` opens commands, saved
  prompts, skills, and plugins. Replies open threads; members can ask each
  other for help through member requests without waiting on each other, ask
  you to pick an option with a choice card, post mid-turn updates, and react.
  Paste or attach pictures. A choice card you leave unanswered expires an hour
  after the member asked it, once you have gone on with that member; it stays
  in the chat marked Expired.
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
- **Work with files and a terminal next to the chat.** File links in the chat
  can open in the side panel: Markdown, CSV, and HTML with a preview and their
  source, PDFs and pictures, and any other text or code in an editor; text
  files inside the project save as you type. `` Ctrl+` `` opens a terminal
  panel under the chat; each new tab starts in the project of the chat it is
  opened from (PowerShell on Windows), and the tabs stay as you switch chats.
- **Run longer work.** `/goal` keeps a member going until an objective is
  finished, `/compact` compacts a member's context, a member can watch new
  chat activity, and every run has a Stop. A Claude Code member's background
  tasks show in the members list while they run. **Activity** lists running,
  pending, and finished work across chats, and opening a running member takes
  you to its turn in progress.
- **Automate checks on a schedule.** Ask a member to watch something for you:
  it writes a small node or bash script (node scripts need Node.js on the
  computer that runs them) and you approve it on a card. The
  script runs on a fixed interval or at cron times in your time zone, on this
  computer or on the member's cloud machine, and posts into the chat to wake
  members only when it finds work. Settings → **Scripts** switches scripts on
  and off, runs them now, and shows their history.
- **Run a member in the cloud.** After setting up your server (see
  Configuration), connect your own AWS account in Settings → **AWS** and the
  app creates an EC2 instance; set a Claude Code or Codex
  member's *Run on* to *Cloud run · AWS* and it works there with the same
  controls, approvals, and Stop as a local member (while the machine is
  unreachable, Stop shows as waiting until the machine confirms). Antigravity
  members run on this computer only. A cloud member hands over code as a
  branch and a pull request, never by writing into your working tree.
- **Work from your phone.** Once your server is set up, pair the phone app at
  <https://mobile.accordagents.com/> with a QR code, then read chats with live
  progress, start a new chat with a project and members, send messages,
  mentions, and pictures, answer approval and choice cards, stop a run, and
  wake a stopped cloud machine. Message alerts name the chat and say whether a
  new message or an approval is waiting, never who wrote it or what it says;
  a chat's title is by default the start of its first message. Chats and
  cloud members keep working from
  the phone while your computer is off; local members start once it is back.
- **Find things again.** Chat search covers chat titles and messages. Chats are
  kept across restarts, and a run cut off by a restart is marked in the chat.

## Requirements

- macOS on Apple Silicon, or Windows x64 (stable releases only).
- At least one supported CLI installed and signed in: Claude Code (`claude`),
  Codex CLI (`codex`), or Antigravity CLI (`agy`); a member bound to an added
  provider needs only its API key. First-run setup shows the install and login
  commands for each on macOS and links to the official guide on Windows; it
  copies a command only when you choose Copy and never installs software or
  signs in for you.
- `git` for repository features. On macOS it comes with the Xcode Command
  Line Tools; on Windows install Git for Windows so that `git` is on `PATH`.
- The `sqlite3` command-line tool for storage: preinstalled on macOS, bundled
  with the app on Windows.
- Optional: an AWS account for your server, the phone app, and Cloud run.
  Their setup commands need the AWS CLI, run in Terminal with an AWS
  administrator account.

To run from source you also need Node.js 20+ and npm.

## Install

Download the latest DMG from the
[releases repository](https://github.com/juliakrivchikova/AccordAgents-Releases/releases/latest).
The app checks for updates through `update.electronjs.org` and asks before
restarting once no member is running; turn on Settings → General → **Beta
updates** to follow the beta channel instead.

On Windows, download `AccordAgents-<version>-win32-x64-Setup.exe` from the same
release and run it; it installs for the current user and updates the same way.
Windows gets stable releases only, so its Settings have no **Beta updates**.
The installer is code-signed; while the certificate is new, SmartScreen may
still ask first: choose **More info**, then **Run anyway**. A Windows copy
installed before Windows releases existed cannot update itself; install the
current version over it once.

Updating from 1.11.1 or earlier: the old shared relay is gone, so a phone
paired or a cloud machine connected through it is removed at the first start
of the new version. Set up your server, then pair the phone again and check
Settings → AWS.

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
make build      # Main process, renderer, phone app, machine runtime, and server bundles
make start      # Build, then run Electron from dist
make typecheck  # Strict TypeScript checks for main and renderer
make clean      # Remove dist, out, and signed
```

`make dev` is the normal development loop. On Windows without `make`, run
the npm scripts directly: `npm run dev`, `npm run build`, `npm start`,
`npm run typecheck`.

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
  Claude Code or Codex. API keys are stored encrypted, never shown to the UI
  again, and passed only to the CLI process that uses them.
- **Your server** (Settings → General) creates a small Lightsail server in your
  AWS account (about $5 a month) from one setup command. The phone app and
  cloud machines work through it, so set it up first. A server belongs to the
  computer that set it up; running its setup from another computer offers to
  start it over for that one.
- **Device Pairing** (Settings → General) generates the QR code for the phone
  app and revokes a paired phone. You confirm the pairing on the phone; it
  covers the whole app, not a single chat.
- **AWS** (Settings → AWS) connects your AWS account: pick a region, run the
  setup command it shows in Terminal with an AWS administrator account (or send
  it to your administrator), and paste its result. The app creates the
  instance and walks through its setup: tools for the agents, Codex and Claude
  Code sign-ins, and the cloud program, which the app updates to its own
  version after each app update, once no agent is working. The same page starts and stops the instance, changes its
  type, deletes it, adds and deletes project copies on it, and cleans up or
  grows its disk. AWS bills the instance while it runs; **Automatic stop**
  stops it after three hours without working agents, unless a scheduled script
  keeps it on. Choose Cloud run in a member's settings to finish the setup for
  that member; the choice is locked after the member's first run.
- **Environment** holds the variables your agents run with; they travel to a
  cloud machine together with your settings.
- Scripts, roles, rules, prompts, plugins & skills, and members each have their
  own Settings section. See `docs/chat-roles-and-participants.md` before
  changing role presets or member behavior, and `docs/parity-requirements.md`
  for the two rules every feature must satisfy: a cloud member behaves exactly
  like a local one, and a local member behaves exactly like its dedicated CLI.

## Data and privacy

- On your computer, data is stored under Electron's `userData` directory:
  `accordagents.sqlite3` (chats, messages, artifacts, search index),
  `settings.json` (added-provider API keys, AWS credentials, and environment
  values, encrypted with Electron `safeStorage` when the OS keychain is
  available), `chats/<conversation-id>/` (pictures you attached),
  `avatars/`, `scripts/` (scheduled scripts and their history),
  `script-secrets.json` (script keys, encrypted), and paired-phone records.
- Prompts, diffs, and repository content go to the provider behind each CLI,
  exactly as they do when you use that CLI directly.
- Your server lives in your own AWS account. The desktop, your machines, and
  your phone reach each other only through it. It keeps the text of your chats
  and their search, pictures attached to messages sent since 1.11.4,
  artifacts, waiting cards, your members' live progress, and the list of your
  projects (with their folder paths) and members that the phone's New chat
  offers. It records every change as an event signed by the device that made
  it and forgets what every device has read after a grace period. Phone pushes
  carry nothing; the phone then reads the chat's title from your server to
  show the alert. Without that server
  there is no phone control and no cloud machine; local members work as
  before.
- Cloud run mirrors the selected project and a snapshot of your settings
  (including environment values you configured) to your own instance.
- Crash and usage reports are on by default, also when running from source:
  the desktop app sends error reports and an anonymous count of active
  installs to Sentry. Before sending, it masks file paths, links, email
  addresses, and anything that looks like a secret or token, and cuts error
  text to 300 characters; no screenshots, local variables, console output, or
  crash dumps are sent. Turn them off in Settings → General → **Crash and
  usage reports** (turning them back on applies at the next start), or start
  the app with `ACCORDAGENTS_CRASH_REPORTS=0`. The phone app sends no crash
  reports.
- Diagnostic logs (progress events and raw CLI output) are written to
  `userData/debug-logs/<date>.jsonl` when running unpackaged; force them on or
  off with `ACCORD_AGENTS_DEBUG_LOGS=1` / `=0`. The CLI readiness probe logs
  omit account fields, executable paths, and environment values, but treat the
  logs and saved chats as sensitive and never commit them.

## Releases

The GitHub Actions `Release` workflow, started by hand, builds, signs,
notarizes, and publishes the macOS arm64 builds to separate public release
repositories:
[`AccordAgents-Releases`](https://github.com/juliakrivchikova/AccordAgents-Releases)
for the stable channel and
[`AccordAgents-Beta-Releases`](https://github.com/juliakrivchikova/AccordAgents-Beta-Releases)
for betas. Releases are never published to the source repository. Each stable
release also gets a code-signed Windows x64 installer and its Squirrel update
files, built by GitHub Actions and signed on a Windows PC. Each beta and stable
release also deploys the phone app from the released commit (a stable release
skips it when beta has phone app changes it lacks); between releases it is
deployed by hand. See `SIGN.md` for signing, notarization, and the release
process, and `docs/deploying-the-phone-app.md` for the phone app.

## Development

See [`CLAUDE.md`](CLAUDE.md) for the architecture (main/preload/renderer/shared
layout, the `src/shared/types.ts` IPC contract, the service layout, chat
concurrency rules) and conventions, `docs/machines/03-machine-runtime.md` for
the cloud machine runtime, and `docs/inspecting-the-desktop-app.md` for driving
the running app through the Chrome DevTools Protocol.

Before submitting changes:

```bash
make typecheck
make build                   # for renderer changes
npm run test:permissions     # chat permissions, cancellation, repo-file mentions, CLI behavior
npm run test:app-skills      # bundled app skills
npm run test:artifacts       # artifacts
npm run test:scripts         # scheduled scripts and their schedules
npm run test:terminal        # terminal panel
npm run test:hub             # your server: chats, cards, and documents kept through it
npm run test:machines        # machine runtime and its link through your server
npm run test:mobile-control  # phone control cards, pairing settings, push
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
