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
| machine → desktop | `machine.turn.progress`, `machine.turn.finished` | streamed progress and the finished messages (same ids on both sides), sent in order. The machine keeps a finished turn in its outbox (`machine-outbox.json` under its user data, so it survives a restart of the runtime) and resends it on every hello until the desktop answers `machine.turn.finished.ack`. Whatever the status (reply, stopped, failed, stop not confirmed), the machine's copy of the bubble contributes its text and the run's other messages, live or late: a desktop that finds no pending turn for it (restart) folds the result into the chat the same way before acknowledging. |
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
commands, progress, settings and approval RPCs still use the direct sealed link;
that remaining conversion is required before cutover. The terminal file outbox
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
events now fragment; direct settings/progress/control still need conversion.

Bodies, fragments, event headers, delivery receipts and inventory stay in the
endpoints' local SQLite; only sealed packets reach the User's relay buffer.
The new history has no garbage collection yet, and repeated growing snapshots
can accumulate substantial history; progress coalescing and measured retention
pressure remain cutover work. The 24-hour relay cost measurement is still open.

## Where the machine keeps data

Under the user-data directory: `accordagents.sqlite3` (its copy of the chats it hosts, artifacts, chat events), `settings.json` (the desktop's shareable settings plus the machine's own records), `machine-secrets.key` (0600; seals the machine's secrets), `machine-outbox.json` (finished turns not yet acknowledged by the desktop; an unreadable file is never overwritten, a damaged one is set aside as `.corrupt-<time>` and, if it cannot be moved or copied aside, is left untouched and reported instead of being overwritten, entries with an unexpected shape are archived in `.rejected-<time>.json` and, until that archive is written, carried back into the outbox file so a later write never discards them; a failed write is retried every 30 s and reported in the machine's hello, which the Machines settings show as a warning), `machine-instance.json` (start counter, advanced atomically; when it cannot be read or written the machine publishes no sequence and the desktop falls back to the start time), `chats/<id>/` (history files the CLIs read), `debug-logs/`.

## Local QA on one Mac

`scripts/probes/machines/` holds the drivers used for the end-to-end check: a relay under `wrangler dev` (`--port 18099`), an isolated desktop (`ACCORDAGENTS_USER_DATA_DIR=/private/tmp/accordagents-qa-machines ACCORDAGENTS_MOBILE_RELAY_URL=ws://127.0.0.1:18099/v1/relay npx electron . --remote-debugging-port=9223`), `qa-create-machine.cjs` (mints the enrollment through the bridge), the machine runtime started with that enrollment and its own user-data directory, `qa-wait-machine.cjs`, `qa-machine-turn2.cjs <marker>` (a member turn through the real UI), `qa-machine-approval.cjs` (a permission approval answered on the desktop for a member on the machine), `qa-machine-stop.cjs` (Stop, no orphaned processes), `qa-machine-stop-unreachable.cjs` (Stop while the machine process is frozen: waiting state, then confirmation), and `qa-machine-second-turn.cjs <conversationId> [marker]` (a second turn on the resident session). Loopback `ws:` relays are accepted only for `127.0.0.1`/`localhost`.

## Not yet on machines (tracked, next)

- User choices (`User choice:` blocks) raised by a member on a machine reach the desktop as ordinary messages; the answer travels back as the next user message, which is the same round trip a local member gets. Nothing else is forwarded for them yet.
- A machine-hosted member's requests to other members run on the machine's copy; routing them to the other members' home machines follows the event contract (`docs/machines/02-event-contract.md`).
- Conversation copies/deltas and terminal outcomes now use durable delivery and accepted-event clock observation; native commands, approval RPCs, settings and progress still need conversion, followed by the PWA's IndexedDB clock/outbox and chat-wide event projections.
- The doctor/setup flow does not yet install the runtime over SSH; the steps above are manual until it does.
- The machine-owned three-hour AWS idle stop and scoped phone wake still need implementation and verification; the desktop timer does not protect against the desktop dying. The current manual QA deployment is not an always-on production installation.
- The legacy worker path and the cloud-only prompt branch remain until the cutover commit removes them.
