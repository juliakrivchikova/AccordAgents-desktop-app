# Parity Requirements

This document is the governing statement of the two parity requirements every
product, architecture, implementation, and UI decision in AccordAgents must
satisfy, and the register of approved exceptions to them.

Both requirements are stated by the User. Neither may be weakened by an
engineering judgement call, a convenience trade-off, or an implementation
constraint discovered late. A difference that violates either requirement is a
**defect** until the User has personally approved it and it appears in the
Approved Exceptions register below.

## Requirement 1 — a cloud participant behaves exactly like a local one

For the user, there must be no difference between working with a participant that
runs locally and one that runs in the cloud. Same controls, same feedback, same
capabilities, same consequences for the same action.

Transport, setup, provisioning, and authentication may differ — those are
invisible plumbing. What the user does, sees, and gets must not.

This covers, without being limited to: available tools, output and streaming,
permissions and approvals, cancellation and its consequences, sessions and
resume, compaction, skills and rules, models, attachments, errors and warnings.

## Requirement 2 — a local participant behaves exactly like its dedicated CLI

Working with one participant in AccordAgents must feel like working with that
agent through its regular, dedicated CLI, to the extent the CLI itself allows.

The dedicated CLI is the source of truth. Where the CLI defines behavior,
AccordAgents mirrors it rather than inventing app-specific semantics. Where the
CLI cannot do something at all, AccordAgents is not required to invent it — the
requirement is parity, not superset.

CLI behavior evolves. Verify the current behavior when implementing or revisiting
a feature rather than relying on an earlier assumption.

## Standing decisions

These are not exceptions. They are decisions by the User about how parity is
achieved, and they hold identically for local and cloud participants.

### AccordAgents does not manage git worktrees

The app never creates, moves, or deletes a git worktree — not in the user's
project locally, not on a cloud worker, not per participant, not per run.

When a task needs isolation, the User asks the participant to work in its own
worktree, and the participant creates it itself with ordinary git commands,
exactly as it would in its dedicated CLI. Isolation is a task instruction, not an
app feature.

Consequences that follow from this and are not negotiable:

- No hidden per-run or per-participant copy of the project is created by the app.
- Whatever the app does to files on a worker must never destroy a
  participant-created worktree or its uncommitted changes.
- A proposal to "give each participant its own worktree" implemented *by the app*
  is a violation of this decision, however convenient it looks.

Stated repeatedly by the User; recorded 2026-08-20 after app-managed
per-participant worktrees were proposed again. `docs/cloud-runs-workspace-parity.md`
carries the operational detail.

## Exceptions

An exception is a deliberate, user-visible divergence from Requirement 1 or 2.

Rules:

1. **Only the User approves an exception.** Not an engineer, not a review, not an
   accord between participants.
2. **Approval is per-exception and explicit.** Approval of one divergence never
   extends to another.
3. **Every approved exception is recorded here**, with its scope, the reason it
   exists, and what the user sees instead.
4. **An unapproved divergence is a defect**, however reasonable its cause. It is
   fixed or brought to the User for approval; it is never left standing as an
   implicit design decision.
5. Keep an approved divergence as narrow as possible, make it visible to the
   user, and verify both the parity path and the divergence.

### Approved exceptions

