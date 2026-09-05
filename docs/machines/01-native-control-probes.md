# Machines transport — step 1: native control probes

Resolution: "Cloud transport cutover — accord resolution" (artifact `a6f1e5ad-097e-442f-9396-f7566984a01f`, v4, signed 2026-09-05 by gera and Drew), work item 1.
Evidence recorded here was produced on 2026-09-05/06 on macOS (Darwin 25.0.0) with the installed CLIs: **Codex 0.153.4** (`codex app-server --listen stdio://`) and **Claude Code 2.1.257** (`claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose`). Probe scripts live in `scripts/probes/machines/` and must be re-run on a Linux machine before the acceptance in §4 of the resolution counts (`PROBE_CWD` selects the working directory).

## 1. What each CLI offers natively

| Capability | Codex app-server (0.153.4) | Claude Code stream-json (2.1.257) |
|---|---|---|
| Start / resume a session | `thread/start`, `thread/resume {threadId, cwd, approvalPolicy, sandbox, model, config, developerInstructions, excludeTurns}`, `thread/fork`, `thread/inject_items` | `--session-id <uuid>` / `--resume <id>` on process start; one `system/init` per turn on the same process |
| Turn | `turn/start {threadId, input[], clientUserMessageId?}` → `{turn.id}`; `turn/started`, `item/*`, `turn/completed {turn.status: completed \| interrupted \| …}` | `user` message on stdin → `assistant`/`user(tool_result)`/`result` events; `result.subtype` `success` or `error_during_execution` |
| Queued / mid-turn input | `turn/steer {threadId, expectedTurnId, input[]}` → `{turnId}` (same turn); not allowed for `review` and `compact` turns (`NonSteerableTurnKind`); `thread/queue/changed {threadId}` | A `user` message written while a turn runs is **injected into the running turn** (appears as a `user [text]` item right after the running tool's result; one `result` covers both). It is not a second queued turn. |
| Interrupt / Stop | `turn/interrupt {threadId, turnId}` → `{}`; `turn/completed` with `status: "interrupted"`; `thread/status/changed → idle`; same process serves the next `turn/start` | `control_request {request_id, request: {subtype: "interrupt"}}` on stdin → `control_response {subtype: "success", response: {still_queued: []}}`; the running tool gets `tool_result(error) "User rejected tool use"`; `result/error_during_execution`; same process serves the next `user` message on the same session |
| Permission / approval | Server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `execCommandApproval`, `applyPatchApproval` (already implemented in `cliAgents.ts`); Guardian via `thread/approveGuardianDeniedAction`; `thread/status/changed → active {activeFlags: [waitingOnApproval \| waitingOnUserInput]}` | The app passes `--permission-prompt-tool mcp__accord_agents__<permission tool>`: the permission prompt is an App MCP call served by the App MCP server (`claudePermissionPromptTool` in `cliAgents.ts`). On a machine the App MCP server runs locally on that machine, so this path is unchanged. (`--permission-prompt-tool stdio` / `control_request can_use_tool` exists in the CLI but is not used and was not probed.) |
| User input request | `item/tool/requestUserInput {threadId, turnId, itemId, isBlocking, questions[{id, header, question, options?, isOther, isSecret}], autoResolutionMs?}` → `{answers: {id: {answers[]}}}` | App-level `User choice:` block (chat protocol), no native primitive used |
| Thread status | `thread/status/changed {status: notLoaded \| idle \| systemError \| active{activeFlags}}` | `system/status {status: "requesting"}` per model call; `system/task_started`, `system/background_tasks_changed`, `system/task_notification` for background tasks (see `claude-background-tasks-hold-v1`) |
| Durable local server | `codex app-server daemon bootstrap [--remote-control]` installs a managed daemon "for SSH-driven use"; `--listen unix://PATH \| ws://IP:PORT`; `daemon version` reports CLI and running server versions. Not running on this Mac today (`app-server-control.sock` absent). | `claude --bg/--background` starts a background session and returns its id; `claude attach`, `logs`, `stop`, `rm`, `agents`. Not probed. |

## 2. Live probe results

### 2.1 Claude — interrupt (probe `claude-control.cjs`, `claude-interrupt-tool.cjs`)
- `control_request interrupt` while a Bash tool was running (`python3 -c "time.sleep(50)"`): `control_response success` in < 10 ms; the tool child processes (zsh + python) were gone within 1.5 s; the turn ended with `result/error_during_execution` (`is_error: true`); the next `user` message on the same process produced `system/init` with the same `session_id` and a normal `result/success`.
- **Contract consequence:** Stop for a Claude participant is a native interrupt on the resident process, not process termination; the session and the process survive.

### 2.2 Claude — mid-turn input (probe `claude-queue-interrupt.cjs`)
- With `--replay-user-messages`, a `user` message sent 2 s after `tool_use` started was echoed and injected into the running turn: after the tool result the model answered both the tool output and the injected text in one reply (`num_turns: 2`, single `result`).
- **Contract consequence:** a message to a busy Claude participant is a steer of the current turn (parity with the CLI); there is no native "next turn" queue. Any "queue for after this turn" behavior is app-level and must be the same on every machine.

### 2.3 Claude — crash mid-tool and resume (probe `claude-crash-resume.cjs`)
- `SIGKILL` of the CLI 3 s into a running Bash tool: the tool's shell and python processes **kept running** (orphans) after the CLI died.
- `--resume <session>` in a new process: the session record contained the assistant text before the tool call but **no trace of the tool call**; the model answered "I didn't actually run the command … there's no Bash execution in the session record".
- **Contract consequences:** (a) the machine runtime is the only holder of the in-flight receipt (it saw `tool_use`), so the "uncertain outcome" state of §2.4 of the resolution is produced by the runtime, never by the CLI; (b) provider processes must be spawned in their own process group (or session) so the runtime can terminate the whole tree on crash recovery and verify no orphans remain before adopting or restarting the session.

### 2.4 Codex — steer and interrupt (probe `codex-steer-interrupt.cjs`)
- `turn/steer` 2 s into a running `commandExecution` returned the **same** `turnId`; a `userMessage` item appeared inside the running turn; the turn completed with the command output and the steer honored.
- `turn/interrupt` 3 s into a running command: `turn/completed` with `status: "interrupted"` and `thread/status/changed → idle` arrived immediately; the next `turn/start` on the same process completed normally.
- **The interrupted command kept running**: its python process was alive 1, 3, 6, 10 and 15 s after the interrupt and 3 s after the app-server received `SIGTERM` (probe `codex-interrupt-orphans.cjs`).
- **Contract consequence:** for Codex, Stop = `turn/interrupt` **plus** runtime-side termination of the command's process tree with verification (the resolution's "process-tree termination is a bounded escalation" is mandatory, not optional, for Codex).

