# New cloud chat preparation — 2026-09-13

Status: implementation, supporting checks, full diff/lifecycle review, and real
Electron → AWS → Codex reply verification complete for the reported creation bug.
The unrelated baseline test failures below remain open.

## Observed failure

The user's new cloud chat was requested at 19:20:41.178 UTC but saved only at
19:24:22.358 UTC: project preparation occupied 221 seconds before a conversation
existed. The participant answered at 19:24:55 UTC. The renderer set `busy` while
awaiting creation but rendered its empty-conversation fallback, and Stop had no
controller registered for `chat:create`.

## Changed lifecycle

- New Chat assigns a run ID before calling IPC; creation reports its current
  phase through the existing progress channel. The renderer filters by that ID
  and displays preparation with elapsed time instead of the empty fallback.
- Stop aborts project inspection and the rsync process group. Temporary wrapper
  and staging cleanup run independently of the aborted signal. A cancelled queued
  preparation neither interrupts another chat's copy nor lets a retry overtake it.
- Creation checks cancellation before persistence. A late successful create reply
  after Stop cannot dispatch the first message. Cleanup archives only an empty,
  idle chat, checked under the service mutation lock; persisted messages survive.
- Closing the requesting renderer or quitting the application aborts its active
  creation. Interrupted transfers cannot publish the random staging directory as
  a runnable project; a completed remote copy can be reused after a failed local
  mapping save or restart. Existing remote working copies are never overwritten.
- Provider execution, permissions, machine ownership and first-run locking keep
  their existing behavior. Preparation remains outside the message/turn path.

## Supporting verification

- Typecheck and production build pass.
- Renderer component suites: 110 passed, including real coordinating hooks for
  progress isolation, Stop, late create replies, persisted send failure and success.
- Preparation/installer/mirror services: 69 passed; new ChatService creation and
  atomic empty-chat cleanup tests pass independently. The final combined service
  and process-cancellation check passes 93 tests (4 platform skips).
- Toggle and machine transport contracts: 11 passed.
- Full permissions suite with per-test timeout and force-exit: 805 passed,
  2 failed, 7 skipped. Failures: `tool permission request denies and marks approval
  on timeout`; `Claude public warm-run path preserves a held reply after provider
  failure without replaying the prompt`. They also fail separately; the permission
  failure reproduces using ChatService compiled from baseline `83baf44`; both
  targeted failures persist with that baseline service. Claude execution code is
  unchanged by this patch. These failures were not fixed here.
- Color/unused guardrails pass; line guard still reports the same 19 oversized
  renderer files present at baseline.

## Review: size and destinations

The actual AccordAgents checkout's mirror fingerprint covers 10,249 files and
3,663,860,996 bytes. This is the QA repository, not a measurement of the user's
different project from the reported incident. Repository bytes follow the
existing SSH/rsync file stream; this patch adds no repository or conversation
snapshot to command arguments. Creation sends a UUID and bounded phase/percentage
messages over existing IPC; the renderer retains at most 500 progress entries.
The elapsed timer is local and hidden from repeated screen-reader announcements.

## Real Electron verification

- Isolated desktop with its own enrolled cloud environment, the real running AWS
  worker and native Codex sign-in; no provider credential files were copied.
- New Chat on the actual AccordAgents repository showed `Starting chat`, first-copy
  progress (51%, then 58%) and a moving elapsed timer, instead of the empty screen.
- Stop during the 58% transfer immediately showed `Stopping preparation…`; it
  completed with `Chat creation cancelled.` and returned to the New Chat composer.
- The prompt `Reply only QA_NEW_CLOUD_CHAT_OK` and the selected cloud machine were
  retained. No conversation or first message was created. A read-only SSH listing
  confirmed the isolated project's parent directory was empty: no published
  repository and no bootstrap staging directory remained.
- Retrying the unchanged draft completed the first copy and opened the chat:
  creation requested at 21:43:37.197 UTC, saved at 21:45:24.366 (107.169 seconds),
  then a real Codex response returned `QA_NEW_CLOUD_CHAT_OK`.
- A second new cloud chat reused the project: requested at 21:48:27.302, saved at
  21:48:27.335 (33 ms), then Codex returned `QA_CLOUD_PROJECT_REUSED_OK`.
- After restarting only the isolated Electron with the same profile, both chats
  remained. The next new cloud chat reused the persisted project mapping:
  requested at 21:53:59.999, saved at 21:54:00.020 (21 ms), then Codex returned
  `QA_CLOUD_RESTART_OK`. These creation timings exclude provider execution and the
  separate cloud-machine readiness check.
- Evidence: `screenshots/new-cloud-chat-copying.png`,
  `screenshots/new-cloud-chat-stopping.png`,
  `screenshots/new-cloud-chat-cancelled.png`, `screenshots/new-cloud-chat-reply.png`,
  `screenshots/new-cloud-chat-reused.png`, and `screenshots/new-cloud-chat-restarted.png`
  in the feature worktree.

## Verification limits

Late save replies, concurrent message persistence, failed settings writes, and
cancelled queued preparations were checked by fault injection on the production
services/components. A forced machine or desktop crash during transfer was not
performed; the live cancellation check used the actual Stop control. This is
desktop verification, not an installed-phone PWA check. No AWS instance lifecycle
actions or release publication were performed.