| Exception | Requirement | Scope | Reason | What the user sees | Approved on |
| --- | --- | --- | --- | --- | --- |
| **A cloud participant delivers code changes through a GitHub pull request, not by writing into the user's working tree.** A local participant edits the project files directly; a cloud participant works in its own mirror, pushes a branch, and opens a PR. | 1 | Code changes only. Everything else a cloud participant does — messages, tools, artifacts, approvals — stays identical to a local participant. | This is how work with a remote human already goes. A PR is reviewable, revertable, and does not overwrite whatever the user is editing at that moment, which an automatic write-back into a live working tree would. | A branch and a pull request from the cloud participant, reviewed and merged the normal way. | 2026-08-19 |
| **Stop on a participant whose machine is unreachable is shown as waiting, not as done.** When the participant's machine is unreachable, Stop shows "stop requested, waiting for the machine"; the command is stored and delivered when connectivity returns; "stopped" appears only after the machine confirms the process is gone. A local participant never shows this state. | 1 | Stop only, and only while the participant's home machine cannot be reached (relay down, machine offline or frozen). A reachable machine confirms within seconds and the user sees the same "stopped by user" a local participant shows. | The desktop cannot know that a process on an unreachable computer is gone; reporting "stopped" before the machine confirms would be a lie, and the transport has no other path to the machine (Rule 1: relay only). | The pending bubble reads "Stop requested — waiting for machine <name>." while the stop is held; it becomes "@handle stopped by user." when the machine confirms. If the machine restarted meanwhile, the turn is closed as failed with "restarted before confirming the stop", never as stopped, because the restart proves nothing about the run's processes; the held stop survives a desktop restart (stored in the machine's record). Implemented in `MachineLinkService.runTurn` / `reconcileAfterHello` (`src/main/services/machineLink.ts`); verified 2026-09-06 through the real desktop UI with a frozen machine process (`scripts/probes/machines/qa-machine-stop-unreachable.cjs`). | 2026-09-05 (Rule 2 of the signed accord "Cloud transport cutover — accord resolution", artifact a6f1e5ad v4, decided by the User in chat) |

### Known unapproved divergences (defects)

These are recorded so they are not mistaken for decisions. They await either a
fix or the User's approval as exceptions.

