# Machines transport — the machine runtime

A **machine** is a computer that runs AccordAgents without a window and hosts chat members. It is the same application code the desktop runs (`src/machine/main.ts` composes the same services through `src/main/platform.ts`), enrolled with one desktop through a machine-host pairing, and reachable only through the relay. There is no worker, no SSH turn pipeline, and no shared store: the machine keeps its own copy of the chats it hosts, its own provider sessions, and the settings the desktop sends it.

## What travels between the desktop and a machine

Every message is sealed with the pairing's key inside the machine's own relay room (`src/shared/machineLink.ts`):

| Direction | Message | When |
|---|---|---|
| machine → desktop | `machine.hello` | on every (re)connect, including the machine's own link coming back: device id, name, app version, platform, installed providers, runtime instance id, active runs, results waiting in the outbox |
| desktop → machine | `machine.hello.ack`, `machine.settings.sync` | after hello; the settings snapshot (roles, rules, saved prompts, member presets, limits, agent environment values) also travels with every turn request |
| desktop → machine | `machine.conversation.sync` / `machine.conversation.delta` | the first time a chat reaches the machine: the conversation shell, then its messages in bounded batches (at most 150 messages / ~1.5 MB of JSON per relay message, single oversized messages and metadata still require fragmentation to meet the relay's 10 MiB limit); changed messages afterwards, batched the same way. The machine keeps its own `participantSessions`, `activeRunIds`, `running`, `runId`, `pendingAppToolApprovals`; approval policies are the union of both sides. A fresh copy after a reconnect never erases messages the machine produced meanwhile, and the machine's inventory of what the desktop holds is kept across syncs, so a reconnect does not send the whole history back. |
| desktop → machine | `machine.turn.request` | the member's home is this machine: run this member for this message, with the desktop's run id and pending message id. Settings sync and replication precede it; a Stop that lands during that preparation means the request is never sent. |
| machine → desktop | `machine.turn.progress.delta`, `machine.turn.finished` | streamed progress and the finished messages (same ids on both sides), sent in order. The machine keeps a finished turn in its outbox (`machine-outbox.json` under its user data, so it survives a restart of the runtime) and resends it on every hello until the desktop answers `machine.turn.finished.ack`. Whatever the status (reply, stopped, failed, stop not confirmed), the machine's copy of the bubble contributes its text and the run's other messages, live or late: a desktop that finds no pending turn for it (restart) folds the result into the chat the same way before acknowledging. |
| desktop → machine | `machine.turn.finished.ack` | sent only after the outcome (reply, stop, unconfirmed stop, failure) has been written to the desktop's SQLite; a failed write sends no ack and the machine keeps the result |
| desktop → machine | `machine.conversation.sync.done` | the first copy (shell + every batch) has been sent in full; only now does the machine compare its own rows against what the desktop holds, so a restarted machine with a full database sends back only rows it made itself. A batch the machine could not store reverts its inventory entries and marks the copy incomplete, during the first copy or later: the machine answers `machine.conversation.resync` (at most three times per chat; a fresh copy resets the failure but not the budget), and a turn requested while a copy that failed is incomplete fails honestly instead of running on stale rows; a turn that arrives while a copy is still being received waits for the copy and runs once it is complete; while it waits it counts as held (listed in hello, never "unknown"), and a Stop removes it and reports a confirmed interruption, so the copy completing never starts a stopped turn. A repeated hello on an intact connection does not reset the desktop inventory; a disconnect or a machine restart does, so the next replication can send a full copy |
| machine → desktop | `machine.conversation.resync` | a batch of the first copy could not be stored; the desktop sends the whole copy again from its current state |
| machine → desktop | `machine.turn.unknown` | a stop named a run this runtime does not know (not running, no result waiting): the held stop is dropped and the member's bubble says the stop was not confirmed (Rule 2) |
| machine → desktop | `machine.conversation.backdelta` | messages the machine wrote outside a turn result (mid-turn `app_chat_send_message`, artifact notes) |
| machine → desktop | `machine.approval.requested` / `machine.approval.updated` | a member on the machine needs a permission or app-tool approval: the desktop shows the same card it shows for a local member, tagged with the member's home machine |
| — | desktop stale-run sweep | a pending bubble of a member whose home is another machine is never swept as "Interrupted before completion": that machine owns every outcome of its runs, including runs it started itself (a resume after an approval) that the desktop never registered; the machine in turn ignores a swept copy of any bubble it holds (finished or still running). Inside a machine runtime its own members (the desktop's record id arrives in `machine.hello.ack`) are swept like local ones, so the machine recovers its own lost runs after a restart |
| desktop → machine | `machine.hello.request` | a desktop that connected and received no hello within a moment asks for one (a relay may seat a restarted desktop silently in place of the old one); the machine then greets, re-sends held results, re-offers approvals and re-forwards rows the desktop does not hold |
| desktop → machine | `machine.approval.decision` | the User's whole card answer (approve/deny, scope, an edited Codex proposal, the native decision id); the machine applies it through the ordinary approval path and the member resumes |
| machine → desktop | `machine.approval.result` | outcome of applying that decision together with the approval and policies as the machine now holds them; the desktop stores them and only then lets the card call return. After a reconnect the machine offers every approval it holds again, so one raised while the desktop was away is not lost |
| desktop → machine | `machine.turn.cancel` | Stop. If the machine is unreachable or does not confirm within a few seconds, the bubble shows "Stop requested — waiting for machine <name>" (Rule 2, an approved parity exception in `docs/parity-requirements.md`); the stop is kept and delivered again on the machine's next `machine.hello`, and "stopped by user" appears only after the machine confirms. Every dispatched turn and every held stop is stored in the machine's record on the desktop, so both survive a desktop restart: the restarted desktop asks the machine about each recorded run it did not list, a result the machine still holds lands as a late result, and a run the machine does not know is closed (`machine.turn.unknown`) instead of staying pending forever; when that answer arrives after a desktop restart, the member's bubble is updated (stopped, or stop not confirmed) and stored before the held stop is dropped. A hello carries the runtime's `instanceId`, `instanceSequence` (a start counter kept in `machine-instance.json`; published only when read and advanced reliably), `instanceStartedAt`, `activeRunIds` and `pendingTerminalRunIds`. No turn is ever closed from process order or clocks: after a hello the desktop asks the machine about every turn it still waits on whose request has already left and that the machine did not list (`machine.turn.query`; a turn still in preparation is never asked about, and an answer for one is ignored); a runtime that does not hold the run answers `machine.turn.unknown` and the turn is closed then, as a lost run, or as "stop not confirmed" (`terminalReason: stop-unconfirmed`, never "stopped") when a stop was held. A late hello from an older instance is ignored only when both hellos carry a reliable counter. Messages from a machine are decrypted and applied strictly in arrival order on both sides; a redelivery of the very same result (same receipt UUID and machine finish time) is folded once (`metadata.machineOutcome`), while a real result still replaces a provisional desktop-side outcome such as a timeout; the run's CLI warnings reach the chat with a late result too. |

Dedicated provider/AWS credential records, cloud-run settings, and other machines' records are excluded (`SettingsService.exportMachineSettingsSnapshot`). Manually configured agent environment values do travel, including any secrets the User explicitly put there; these are sealed in transit and stored through the machine's secret store.

## Install on a Linux computer

1. Install Node 20+, the `sqlite3` CLI, `git`, and the provider CLIs you use (`codex`, `claude`); log the CLIs in on that computer (native auth is per machine and is never copied).
2. Build the bundle on the desktop: `npm run build:machine` → `dist/machine/` (`accordagents-machine.cjs`, `package.json`, `appSkills/`, `README.md`).
3. Copy `dist/machine/` to the computer (for example `~/accordagents-machine`) and run `npm install --omit=dev` inside it.
4. In the desktop app: Settings → General → Machines → Add machine. Copy the enrollment and save it on the computer as `~/accordagents-machine/enrollment.json` (it carries the relay key; treat it like a password).
5. Start it:

```sh
node ~/accordagents-machine/accordagents-machine.cjs \
  --enrollment ~/accordagents-machine/enrollment.json \
  --user-data ~/.accordagents/machine \
  --name my-cloud-box
```

The desktop shows the machine as Connected in Settings → Machines within a few seconds. Assign a member to it in the member editor ("Machine" row) and use the chat as usual.

### systemd unit

```ini
[Unit]
Description=AccordAgents machine
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
Environment=ACCORDAGENTS_MACHINE_ENROLLMENT=/home/ubuntu/accordagents-machine/enrollment.json
Environment=ACCORDAGENTS_USER_DATA_DIR=/home/ubuntu/.accordagents/machine
Environment=ACCORDAGENTS_MACHINE_NAME=my-cloud-box
ExecStart=/usr/bin/node /home/ubuntu/accordagents-machine/accordagents-machine.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## Run recovery and Stop (2026-09-06 follow-up)

The desktop now saves a run intent **before** sending `machine.turn.request`;
an intent that cannot be saved never starts a provider turn. Both `pendingRuns`
and `pendingCancels` are retained when a fresh `SettingsService` reads the file,
and settings writes replace the file atomically. A retained intent is queried
after restart, never automatically replayed. A provisional `unknown` answer
cannot overwrite a terminal already saved from the machine.

Native continuations created by `ChatService` after an approval participate in
the host's live-run inventory, Stop, and result outbox. Releasing the provider
controller is not the final result: the host waits for the continuation's caller
to append its final messages and for the chat save to complete. Stop on a pending
machine continuation that the desktop did not dispatch is routed to its home
machine. The replica rejects a desktop stale-recovery mark only for participants
owned by this machine; recovery of desktop-local participants still replicates.

Outbound commands are serialized starting with sealing. Stop before the first
frame write prevents dispatch, including time spent queued behind other traffic;
an ambiguous failed write retains both the intent and any requested Stop for
reconciliation. A result acknowledgement binds to its receipt UUID and machine
finish time, so an older native continuation's acknowledgement cannot remove a
newer result that reused the same run id. A missing desktop chat is a failed save,
not permission to discard the machine's result.

Codex Stop captures child process identities before native interruption can
reparent them, terminates the remaining tree, and waits until those processes
have exited. A provider process exiting first is not confirmation; a zombie that
has stopped executing is. The provider session id remains resumable.

Focused verification: `test:permissions` 855 passed / 8 skipped,
`test:machines` 33 passed, and the Cloudflare relay/mailbox tests 30 passed.
The relay-room test now subscribes to the desktop's phone-join event before
opening the phone, avoiding a missed-event hang. Typecheck and production build
passed. Full-diff review found and corrected the persistence, native-continuation,
receipt-acknowledgement and dispatch/cancel issues covered by these regressions.

### Real desktop and EC2 verification, 2026-09-06

An isolated Electron instance on macOS controlled a separate headless runtime on
the User's EC2 (Linux x64, Node 22.23.1, Codex 0.153.4) through the deployed public
relay. Only synthetic chats and test settings were replicated; native provider
authentication already on the EC2 was reused, not copied from the desktop.

- Initial reply and 20 consecutive warm turns passed with one app-server process;
  full-answer durations were 3.4–11.9 seconds, median approximately 5 seconds.
  These are not first-token latency measurements.
- A real app permission card was answered on the desktop and resumed the member
  on EC2. Stop removed a verified live Python child in 192 ms in the first probe
  and 170 ms after the update; the desktop showed `stopped by user` afterwards.
- A subsequent EC2 turn completed after Stop and the runtime update; its receipt
  UUID was stored on the desktop and the machine outbox was empty after ACK.
- A desktop restart during a real EC2 command also preserved its full late
  result and receipt, with an empty outbox after ACK. Freezing only the EC2
  runtime before Stop showed the waiting badge; after unfreezing, the actual
  command exited and only then did the desktop report `stopped by user`.
- Against a separate macOS machine runtime, closing and restarting the isolated
  desktop during a live command preserved the final reply without a false
  interruption. Stop followed by another turn preserved the native session id.

Screenshots: `screenshots/qa-ec2-updated-real-relay.png` and
`screenshots/qa-machine-codex-stop-real-relay.png`. This proves the tested vertical
slice, not the full cutover: physical-phone QA, Claude quota-dependent QA, durable
delivery of all events, process recovery after a runtime crash and the remaining
event-contract work are still required.

## Durable conversation and outcome delivery (2026-09-06)

The conversation sync/delta/backdelta and finished/finished-ack rows in the table
above now use `DeviceEventChannel` and the pairing's sealed mailbox as well as
the live room. New enrollment requires and registers that mailbox. Native turn
commands, progress, settings and approval RPCs used the direct sealed link at
that stage; the command and approval sections below supersede that limitation.
Progress conversion remains required before cutover. The terminal file outbox
is retained until its receipt is applied; SQLite additionally retains its signed
event and fragments, including the desktop's acknowledgement, across disconnect.
No native action is replayed by this delivery layer.

Failed durable copy batches retry their retained event rather than automatically
sending a full copy three times. A restarted machine restores the partial-copy
barrier and inventory before connecting, so previously applied batches are not
mistaken for offline replies. Legacy direct-wire test paths still exercise their
older bounded resync behavior. A late terminal clears only its run's metadata
before publishing the snapshot, preserving other concurrent runs and keeping
the sidebar and saved chat consistent.

The real QA driver `qa-machine-mailbox-return.cjs` uses an isolated Electron
profile and a separate native Codex runtime against the published public relay:
it closes the controller during an actual Python command, waits for the relay
to accept the completed outcome, stops that QA machine, then restarts only the
controller. It checks the returned answer, saved run state and retained intents;
with `QA_NEW_CHAT=1` it also checks the visible sidebar has stopped spinning.
`QA_RESUME_MARKER` resumes observation of an already executed probe; it never
replays its command. This Mac check does not replace Linux or physical-phone QA.

The fresh-chat public-relay probe passed with marker
`BUFFERED_REPLY_70f528c21c6747079a6fd8fa064261be`; screenshot
`screenshots/qa-machine-mailbox-return.png` was inspected. It also exposed and
fixed a startup race: a delayed initial sidebar list could overwrite a newer
pushed terminal state. Summary refreshes now preserve updates received since
their read began, and an older refresh cannot overwrite a newer refresh.

Verification for this delivery slice: 51 machine tests, 84 storage tests,
856 permission/cancellation tests (8 platform skips), 24 snapshot/update tests,
and the targeted chat-action renderer tests passed; typecheck, production build,
color and unused/orphan checks passed. The repository-wide line-count guard
still fails on pre-existing oversized renderer files, including the two touched
action hooks (previously 638 and 599 lines); unrelated file splitting is not
part of this change. Review covered persistence, receipt loss, apply failure,
fragment repair, restarts, ownership and the full changed data path. Full
transition acceptance remains open as listed below and in the event contract.

## Native process ownership — Mac and Linux real-provider verification

Codex and Claude resident sessions on macOS/Linux now share one supervisor
process per app data directory. Each participant session owns a separate SQLite
lease and increasing process generation in `native-processes.sqlite3`. The
supervisor starts a shell gate, records its PID and birth identity durably, and
only then permits `exec` of the provider; the shell is replaced by the provider,
so there is no extra resident process per participant. The gate uses its own
file descriptor and cannot consume native stdin. A failed receipt write admits
no provider input; transport initialization failure never replays the prompt
through a one-shot CLI.

When the app crashes, the supervisor remains alive to close and verify its own
provider trees. Stop captures descendants before closing stdin, including Claude
background work in separate process groups. A new app waits for the previous
supervisor's stored closure; losing the supervisor itself does not prove Stop.
A different OS boot on the same OS host permits retiring the old process lease,
but says nothing about whether the old command executed. Linux identities use
kernel boot ID and `/proc/<pid>/stat` start ticks, independent of wall time;
macOS `ps` reads use a fixed UTC/C environment. The Linux field semantics come
from the [kernel proc documentation](https://www.kernel.org/doc/html/v6.15/filesystems/proc.html).
Normal machine shutdown drains active outcomes to the durable channel before
closing it; a failed final save does not count as completed shutdown.

The supervisor's local IPC is bounded to 64 KiB input/output chunks and preserves
backpressure per session. Three local echo sessions shared one supervisor with
59,280 KiB RSS, median 0.10 ms / p95 0.30 ms round trip, and 915 bytes of process
receipts in a 12 KiB database (measurement before adding OS host/boot fields).
This is synthetic local overhead, not Codex latency, Linux resource usage or a
relay cost measurement. A separate 42,047,781-byte input passed unchanged and
left less than 2 KiB of process metadata. No prompt, response, CLI arguments or
environment is written into the process registry: only scoped process identities,
a hashed OS host identity, boot identity, generation and shutdown state. The
registry stays on that machine and is not replicated or uploaded.

Local checks: 152 lifecycle / CLI protocol tests passed with two platform skips,
including guarded Codex and Claude protocol fixtures, process crashes, detached
children, full-disk refusal, blocked output in one of two sessions, large output,
large stdin, synchronous/asynchronous startup refusal and concurrent shutdown;
296 chat / machine-link / machine-host tests also passed. These support the real
Electron/public-relay checks completed on 2026-09-06 with native Codex 0.153.4 on
macOS and the User's Linux EC2, using isolated profiles and synthetic chats.
Foreground Stop confirmed process exit in 705 ms on Mac and 959 ms on Linux;
subsequent turns resumed the same native session and retained its context.
Killing each machine runtime while its provider was executing a child command
left the supervisor alive to verify the old process tree was gone before a new
runtime resumed the session. The desktop showed the lost turn as failed, never
as a confirmed User Stop. A frozen Mac runtime produced the waiting-for-machine
Stop badge and confirmed interruption only after it returned. A completed reply
arrived through the public mailbox after the controller restarted with the
machine already shut down. Linux also passed an approval answered through the
desktop card and normal shutdown with no remaining owned provider processes.
The EC2 was stopped again after QA. Real Claude verification remains blocked by
the provider quota; physical-phone checks remain open. Windows and other provider
paths have not acquired this process-ownership mechanism yet.

### Durable command admission, 2026-09-06

`NativeCommandStore` now owns dispatch admission in `accordagents.sqlite3`.
The source commits a signed request and its recipient outbox together, after
the conversation-copy events. An already enrolled, offline machine shows
"Waiting for machine <name>"; neither simultaneous connectivity nor a new SSH
process is required. The receiver records acceptance before ACK, serializes
commands per member session in signed logical order, and claims its executor
generation before native input. A retained Stop uses an independent stream and
a durable tombstone, including when it arrives before its request.

After runtime loss a claimed command is never replayed. Recovery requires the
previous app identity to be gone and its guardian to have closed the provider
tree (or verified reboot of the same OS host); it then records an uncertain
execution outcome. A terminal has one immutable identity, including through
concurrent Stop, shutdown and failed-write retries. Receiver application of
the started state and terminal must save successfully before their ACKs.

Each request retains its settings snapshot, encrypted before event/blob
persistence, so a later settings change cannot change an offline command.
Separate settings updates are also durable and sealed. The receiver replaces
configuration and its locally encrypted environment in one fsynced atomic write;
an unreadable source secret refuses export instead of silently removing that
variable on the machine. Concurrent headless starts publish one complete secret
key exclusively, and a corrupt key is never replaced.

Real Electron/public-relay QA on 2026-09-06: an offline request showed the waiting
badge and completed after machine startup; another command and its answer
crossed the mailbox with no simultaneous controller/machine connection, then
appeared once after desktop restart with the machine already off. Stop queued
offline was delivered and confirmed; a separate Stop on a running Python child
confirmed in 631 ms with that PID gone. The next Codex turn resumed the same
session and returned an earlier marker from context. Supporting failure tests
cover failed admission, failed claim/terminal/started-state writes, early Stop,
duplicate recovery, a surviving guardian, settings/key failures, and receipt
index repair. These results do not mark the full transition or cutover ready:
durable approvals, PWA and the remaining event contract are still open.

## Cost on a large chat

Every conversation snapshot on the desktop triggers a replication pass for the
chats a machine hosts; unchanged message objects cache their hashes and queued
snapshots coalesce. The new durable channel was measured with 14,000 synthetic
rows / 42,047,781 bytes of message JSON: 94 batches, 281 mailbox POSTs,
75,153,690 bytes of sealed HTTP bodies, maximum 700,124 bytes per POST. Fragment
base64 inside the sealed envelope explains the extra encoding overhead compared
with the earlier direct-link measurement (~55 MB). Local encoding, SQLite
persistence and a fake successful HTTP sink took 10.45 s; this is not network
latency. Cold stamps took 72.7 ms; warm shared-object passes had median 0.30 ms /
p95 0.70 ms. A later full copy can still repeat this cost when the desktop's
volatile replication inventory is lost; the machine's incoming inventory persists.

A fresh read-only measurement of the User's actual database found the largest
chat by message bytes had 329 rows / 3,483,428 bytes, with a 333,527-byte largest
message; the largest conversation shell was 750,744 bytes. No content left the
computer for that measurement. The 14,000-row case is a historical scale fixture,
not a claim about today's largest chat. A separate public-mailbox probe carried
13,920,011 raw bytes in 36 fragments, maximum 700,218 bytes per POST, and applied
once after sender exit. Single large messages and metadata in the converted
events now fragment. In the isolated QA profile a retained command body was at
most 99,459 bytes (settings ciphertext included), a settings update 98,658 bytes,
and started/Stop bodies 173/133 bytes; these are QA settings, not a new measurement
of the User's catalogue. Their large bodies use the same fragments and bounded
SQLite stdin path, rather than one CLI argument or relay frame. Progress and
approval control are covered below.

Bodies, fragments, event headers, delivery receipts and inventory stay in the
endpoints' local SQLite; only sealed packets reach the User's relay buffer.
The new history has no garbage collection yet, and repeated growing snapshots
can accumulate substantial history; measured retention pressure and history
garbage collection remain cutover work. The 24-hour relay cost measurement is still open.

## Durable approval decisions (2026-09-06)

Approval requests, updates, decisions and results now travel through signed
device events, the sealed live room and mailbox. The table's earlier synchronous
card RPC is superseded: the desktop commits the decision locally and displays
"Approval saved" or "Refusal saved" while application is unconfirmed, including
while the machine is offline. A result is correlated by decision id, not just
card id; concurrent retries cannot resolve a different decision's call. Queued
feedback survives ordinary card notifications and clears only for its matching
receipt, including a result arriving before the local callback finishes.

`native_approval_effects` in the machine's SQLite claims each approval once,
after validation and before changing permissions, applying an app tool or
answering the provider. Codex decisions wait for the native adapter's delivery
acknowledgement. A failed pre-effect claim leaves the decision queued; a failed
result write retries the same response without applying again. After process
loss, an existing claim cannot be reused: the old executor must be proven gone,
and missing delivery confirmation is reported as uncertain. Stop can still
enter while an approval waits for native delivery; shutdown drains that work.
This guards native effects; canonical conflict projection across all peers is
still separate unfinished work.

Real Electron/Codex/public-relay QA: with the machine frozen, "allow once" saved
locally in 229 ms. The desktop was killed, the machine resumed and fetched the
requested page, then the machine was stopped before the desktop restarted.
The new desktop received the approved card and the single "Example Domain"
answer from the mailbox, with exactly one native approval claim. A second
permission request on the final build was refused through the real card and
stored as denied with its own receipt, without a lingering waiting badge.
These are macOS checks; they do not claim physical-phone, Linux approval-replay
or Claude verification for this change.

On that real QA chat the decision body was 347 bytes, result 1,115 bytes and
native-effect identity fields 294 bytes before SQLite overhead. A decision or
result carries its card/policies, not the 14,000-message history; a large edited
proposal uses the existing bounded blob fragments and SQLite stdin path.
The whole conversation snapshot/save path still has the previously measured
large-chat cost. Approval bodies/receipts remain on user machines in SQLite;
only sealed packets reach the relay buffer. This does not solve history GC or
the outstanding representative relay-cost measurement.

## Artifact revision identity (2026-09-06)

Artifact bodies now live in immutable `artifact_revisions` rows, identified by
the version event id and SHA-256 of the exact UTF-8 content. Display numbers
live in a separate projection; signatures and draft provenance bind to the
immutable identity. Re-projecting one of two competing v2 revisions retains
the other body and its signatures, without counting them toward the winner.
Projection validates revision ancestry and never executes an external action.

The desktop signs using the identity/hash it displayed and submits revisions
with the base identity/hash it read. A stale base is rejected, including when
the displayed number stayed the same. Retrying on the new base preserves the
user's typed text and revision note; successful edits refresh the version list.
App MCP accepts the same identity guards. Numeric-only legacy callers still
resolve the requested version at apply time; universal artifact event emission
must carry the resolved immutable identity, not re-resolve it on another peer.

Legacy migration copies one version per read, then atomically binds signatures,
sources and cached publication responses. Failure leaves the migration
restartable; a completion marker prevents a second migrating process from
re-binding old signatures after projection. Old tables remain for recovery,
but their version/signature INSERT/UPDATE paths are fenced against old binaries.
This is not downgrade support: cutover still requires the verified application
drain and database backup before a new binary opens user data.

The current User chat contains two published artifacts and five versions:
132,622 bytes of content in total, with a largest version of 34,491 bytes.
This is that chat's measurement, not a whole-installation census. Legacy bodies
temporarily occupy both old and new local SQLite tables. A version remains
limited to 512 KiB; SQL, including escaped bodies, now goes through stdin rather
than an operating-system argument. The tested signature list is under 1 KiB
and does not embed the body or conversation. This step adds no relay payload;
artifact event fan-out, losing-revision UI and conflict replay are still open.

Verification for this storage step: 75 service/MCP/chat-rename cases, the 17-tool
terminology guard and 20 artifact renderer/navigation cases pass. Fault cases
cover migration write failure/retry, concurrent migration/publication/revision,
old-writer rejection and two offline v2 identities with accumulating signatures.
In an isolated real Electron instance, User created and signed v1, saved a
512-KiB unsigned v2, restarted the app and read both identities unchanged; a
concurrent edit then produced a stale-base response, and the UI retry saved the
typed text and note intact while preserving the original v1 signature.

## Durable streaming and SQLite throughput (2026-09-06)

Machine progress now uses signed text/activity deltas in the same per-run stream
as the terminal. Text coalesces at 100 ms; observed tool/status transitions are
retained. The sender retries an identical failed frame before later frames and
holds the terminal until all preceding progress is stored. A SQLite projection
stores only frame references; loading a pending message reconstructs its partial
answer without updating every conversation/message row for each token. Startup
replays locally authored events committed before a projection failure, and a
crash outcome retains that partial output beside its diagnostic. It does not
invent a completed reply or replay the native command.

Storage reuses a `sqlite3` process through stdin/stdout, opening a fresh database
connection for each operation and closing it before reporting success. Temporary
tables, PRAGMA state and uncommitted transactions cannot leak into the next
operation; `.bail on` rolls back a failed batch. A timeout kills the process and
rejects without retrying an operation whose commit is uncertain. The process
exits after one idle second or parent-pipe closure. Applied-event/ACK caches are
bounded to 2,048 identities and never stand in for a successful SQLite commit.

The size regression uses a 14,000-row, roughly 41-MB chat and database triggers
that forbid rewriting its conversation/message rows during progress. A 1-MiB
answer in 256 chunks produces under 1.3 MB of delta JSON, versus over 130 MB of
cumulative snapshots; even a blocked writer queues under 1.5 MB of deltas while
preserving 256 distinct activity changes. Frame bodies and references remain in
the owning and receiving machines' SQLite/blob stores; only sealed packets reach
the relay/mailbox. SQL goes through pipes, never a growing command argument.
History retention/GC and representative relay billing remain cutover work.

Real isolated Electron + native Codex + public-relay verification on macOS:
a desktop restart during streaming retained the received prefix, and a later
machine SIGKILL between event commit and projection commit retained 4,794
characters with an honest failed outcome and no automatic rerun. Stop confirmed
interruption, retained 3,353 characters in the existing processing transcript,
and a following request completed through session resume. The measured 80-line,
12,287-character answer produced 660 frames / 1,194,233 bytes of event-envelope
JSON; average creation-to-application delay was 732 ms, maximum 2,276 ms, and the
terminal took 2,525 ms. This is a material improvement over the initial 195-second
backlog, not proof of end-to-end latency parity or of Linux/phone behavior.

Checks: storage 87/87, machines/relay 63/63, final progress/SQLite/channel 15/15,
and final host/link 12/12. The broad permissions run had 863 passes, 8 skips and
one four-second fixture-startup failure under load; that shutdown case passed
in an isolated rerun. Real Claude streaming is unverified while its quota is
unavailable. These checks complete this streaming slice, not the whole signed
machines transition or its final release gate.

## Where the machine keeps data

Under the user-data directory: `accordagents.sqlite3` (its copy of the chats it hosts, artifacts, chat events), `settings.json` (the desktop's shareable settings plus the machine's own records), `machine-secrets.key` (0600; seals the machine's secrets), `machine-outbox.json` (finished turns not yet acknowledged by the desktop; an unreadable file is never overwritten, a damaged one is set aside as `.corrupt-<time>` and, if it cannot be moved or copied aside, is left untouched and reported instead of being overwritten, entries with an unexpected shape are archived in `.rejected-<time>.json` and, until that archive is written, carried back into the outbox file so a later write never discards them; a failed write is retried every 30 s and reported in the machine's hello, which the Machines settings show as a warning), `machine-instance.json` (start counter, advanced atomically; when it cannot be read or written the machine publishes no sequence and the desktop falls back to the start time), `chats/<id>/` (history files the CLIs read), `debug-logs/`.

## Local QA on one Mac

`scripts/probes/machines/` holds the drivers used for the end-to-end check: a relay under `wrangler dev` (`--port 18099`), an isolated desktop (`ACCORDAGENTS_USER_DATA_DIR=/private/tmp/accordagents-qa-machines ACCORDAGENTS_MOBILE_RELAY_URL=ws://127.0.0.1:18099/v1/relay npx electron . --remote-debugging-port=9223`), `qa-create-machine.cjs` (mints the enrollment through the bridge), the machine runtime started with that enrollment and its own user-data directory, `qa-wait-machine.cjs`, `qa-machine-turn2.cjs <marker>` (a member turn through the real UI), `qa-machine-approval.cjs` (a permission approval answered on the desktop for a member on the machine), `qa-machine-stop.cjs` (Stop, no orphaned processes), `qa-machine-stop-unreachable.cjs` (Stop while the machine process is frozen: waiting state, then confirmation), and `qa-machine-second-turn.cjs <conversationId> [marker]` (a second turn on the resident session). Loopback `ws:` relays are accepted only for `127.0.0.1`/`localhost`.

## Not yet on machines (tracked, next)

- User choices (`User choice:` blocks) raised by a member on a machine reach the desktop as ordinary messages; the answer travels back as the next user message, which is the same round trip a local member gets. Nothing else is forwarded for them yet.
- A machine-hosted member's requests to other members run on the machine's copy; routing them to the other members' home machines follows the event contract (`docs/machines/02-event-contract.md`).
- Conversation copies/deltas, native command admission/Stop, settings, approvals, progress and terminal outcomes now use durable delivery and accepted-event clock observation; the PWA's IndexedDB clock/outbox and chat-wide event projections remain.
- The install/upgrade service exists (`MachineInstallerService`, `docs/machines/04-install-and-upgrade.md`): versioned releases, a proven drain before replacement, rollback on a failed connect, and mirror bootstrap that refuses a dirty mirror. It is not wired to `main.ts` or the Machines UI yet, and has not been run against a real Linux machine, so the steps above stay manual until both are done.
- The machine-owned three-hour AWS idle stop and scoped phone wake still need implementation and verification; the desktop timer does not protect against the desktop dying. The current manual QA deployment is not an always-on production installation.
- The legacy worker path and the cloud-only prompt branch remain until the cutover commit removes them.
