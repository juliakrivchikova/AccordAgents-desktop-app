# Machines integration checkpoint — 2026-09-07

This is an unfinished integration checkpoint on `drew/machines-final`, based
on `8b9619c`, not cutover or release approval. The root checkout remains clean
`beta`. Both requirements in `docs/parity-requirements.md` still apply.

## Corrections in this checkpoint

- Chat archive/delete closes only that conversation's resident providers and
  waits for native closure; stored provider session IDs remain resumable.
  Concurrent replicated archive and local unarchive share the chat mutation
  queue, so closure cannot run after the later unarchive. Failed closure is
  retained for retry and blocks a second native session or an idle decision.
- Permission and choice events retain the actual draft, native decision ID,
  scope, custom answer and note. Distinct answers have distinct operation IDs.
  Local event persistence failure rejects before the caller tells the provider.
  A Stop effect receipt records a request, not confirmed process termination.
- Host-power observations preserve damaged claims and dead owners whose native
  descendants are unproven. Separate runtime identities cannot overwrite one
  another's claim. Registration is released only after explicit native closure,
  not when the timer stops. Power tests use private coordination directories.

## Evidence and limits

- Native arm64 Node 24: `make typecheck`, `make build`, `make lint-colors
  lint-unused` passed. The packaged runtime payload built as 9 files / 6,284,219
  bytes at this checkpoint; subsequent source changes require rebuilding it.
- Full permissions/cancellation suite: 755 tests, 748 passed, 7 skipped, no
  failures. After the final archive-queue correction, the affected
  `chat.rename.test` suite passed again. Focused action/applier and host-power
  tests passed (37 cases). Tests that inspect child processes must run with
  native process-list access; sandbox `ps` denial is not product evidence.
- Real isolated Electron, CDP 9251, real Codex: create chat and obtain
  `READY_9251`; Archive via UI; registry stores `closed / processes-gone`;
  Unarchive via UI and ask for the remembered token; receive `ORCHID-9251`
  with the same provider session ID and a new native process generation;
  Archive and Delete permanently via UI; chat is absent and generation 2 is
  closed with `processes-gone`. Root app and user conversations were untouched.
  Screenshot: `screenshots/qa-final-archive-resume.png` (local QA artifact).
- The final queue correction also has a deterministic overlap test. It needs
  another real replicated-machine run; the local Electron result alone does
  not prove remote archive/delete or offline delivery.

## Review findings still blocking the transition

1. Universal new work with the original desktop off: implementation delegated
   to Taylor; not verified by this checkpoint.
2. Archive/delete still needs durable machine lifecycle commands/tombstones,
   acknowledgement, restart and stale-replica verification. Receiving an
   archived snapshot now closes sessions, but that is not durable deletion.
3. Host-wide admission is not atomic with stop. Not every runtime/maintenance
   entry publishes before work, and claims are observations rather than a
   shared admission fence. The complete path must include hosts without their
   own AWS configuration, idle resident providers, maintenance, crashed owners
   and retained stop intent. A second read just before EC2 Stop is insufficient.
4. Canonical action execution must use the durable native effect boundary:
   `ChatActionEmitter.beginExecution` currently only checks for a receipt;
   `createChatActionEffects` can mistake replicated pending state for ownership
   and does not use `MachineApprovalExecutor`'s claim/delivery guard. Repeated
   or concurrent answers and a crash between effect and receipt remain open.
5. The QA catalogue, full final-diff review, real Linux/public-relay/installed
   PWA matrix, signing/install path, power verification and cutover drain remain
   required. Source deletion of the old pipeline is not evidence of these.

## Size and destination

Closure bookkeeping grows with native sessions and active operations, not chat
rows; per-instance power claims contain identities only and stay in the host's
coordination directory. Native closure receipts stay in that machine's SQLite
process registry. No prompt or conversation snapshot is added to process argv.

## Trust/channel integration follow-up — 2026-09-07

Integrated Taylor's multi-device work through `ce443c9` in `0d8c0b6` and
reviewed the changed trust, presence, event, mailbox and settings paths. This
remains an unfinished transition checkpoint, not a clean full-branch review.

- Roster authority now requires the enrollment issuer's signed durable event;
  a second desktop cannot replace settings, the home identity or the roster,
  including by embedding settings in a permitted turn. Ephemeral presence is
  signed and bound to its sender, recipient and room. Possession of a room seal
  alone grants no command or acknowledgement authority.
- Roster comparison, persistence and publication serialize together; a failed
  write preserves the old authority. The signed sequence survives restart and
  unchanged rosters, and outranks wall clocks. Corrupt/unreadable files are not
  treated as empty lists. Offline roster changes are queued and recovered at
  desktop startup; trust metadata never travels in a settings snapshot.
- ACK, repair and fragment packets carry sender signatures. An unsigned ACK
  cannot release an outbox entry. Authentication failures cannot pin later
  mailbox traffic; actual persistence failures still hold the transport cursor.
  Shared chat-action history can repair through header probes too. Revoked
  channels stop before applying their next ready event; changed peer rooms and
  keys replace their connections and use their own mailbox endpoint.

Verification: final main/renderer typechecks and full build passed; the rebuilt
payload is 9 files / 6,396,431 bytes. Focused trust/settings/channel/mailbox/host
tests passed; the final mailbox/channel set is 12/12, and the relay link/phone
command component set 13/13 with native localhost/process permissions. The
initial sandbox run's socket and process denials were not product failures.

The original trust e2e accepted failed turns and counted a nonexistent log
event. It now requires an actual Codex completed reply, Stop after real output
starts, and unchanged native SQL executor generations after redelivering the
original signed command and restarting the runtime. All passed on two built
macOS runtimes and the reference relay with the owner link closed. A prompt
asking for 100,000 lines instead finished with the provider's output-limit
explanation; the final test asks for 500 and observes actual streaming before
cancelling. This is not physical-phone or Linux acceptance.

Real isolated Electron Settings, rebuilt runtime and public relay: grant a
synthetic controller, observe the machine's persisted roster, remove the
controller, and observe signed `applied` ACKs for both changes in the desktop's
SQLite outbox (sequences 19/20). The final roster is 892 bytes for one issuer;
it grows with devices, not conversation rows. A packet signature adds about
100 JSON bytes; fragments remain bounded and no chat data enters argv. The
earlier 14k-row / 41 MB conversation baseline is unchanged. Screenshot:
`screenshots/qa-final-machine-trust.png` (local QA artifact, enrollment hidden).

Additional open integration findings, to fix before cutover:

- The PWA direct-machine sender has a separate best-effort metadata chain;
  storing machine access resets that chain, and queue/sequence writes are not
  one transaction. Its response/ACK/render path is not connected. A passing
  command-signing helper does not prove a usable desktop-off phone workflow.
- Removing a device rejects its commands but it retains old room seals;
  confidential revocation also needs key rotation and retained-event handling.
- The old Cloud Runs toggle/copy still advertises the deleted remote executor.
- Taylor's host-power change `6371847` awaits integration/review; its report
  explicitly does not prove real Linux or AWS Stop. Canonical action execution,
  durable deletion and the remaining acceptance matrix above are still open.

Decision events now carry their real answer/draft, so their size scales with
that content. They enter the existing local SQLite event/outbox and sealed relay
path; exact fragmentation and retention must be verified on the integrated
branch, including the no-enrolled-machine publication path. The earlier measured
14,000-row / roughly 41 MB conversation baseline remains an acceptance input;
these focused tests do not re-prove its end-to-end cost.
