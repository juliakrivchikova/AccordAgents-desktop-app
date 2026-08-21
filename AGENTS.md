# Repository Guidelines

> **Read `docs/parity-requirements.md` first. It is the most important document in this project.**
> It states the two parity requirements every decision here must satisfy, and it is the only place an exception to them may exist — approved personally by the User, never by an engineer, a review, or an accord. Anything in this file or elsewhere that conflicts with it is wrong.

## NON-NEGOTIABLE PRODUCT INVARIANTS: PARITY

**1. WORKING WITH ONE SPECIFIC PARTICIPANT IN ACCORDAGENTS CHAT MUST FEEL LIKE WORKING WITH THAT AGENT THROUGH ITS REGULAR, DEDICATED CLI.**

**2. FOR THE USER THERE MUST BE NO DIFFERENCE BETWEEN A PARTICIPANT THAT RUNS LOCALLY AND ONE THAT RUNS IN THE CLOUD.** Same controls, same feedback, same capabilities, same consequences for the same action. Transport, provisioning, and authentication may differ; what the user does, sees, and gets must not.

Both are stated by the User. An unapproved divergence from either is a defect, not a design decision — record it in `docs/parity-requirements.md` or bring it to the User for approval as an exception.

Before every product, architecture, implementation, UI, and commit decision, explicitly check that this invariant still holds. AccordAgents must mirror the current CLI behavior at the time a feature is implemented, including output rendering and streaming, permissions and approvals, sandboxing, model selection, sessions and resume behavior, compaction, goals, skills and rules, MCPs and tools, cancellation, errors, warnings, and user controls. The user should not need to learn different single-agent behavior merely because the agent is running inside AccordAgents.

Treat the dedicated CLI as the source of truth. Do not invent app-specific semantics for a single participant when the CLI already defines them. If multi-participant coordination inherently requires a difference, keep the divergence as narrow as possible, make it visible to the user, document why it exists, and add verification for both the parity path and the divergence. CLI behavior can evolve; verify the current behavior when implementing or revisiting a feature rather than relying on an old assumption. Any unexplained mismatch is a product correctness bug.

**Approved exception — code delivery from the cloud.** A participant running in the cloud hands over code changes the way a remote colleague does: it pushes a branch and opens a GitHub pull request. It does not write into the user's working tree, and there is deliberately no automatic write-back from the worker mirror. Credentials for that come from the user's Settings environment variables, which apply to cloud participants exactly as they do to local ones. Recorded in `docs/parity-requirements.md`.

**AccordAgents does not manage git worktrees.** The app never creates, moves, or deletes a worktree — not locally, not on a cloud worker, not per participant, not per run. When a task needs isolation, the User asks the participant for it and the participant creates the worktree itself with ordinary git commands, exactly as it would in its dedicated CLI. Do not propose or build app-managed worktrees; do not let any app operation destroy a participant-created worktree or its uncommitted changes. Recorded in `docs/parity-requirements.md`.

## Project Structure & Module Organization

This is an Electron desktop app built with TypeScript, React, and Vite. Main-process code lives in `src/main`, with service classes under `src/main/services`. The preload bridge is in `src/preload`, shared types and utilities are in `src/shared`, and the React renderer is in `src/renderer`. Renderer assets belong in `src/renderer/assets`. The app-wide style entrypoint is `src/renderer/styles/app.css`, which imports foundation/theme files and view-specific CSS under `src/renderer/styles/views`. Build output goes to `dist`; do not edit generated files by hand.

For chat role presets, saved participants, and runtime participant sessions, read `docs/chat-roles-and-participants.md` before changing role or participant behavior.

For chat concurrency and cancellation changes, treat `src/main/services/chat.ts`, `src/shared/chatRunState.ts`, chat storage summaries, and the renderer chat UI as one contract. Active chat runs are tracked with `metadata.activeRunIds`; `metadata.running` and `metadata.runId` are compatibility fields. Chat conversation mutations from concurrent runs must go through the `ChatService` mutation queue rather than direct stale snapshots.

## Build, Test, and Development Commands

Prefer the Makefile aliases when working locally:

