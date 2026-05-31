# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Prefer the Makefile aliases; they wrap the npm scripts in `package.json`.

- `make dev` — Vite dev server + Electron with live reload. Internally runs `npm run build:main` first because Electron loads the compiled main/preload from `dist/main` even in dev.
- `make build` — Compile main process (`tsc -p tsconfig.main.json`) then `vite build` the renderer.
- `make start` — Build, then run Electron from `dist`.
- `make typecheck` — Strict TS checks for both main and renderer projects (`tsc --noEmit` against each tsconfig).
- `make clean` — Remove `dist`.
- `npm run test:permissions` — Build the main process, then run targeted Node service tests for chat permissions/cancellation, repo file mentions, chat rename, git repo-file listing, and CLI permission handling.
- `npm run test:app-skills` — Build the main process, then run app-skill service tests.

There is no lint runner. Before submitting changes, run `make typecheck` and (for renderer changes) `make build`. For chat permissions, cancellation, repo-file mentions, rename, git repo-file listing, or CLI permission changes, run `npm run test:permissions`. For app-skill service changes, run `npm run test:app-skills`. Manual verification notes are expected in PRs whenever IPC, provider integrations, git diff handling, conversation storage, or chat concurrency are touched.

Debug logs (JSONL of progress events and raw provider/CLI output) are written to Electron's `userData/debug-logs/<date>.jsonl`. The `DebugLogService` enables them automatically when running unpackaged; force on/off with `AI_CONSENSUS_DEBUG_LOGS=1` / `=0`.

## Inspecting the running desktop app

Whenever the user asks you to **see**, **screenshot**, **scroll**, **click**, **type into**, or **read DOM/CSS state in** the running app — for reproducing UI bugs, verifying a renderer fix, or any UI-driven check — follow `docs/inspecting-the-desktop-app.md`. It uses the Chrome DevTools Protocol against Electron's renderer (port 9222). Do NOT use macOS `screencapture`, AppleScript, `CGWindowList`, or any window-focus tricks, and do NOT try to hit `http://127.0.0.1:5173/` directly — that's Vite's bundle without the Electron preload and the React app crashes when loaded that way.

## Architecture

This is an Electron desktop app that orchestrates a debate between several AI participants over a code diff or question and produces a consensus answer. There are three TS projects compiled separately:

- `src/main` (CommonJS, Node target) — Electron main process. Compiled to `dist/main`. The Electron entrypoint resolves to `dist/main/main/main.js` (see `package.json#main`).
- `src/preload` — Compiled together with main. Exposes the IPC bridge to the renderer via `contextBridge`.
- `src/renderer` (ESNext, DOM target) — React app bundled by Vite into `dist/renderer`.
- `src/shared` — Imported by all three; this is where the wire format lives.

### The `src/shared/types.ts` contract