### 2.5 Codex — crash mid-command and resume (probe `codex-crash-resume.cjs`)
- `SIGKILL` of the app-server 3 s into a running command: the command's python process **kept running**.
- New app-server, `thread/resume` succeeded and returned the thread; `thread/items/list` contained the user message and the agent's "I'll run the command…" text but **no `commandExecution` item**: the in-flight item is not persisted.
- **Contract consequence:** same as 2.3; the runtime's own receipt log is the source of the uncertain-outcome state for both providers.

### 2.6 Not probed in step 1 (deferred to work items 4–5 with reasons)
- Codex `item/tool/requestUserInput` round trip (schema captured; the app has no native user-input consumer today).
- Claude `--permission-prompt-tool stdio` / `control_request can_use_tool` (the App MCP permission tool path is what the app uses and it is machine-local by construction).
- A pending approval across a provider crash: follows from 2.3/2.5 (the in-flight item is lost); the runtime must invalidate the pending card and report the uncertain outcome.
- Codex daemon mode and Claude `--bg` as alternatives to runtime-owned child processes: to be evaluated in work item 2 (headless runtime); the resolution requires runtime-owned process groups either way.

## 3. Requirements this step adds to the contract (feed into work items 4–5)
1. Provider children run in a runtime-owned process group per participant session; Stop and crash recovery terminate and verify the tree (both providers orphan tool children).
2. The runtime records a receipt for every native item start/completion it observes (`item/started` / `tool_use`); after a crash the last receipt without a completion becomes an explicit "uncertain outcome" event, never a re-run.
3. Stop = native interrupt (`turn/interrupt` / `control_request interrupt`) on the resident process; the process and session survive; delivered text is preserved (Claude ends the turn with `result/error_during_execution`, Codex with `status: "interrupted"`).
4. A message to a busy participant is a steer of the running turn on both providers (`turn/steer` / injected `user` message); the app must present it as such on every surface.
5. Turn identity: Codex `turn.id` and `clientUserMessageId`; Claude has no turn id, so the runtime assigns one per `user` message it writes and correlates by `session_id` + order.