- `make install`: install Node dependencies with `npm install`.
- `make dev`: run the Vite dev server and launch Electron.
- `make start`: build the app and run Electron from `dist`.
- `make build`: compile the main process and build the renderer.
- `make typecheck`: run strict TypeScript checks.
- `make clean`: remove `dist`.
- `npm run signed:mac-arm64`: build the signed and notarized macOS arm64 DMG; follow `SIGN.md` when a user asks for a signed DMG.
- `npm run test:permissions`: build the main process and run targeted service tests for chat permissions/cancellation, role archive behavior, repo file mentions, participant request threads, chat rename, git repo-file listing, CLI permission handling, and warnings.
- `npm run test:app-skills`: build the main process and run app-skill service tests.
- `npm run test:cloud-runs`: build the main process and renderer component harness, then run focused shared AWS worker lifecycle, discovery, access, setup, Settings UI, doctor, and remote-workspace tests.

Equivalent npm scripts are in `package.json`, for example `npm run dev`, `npm run build`, and `npm run typecheck`.

## Coding Style & Naming Conventions

Use strict TypeScript and keep types explicit at IPC, service, and shared boundaries. Match the existing style: 2-space indentation, double quotes, semicolons, and named imports. React components and service classes use `PascalCase`; functions, hooks, variables, and IPC handlers use `camelCase`. Keep shared contracts in `src/shared/types.ts`.

## Testing Guidelines

There is no full test suite or single full-project lint runner, but targeted Node service tests and renderer lint guardrails exist. Run `make typecheck` and `make build` before submitting broad changes. Use `make lint-colors`, `make lint-lines`, and `make lint-unused` for renderer style, line-count, and unused/orphan checks. Run `npm run test:permissions` for chat permissions, cancellation, role archive behavior, repo-file mentions, participant request threads, rename, git repo-file listing, CLI permission behavior, or warnings, and `npm run test:app-skills` for app-skill service changes. For behavior that touches Electron IPC, provider integrations, git diff handling, conversation storage, or chat concurrency, include manual verification notes in the PR. If adding tests, colocate them near the code under test or use `*.test.ts` / `*.test.tsx`, and add the command to `package.json`.

## Inspecting the running desktop app

Whenever the user asks an agent to **see**, **screenshot**, **scroll**, **click**, **type into**, or **read DOM/CSS state in** the live desktop app — for reproducing UI bugs, verifying a renderer fix, or any UI-driven check — follow `docs/inspecting-the-desktop-app.md`. It uses the Chrome DevTools Protocol against Electron's renderer (port 9222). Do not use macOS `screencapture`, AppleScript, `CGWindowList`, or any window-focus tricks, and do not curl `http://127.0.0.1:5173/` directly — that's Vite's bundle without the Electron preload, so the React app crashes when loaded outside Electron.

In AccordAgents Chat, use the repo-local `/electron-desktop-qa` skill for this workflow. It requires retrying localhost/CDP launch failures with escalation before reporting desktop UI QA as blocked.

If live desktop inspection cannot be completed after following that workflow, stop and ask the user how to proceed instead of silently substituting a browser/Vite check. Offer concrete options, such as relaunching Electron with the debug port, using a renderer mock/browser fixture as a limited fallback, or skipping visual verification.

## MANDATORY: review before merge

**Run the gstack `/review` skill on the diff before merging any pull request,
including your own.** A merge without it is not allowed — not for a small change,
not for a change whose author reported passing tests, not for a change you
wrote yourself. This applies to every participant, local or in the cloud.

Reading the author's summary and grepping the diff for the parts you decided
were risky is not a review. That is exactly what was done to PR #17 on
2026-08-21: the security surface was checked and passed, while the change
quietly attached a full conversation snapshot to a payload that goes to SQLite
as a command-line argument. On the User's real chat that argument is megabytes
and the write fails; it failed 1696 times in one morning, on every message she
sent, and nobody noticed until she said the app felt slow. The author's
end-to-end verification was real but ran on a small conversation, so the size
never showed.

Two questions the review must answer out loud, because that defect would have
been caught by either:

- **How large does this get on the User's actual data?** This chat, thousands of
  messages, is the case that matters — not a fixture.
- **Where does this data end up?** A payload that grows is fine until something
  downstream has a limit: an argument list, a request body, a column, a screen.

## Commit & Pull Request Guidelines

Existing commits use short, imperative summaries such as `Add Makefile for app commands` and `Compare selected branches in diff mode`. Follow that style: describe the user-visible or technical change in one sentence.

PRs should include a concise description, validation commands run, linked issues when applicable, and screenshots or short recordings for renderer UI changes. Call out changes to stored conversation data, settings, provider configuration, or CLI-agent behavior.

## Security & Configuration Tips

Do not commit provider API keys, local paths, generated logs, `node_modules`, or `dist`. Treat settings and debug logs as sensitive when they include prompts, diffs, or model responses.
