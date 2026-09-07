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
3. Host-wide admission and stop are integrated and verified on macOS as
   described below. Real Linux and AWS Stop acceptance remain open; the local
   fault-injection checks do not replace them.
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
- Taylor's host-power change `6371847` was integrated in `6e4d73f`; the follow-up
  below fixes findings from its review. It does not prove real Linux or AWS Stop. Canonical action execution,
  durable deletion and the remaining acceptance matrix above are still open.

Decision events now carry their real answer/draft, so their size scales with
that content. They enter the existing local SQLite event/outbox and sealed relay
path; exact fragmentation and retention must be verified on the integrated
branch, including the no-enrolled-machine publication path. The earlier measured
14,000-row / roughly 41 MB conversation baseline remains an acceptance input;
these focused tests do not re-prove its end-to-end cost.

## Native lifecycle and host admission follow-up — 2026-09-07

The host critical section now uses a kernel `flock`, with the same open-file
description retained by Node and passed to a Python standard-library helper.
The lock survives helper-only death while Node awaits SQLite; parent death
closes its descriptor and the helper observes stdin EOF. Neither process
explicitly unlocks or replaces the lock file. This follows the documented
descriptor semantics of [Linux flock](https://man7.org/linux/man-pages/man2/flock.2.html)
and [Darwin flock](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html).
The installer checks Python availability before uploading a release.

Native admission publishes busy while holding that lock; the local SQLite
stop fence and shared committed intent use the same critical section. A losing
intent does not leave a local fence. If persistence becomes unreadable, the
runtime retains admission gates and retries inspection: a confirmed absent
fence reopens queued work, a stored fence completes host-wide stop recovery.
An unresolved committed stop survives process restart until a verified new
host boot. Claims use version 2; an older admission protocol suspends automatic
stop. Runtimes without AWS configuration publish periodic presence too.

Shutdown now covers preparation before provider creation and invalidates
commands whose asynchronous admission completes after shutdown. Concurrent
registry initialization coalesces in-process and retries only idempotent WAL
setup on SQLITE_BUSY across processes. SQLite batches stop at the first error;
native ownership acquisition and external effects are never retried by this
initialization repair. The earlier intermittent active-response shutdown test
exposed two distinct startup issues: its cold shell-readiness prerequisite was
inside a shorter provider deadline, and a provider returned a real SQLite
`database is locked (5)` before launch. Both now have explicit coverage.

Evidence: native lifecycle/CLI permissions 149 tests, 147 passed and 2 skipped;
the three affected preparation/admission checks passed again after the final
shutdown-generation change. Host power/idle/real-host SQLite fault cases 27/27;
the separate-process host-power probe passed, including three stop contenders,
live native descendants after a controller kill, maintenance, and a neighbour
without AWS keys. Its AWS call is recorded by a test client, never sent.

Real isolated Electron (9251), a separate built macOS machine runtime and the
public relay: UI turn returns `NATIVE_MACHINE_READY`, next turn recalls
`ORCHID-9251`, Stop during a numbered streaming response receives an immutable
`interrupted` outcome. Its 3,160-character partial transcript remains available
through Show full stream. The machine registry records a single native process
generation for those turns, then `closed / processes-gone`. Screenshot:
`screenshots/qa-final-native-stop.png` (local QA artifact).
After the final lock/recovery changes, rebuilding and restarting that isolated
runtime preserved the next real UI turn: it again returned `ORCHID-9251` with a
completed machine receipt. Final build, main/renderer typechecks and renderer
colour/unused/orphan guards passed; the rebuilt payload is 9 files / 6,472,456
bytes. These are macOS/public-relay checks, not Linux power or phone acceptance.

Size/destination: the native 42,047,781-byte stdin regression still passes with
its process receipt below 2 KB. The host probe's three deployments and one stop
leave five coordination files totalling 868 bytes; none contains conversation
content. The lock helper gets static code plus one file descriptor, never a
prompt, key or growing chat payload. The integration remains unfinished for
canonical effects, durable deletion, confidential device revocation, PWA and
the real acceptance/cutover gates listed above.

### Canonical approval execution checkpoint — 2026-09-07

Integrated Taylor's phone channel at `bde0ee4`, then traced the approval path
through the actual IPC, canonical event, receiver, native claim, result,
projection and receipt. A desktop answer previously also emitted a separate
machine approval command; either path could act first. Both local and remote
answers now use `permission.decided` and the existing `NativeCommandStore`
approval claim before any effect. Old retained machine decisions use that same
claim. Machine replies resolve the card only after its projection is stored;
queued feedback is no longer mistaken for successful application.

The receiver distinguishes a foreign owner from a request that has not arrived.
The latter remains deferred. Local startup recovers recorded answers without a
result, and repairs execution receipts lost after a stored result, using pages
of 100 event headers. Native claims prevent another execution; uncertain prior
delivery remains uncertain. Concurrent receipt callbacks share one write.
These changes cover approvals; choices still need the equivalent native-effect
boundary and must not be described as covered by a receipt lookup alone.

Verification: final affected executor/action/relay cases 43/43. The broader
affected chat/action/executor run passed 306 cases and exposed one incomplete
new ownership fixture; using a valid approval card fixed that test, which then
passed alone. Main and renderer typechecks, full build, and colour/unused/orphan
guards passed (the final build contains a 9-file, 6,487,641-byte machine payload).
Reviewed the entire checkpoint diff with the gstack review checklist and traced
unchanged producers/consumers; fixed missing-request loss, receipt-write races
and local startup recovery during that review. This is a scoped review, not an
approval of the entire machines branch or its remaining acceptance gaps.

Real isolated Electron 9251 and a separate runtime over the public relay:
the machine's repository-read card was clicked and became approved, with one
canonical decision, one native claim and one result; the participant resumed
and answered. Its requested package-version check was not applicable because
this no-project QA chat's working directory contains history, not package.json.
The local equivalent resumed with `LOCAL_APPROVAL_RESUMED` (screenshot
`screenshots/qa-canonical-local-approval.png`, a local artifact).
For local restart recovery, a SQLite trigger rejected only the test approval's
native claim: the clicked card left one decision and zero claims/results.
After killing only that QA desktop, removing the trigger and restarting, the
participant returned `LOCAL_RECOVERED_APPROVAL`; SQLite held exactly one
decision, claim, result and execution receipt. No User app or chat was changed.

Size/destination: measured approval envelopes were 1,123 bytes for a decision
and up to 2,182 bytes for a result; each native ledger entry holds identities,
not the conversation. A result carries its card and permission policies, so
edited proposals/policy growth still go through the existing blob transport;
the new approval records do not copy the 14,000-row history into SQL arguments
or relay records. ChatService still reads its conversation to apply a decision;
this checkpoint makes no new claim about the previously measured large-chat
snapshot cost. Persistent copies remain in the desktop/owning machine SQLite
stores and the sealed relay delivery path. Remaining work includes choices,
durable archive/delete, confidential revocation and the phone/acceptance gates.


## Taylor's continuation — 2026-09-07

Carried on from `952ca45` without restarting it. Head `fafd845` on
`taylor/machine-installer`; the root checkout stays clean `beta`.

- **A choice now crosses the same durable row an approval does.** It was
  admitted by asking whether a receipt event existed, which is a read, not a
  claim: two answers arriving together both told the provider, and a crash
  between telling it and writing the receipt told it again on the next start.
  A claim with no receipt is reported uncertain and never repeated. Ownership
  moved from "any run is active in this chat" to the run that raised the
  choice. Eight focused cases including a disk that refuses the claim and a
  receipt that cannot be written.
- **Deleting a chat reaches the machines that hold it**, as a durable command
  with a tombstone: providers closed first, rows after, a stale sync or delta
  refused, a restarted runtime still refusing, a turn for it failed rather than
  run, offline delivery on return, and a roster-trusted phone refused because
  deletion is an ownership act. Seven focused cases.
- **The room owes a newly trusted device what it already held** — checked by
  counting outbox recipients before and after a phone joins the roster.
- **The deleted executor's controls are gone from Settings.** The toggle, the
  worker-source choice, the SSH target and paths, the runtime timeouts, the
  staging paragraph and the worker doctor all described something the app can
  no longer do. What remains is the instance a machine is installed onto.

### Size and destination

Measured against the real thing rather than a fixture: the User's own database
is 3.67 GB, and the conversation baseline in this document is 14,000 rows /
about 41 MB.

- A deletion tombstone is one row of an id and a timestamp per deleted chat —
  about 60 bytes. It grows with chats the User deletes, never with messages,
  and holds nothing of the conversation.
- A choice claim is one row per answered choice in the same table approvals
  already use — ids and a runtime identity, roughly 200 bytes. It grows with
  answers, not with history.
- Both reach SQLite through the same `sqlite3` argv path that once failed on a
  megabyte-sized argument. Neither carries any conversation content: the
  largest value in either statement is a conversation id.
- The deletion command's payload is a type, a conversation id and a timestamp,
  so it is never large enough to be fragmented on the wire.
- On the phone, fragments of a body are released once the machine acknowledges
  the event that names them, and the record of runs that ended is capped at
  300 entries.

### Still open

- **Revoking a device's authority does not revoke its reading.** Recorded as a
  divergence in `docs/parity-requirements.md`; closing it changes the pairing
  surface, so it waits on the User's decision between rotating the machine's
  room and per-pair keys.
- Real Linux, real AWS Stop, signing and a physically installed phone remain
  unverified here. Desktop Chrome is not an installed PWA and a reference relay
  on this machine is not the public one.