| Divergence | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| **A payload the phone runs on carries a full conversation snapshot into a command-line argument.** `publishMobileRunnerPolicyForPairing` builds `mobileMailboxRunnerContextSnapshot` for every chat update and appends it as a chat event; chat-event writes reach SQLite through `queryJson`, which passes its SQL as an argv element. On a large chat the argument exceeds the operating system limit and the write fails, so the phone's runner policy is never published — and the failing work sits on the path that runs when the User sends a message. | 1 | Observed 2026-08-21: `spawn E2BIG` 1696 times between 08:40 and 12:00, zero on every previous day; introduced by `835d36a` (#17) and live from the 08:41 restart. Measured 4.0-4.6s between the User's send and the run starting. | Open |
| **Stop destroys a cloud participant's session; locally it does not.** Stopping a local participant cancels the turn and the CLI session survives, so the next turn resumes with its context. Stopping a cloud participant leaves no resumable session on the worker: the next turn fails with a resume miss, the stored session id is cleared, and the participant restarts from nothing. | 1 | Observed 2026-08-19: a cloud member stopped after 16 minutes of work; the following turn returned `thread/resume failed: no rollout found`. Handling at `src/main/services/chat.ts:3020`. | Addressed on the machines transport (`feature/machines-transport`): a member on a machine is stopped by the same ChatService code a local member is, and its session survives. Verified 2026-09-06: Stop on a machine-hosted Claude member, then a new turn resumed the same session and replied. Closes when the cutover removes the worker path. |
| **A cloud participant has no artifact tools.** The desktop exposes 38 app tools, 17 of them `app_artifact_*`; the cloud worker relay exposes 7 and none of them touch artifacts, so a cloud member cannot read, create, revise or sign a document that a local member handles normally. | 1 | `grep -c app_artifact src/main/services/remoteRuns.ts` → 0. Declared by hand at `remoteRuns.ts:3371-3387`, `:4422-4496`, `:4504+`. | Closed in the source on `taylor/machine-installer` (2026-09-07): the worker path is deleted, and a member runs only on its home machine, which serves the same `AppMcpService` and tool wiring as the desktop — artifact tools included. Reopens only if a worker path returns. |
| **The mirror sync destroys a cloud participant's uncommitted work.** `syncUp` runs `rsync -az --delete --delete-excluded` into the worker's `repo/`, which forces it to be an exact copy of the user's local tree: any file the participant created that does not exist locally is deleted. A local participant's uncommitted work is never destroyed this way. | 1 | Observed 2026-08-20: a cloud member's new source file was gone from the worker after a sync at 06:46, twice. Git internals are protected by `REMOTE_MIRROR_UP_SYNC_PROTECT_FILTERS`, so committed work survives and only uncommitted work is lost. | Fixed 2026-08-20: whether the project is already on the worker is decided by the worker itself, not by a local state file, so an existing checkout is reused and never overwritten. Regression test: "a checkout already on the worker is never overwritten by an app instance that has no record of it" in `remoteRuns.test.ts`. |
| **The phone shows messages from a chat it is not looking at.** Live progress reaches the mobile relay control with no conversation on it (`ReviewProgress` has no `conversationId`), so the control falls back to the paired conversation for any run it does not already know — and then memoises that wrong mapping, so every later frame of that run is delivered as the paired chat's. The phone also files a batch that arrives with no conversation under whichever chat is currently open. Content from one chat is therefore shown, and stored, inside another. | 1 | Reported by the User 2026-08-20. Confirmed in the debug log: one mobile route (`route-5520c24f...`) carried frames for three different conversations. Fallback at `mobileRelayControl.ts:278` and `:648`, memoisation at `:282-283`, phone-side fallback to the open chat at `mobile-app.js:1900`. | Fixed 2026-08-21: the conversation is asked of the service that owns the runs (`ChatService.conversationIdForRun`) instead of guessed, an unidentified run is dropped rather than attributed, a route carries only the conversation it is paired to, and the phone no longer files an unlabelled batch under whichever chat is open. Regression test: "progress for a run in another chat is dropped, not delivered as this chat's" in `mobileRelayControl.test.ts`. |
| **The cloud worker keeps running when the app that owns it dies.** The idle-stop timer lives in the desktop process (`AwsWorkerLifecycle.scheduleIdleStop`, a `setTimeout` armed when the last run ends), so it only ever fires while the app is alive. If the machine the app runs on shuts down — a dead battery, a crash, a forced restart — the timer dies with it and the worker bills indefinitely. The one case the safeguard exists for is the one case it cannot cover. | 1 | Observed 2026-08-21: the User's laptop lost power overnight and the worker (`i-0943b28f7231ab93c`) was still running 23.5h after launch, ~8h of them with no desktop app at all. `awsWorkerLifecycle.ts:116` (`DEFAULT_IDLE_STOP_MS` = 3h), armed at `:237`. | Open |
| **Removing a device stops it commanding a machine, but not reading it.** A machine met every controller the owner trusts in its own room, sealed with one key that all of them held. Taking a device off the roster made the machine reject its commands and its acknowledgements immediately, and left it able to open traffic in that room and every retained event it already had. | 2 | `MachinePeerFabric.channelIdFor` met non-machine peers in `options.home.rendezvousId` and sealed with the room key; `machineTrustStore.accept` removed the peer's authority without changing it. Found 2026-09-07 on `taylor/machine-installer`. | Fixed 2026-09-07: each trusted device is given its own key for a machine's room when it is trusted, handed over by the same automatic path that already gives it access, and the machine seals each device's frames with that device's key. A revoked device never held the others', so nothing has to be rotated and no device that stayed has to do anything. Inbound still accepts the room key, because a device that has not yet picked up its own is one of the owner's and refusing it would lock out a working device rather than revoke a removed one — authority is decided by the roster and the signatures, not by which key opened the envelope. Regression: `scripts/machine-peer-sealing.test.mjs`. **Remaining limit, stated:** plaintext and copies a device already received cannot be taken back, and a revoked device can still read frames sealed to it before the revocation. |
| **The mailbox runner exposes no app tools at all.** A participant run through the phone's mailbox path spawns its CLI with no MCP configuration, so it has none of the app surface a local participant has. | 1 | `src/main/services/mobileMailboxRunner.ts:589-596, 634-648`. | Addressed — mailbox runs now embed and execute the same generated worker App MCP contract as ordinary cloud runs. The separate 7↔38 artifact/tool-surface gap remains recorded above. |

`docs/cloud-run-e2e-qa-scenarios.md` is the working catalogue of scenarios that
prove or disprove Requirement 1 in practice. This document states the rule; that
one tracks the evidence.

## Related

- `CLAUDE.md` — the non-negotiable invariant statement carried into every
  engineering session.
- `docs/cloud-runs-workspace-parity.md` — Requirement 1 applied specifically to
  project files and worktrees.