`src/shared/types.ts` defines `AppBridge`, the complete IPC surface. Every IPC handler in `src/main/main.ts`, every method in `src/preload/index.ts`, and every renderer call site must stay in sync with this file. When adding an IPC route, update all three layers plus the type. Renderer code reaches the main process exclusively via `window.consensus` (typed by `src/preload/global.d.ts`); there is no direct Node access from the renderer (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`).

### Service layout (main process)

`src/main/main.ts` instantiates services once at startup and wires them to IPC handlers. Long-running operations (`startReview`, `continueReview`, chat sends, plan composition) accept a per-run `AbortController` keyed by `runId` in the `activeReviews` map; `conversations:cancel-review` aborts that controller. Progress is streamed back to the renderer via the `conversations:review-progress` channel and snapshot updates via `conversations:updated`.

Services in `src/main/services`:

- `consensus.ts` (~3.5k lines) — Core orchestration. Runs each participant on the initial prompt, asks the arbiter to merge points, opens a debate thread per point, and either confirms/rejects findings or escalates to the arbiter. Implementation-plan conversations have additional flows (`composeImplementationPlan`, `retryImplementationPlanSynthesis`, `recoverImplementationPlan`, `reviseImplementationPlan`, `askPlanDecisionClarification`) for plan synthesis, decision gates, and revision; understand the four `ConversationKind` values (`general`, `code-review`, `implementation-plan`, `chat`) before changing branching here.
- `chat.ts` — The `chat` conversation kind. Maintains per-participant CLI sessions (`ChatParticipantSession`) with persistent `sessionId`s so Codex/Claude resume context across turns. Mention approvals (`ChatPendingMention`) gate when an `@handle` triggers another agent. Chat sends ingest the user message synchronously, then fan out mentioned participants in the background. Each target run has its own `runId`/`AbortController`; `metadata.activeRunIds` is the active-run source of truth, with `metadata.running`/`metadata.runId` kept for compatibility. Concurrent chat writes must go through `withChatMutation`, which waits for queued saves and refreshes/merges storage before mutating. Do not emit `queueSnapshot` or call `saveConversation` directly from long-running chat-turn code. Same-participant turns serialize via `participantTurnQueues`, while different participants can run concurrently. `cancelRun(runId)` may abort multiple controllers because resume flows can share a run id, so active run bookkeeping is ref-counted.
- `providers.ts` — HTTP providers (OpenAI, Anthropic, Gemini). Reads API keys from `SettingsService` at call time. Normalizes responses to a `ParticipantRunResult`.
- `cliAgents.ts` — Runs `codex` and `claude` CLIs. Detects them via `which`, then spawns `codex exec` / `claude` with carefully constructed argv: `--sandbox read-only`, `--cd <repo>`, `--skip-git-repo-check` for non-repo or `chat` runs, `--ephemeral --ignore-rules` when no repo is selected. Resumes Codex sessions via `codex exec resume <sessionId>`. Output goes through a temp `--output-last-message` file; raw stdout is mostly progress JSON.
- `settings.ts` — Reads/writes JSON settings under Electron `userData`. API keys are encrypted with Electron `safeStorage`; `hasApiKey` is the only key-related field exposed to the renderer. Owns `chatRoleConfigs` (instructions templates) and `chatParticipantConfigs` (handle/role/CLI bindings) used by `ChatService`. See `docs/chat-roles-and-participants.md` before changing chat role presets, participant configs, or runtime session behavior.
- `storage.ts` — Persists conversations to a SQLite DB at `userData/accordagents.sqlite3`. **Storage shells out to the `sqlite3` CLI** (`runCommand("sqlite3", ...)`); there is no native binding. The schema is one table (`conversations`) with the full `Conversation` JSON in `payload_json`; everything else is denormalized for ordering. On startup `clearInterruptedRuns` flips any conversation with `metadata.running === true` back to `false` and appends a warning, so a crash mid-run leaves a recoverable record.
- `git.ts` — Wraps `git` for repo inspection and the various `GitDiffMode` values. `pasted` mode bypasses git entirely.
- `command.ts` — `runCommand` helper used by every service that spawns a subprocess. Honors `AbortSignal`, enforces `timeoutMs` with SIGTERM→SIGKILL escalation. CLI runs use `CLI_AGENT_RUN_TIMEOUT_MS = 15 * 60_000`; sqlite calls use 10s.

### Renderer

`src/renderer/App.tsx` is a single ~5k-line component that contains the entire UI (sidebar, chat view, review view, plan view, settings). State is local React state plus subscriptions to `onReviewProgress` / `onConversationUpdated`. Chat sends should not set the global `busy` flag; active chat state is per-conversation/per-run. The chat UI derives per-message Stop controls from `message.metadata.runId`, and Stop all from `metadata.activeRunIds` plus pending message run ids. Styles are in `src/renderer/styles/app.css`; assets in `src/renderer/assets`. Touch this file with care — it is large but intentional, and lacks renderer tests.

### Warning sanitization

`src/shared/warnings.ts` is shared because both the main process (when generating warnings during a run) and storage (when reading old conversations) must produce identical output. CLI agents occasionally dump raw event JSON into stderr; `sanitizeWarningText` collapses those into a one-line "see debug logs" notice and drops obsolete patterns. Any time you push a new warning into `conversation.metadata.warnings`, it should already be a clean human sentence — sanitization is the safety net, not the formatter.

### Conversation persistence model

Conversations are append-mostly: `messages`, `findings` (each with embedded `rounds`), and `metadata` (a free-form bag that includes `runId`, `participants`, `pendingDecisions`, `pendingDecisionSelections`, `pendingDecisionResolutions`, `running`, `warnings`, `participantSessions`, etc.). `consensus.ts` and `chat.ts` snapshot the conversation back to disk via `flushAndSaveConversation` on every meaningful state change so that a renderer crash or restart can pick up. When adding a new long-running flow, follow this pattern: emit progress, mutate the conversation, queue a save, push a snapshot via `onConversationSnapshot`.

## Code conventions

- 2-space indent, double quotes, semicolons, named imports. `PascalCase` for components/classes, `camelCase` for everything else.
- Strict TS everywhere; keep types explicit at IPC, service, and shared boundaries. Add new shapes to `src/shared/types.ts` rather than redefining them on either side of the bridge.
- Do not commit provider API keys, local repo paths, generated logs, `node_modules`, or `dist`. Treat saved conversations and `debug-logs/` as sensitive — they contain prompts, diffs, and raw model responses.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
