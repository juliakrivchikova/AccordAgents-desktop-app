# Machines transport — the machine runtime

A **machine** is a computer that runs AccordAgents without a window and hosts chat members. It is the same application code the desktop runs (`src/machine/main.ts` composes the same services through `src/main/platform.ts`), enrolled with one desktop through a machine-host pairing, and reachable only through the relay. There is no worker, no SSH turn pipeline, and no shared store: the machine keeps its own copy of the chats it hosts, its own provider sessions, and the settings the desktop sends it.

## What travels between the desktop and a machine

Every message is sealed with the pairing's key inside the machine's own relay room (`src/shared/machineLink.ts`):

| Direction | Message | When |
|---|---|---|
| machine → desktop | `machine.hello` | on every (re)connect, including the machine's own link coming back: device id, name, app version, platform, installed providers, runtime instance id, active runs, results waiting in the outbox |
| desktop → machine | `machine.hello.ack`, `machine.settings.sync` | after hello; the settings snapshot (roles, rules, saved prompts, member presets, limits, agent environment values) also travels with every turn request |
| desktop → machine | `machine.conversation.sync` / `machine.conversation.delta` | the first time a chat reaches the machine: the conversation shell, then its messages in bounded batches (at most 150 messages / ~1.5 MB of JSON per relay message, so a chat of any size stays under the relay's 10 MiB limit); changed messages afterwards, batched the same way. The machine keeps its own `participantSessions`, `activeRunIds`, `running`, `runId`, `pendingAppToolApprovals`; approval policies are the union of both sides. A fresh copy after a reconnect never erases messages the machine produced meanwhile, and the machine's inventory of what the desktop holds is kept across syncs, so a reconnect does not send the whole history back. |
| desktop → machine | `machine.turn.request` | the member's home is this machine: run this member for this message, with the desktop's run id and pending message id. Settings sync and replication precede it; a Stop that lands during that preparation means the request is never sent. |
| machine → desktop | `machine.turn.progress`, `machine.turn.finished` | streamed progress and the finished messages (same ids on both sides), sent in order. The machine keeps a finished turn in its outbox (`machine-outbox.json` under its user data, so it survives a restart of the runtime) and resends it on every hello until the desktop answers `machine.turn.finished.ack`. Whatever the status (reply, stopped, failed, stop not confirmed), the machine's copy of the bubble contributes its text and the run's other messages, live or late: a desktop that finds no pending turn for it (restart) folds the result into the chat the same way before acknowledging. |
| desktop → machine | `machine.turn.finished.ack` | sent only after the outcome (reply, stop, unconfirmed stop, failure) has been written to the desktop's SQLite; a failed write sends no ack and the machine keeps the result |
| desktop → machine | `machine.conversation.sync.done` | the first copy (shell + every batch) has been sent in full; only now does the machine compare its own rows against what the desktop holds, so a restarted machine with a full database sends back only rows it made itself. A batch the machine could not store reverts its inventory entries, and the machine answers `machine.conversation.resync` instead of completing; a turn requested before the copy is complete fails honestly |
| machine → desktop | `machine.conversation.resync` | a batch of the first copy could not be stored; the desktop sends the whole copy again from its current state |
| machine → desktop | `machine.turn.unknown` | a stop named a run this runtime does not know (not running, no result waiting): the held stop is dropped and the member's bubble says the stop was not confirmed (Rule 2) |
| machine → desktop | `machine.conversation.backdelta` | messages the machine wrote outside a turn result (mid-turn `app_chat_send_message`, artifact notes) |
| machine → desktop | `machine.approval.requested` / `machine.approval.updated` | a member on the machine needs a permission or app-tool approval: the desktop shows the same card it shows for a local member, tagged with the member's home machine |
| desktop → machine | `machine.approval.decision` | the User's whole card answer (approve/deny, scope, an edited Codex proposal, the native decision id); the machine applies it through the ordinary approval path and the member resumes |
| machine → desktop | `machine.approval.result` | outcome of applying that decision together with the approval and policies as the machine now holds them; the desktop stores them and only then lets the card call return. After a reconnect the machine offers every approval it holds again, so one raised while the desktop was away is not lost |
| desktop → machine | `machine.turn.cancel` | Stop. If the machine is unreachable or does not confirm within a few seconds, the bubble shows "Stop requested — waiting for machine <name>" (Rule 2, an approved parity exception in `docs/parity-requirements.md`); the stop is kept and delivered again on the machine's next `machine.hello`, and "stopped by user" appears only after the machine confirms. A held stop is stored in the machine's record on the desktop, so it survives a desktop restart, and it is kept until the machine answers it (a finished turn or `machine.turn.unknown`); when that answer arrives after a desktop restart, the member's bubble is updated (stopped, or stop not confirmed) and stored before the held stop is dropped. A hello carries the runtime's `instanceId`, `instanceSequence` (a start counter kept in `machine-instance.json`, so instance order does not depend on the wall clock), `instanceStartedAt`, `activeRunIds` and `pendingTerminalRunIds`: only a turn dispatched to a previous instance whose result is not in the new instance's outbox is closed on the desktop, and it is closed as "stop not confirmed" (`terminalReason: stop-unconfirmed`), never as "stopped", because a restart proves nothing about the run's processes; a late hello from an older instance is ignored. Messages from a machine are decrypted and applied strictly in arrival order on both sides. |

Provider API keys, AWS credentials, cloud-run settings, and other machines' records never leave the desktop (`SettingsService.exportMachineSettingsSnapshot`).

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

## Cost on a large chat

Every conversation snapshot on the desktop triggers a replication pass for the chats a machine hosts. A pass compares every message against what the machine holds; the per-message hash is cached per message object and recomputed only when content, status, metadata, or attachments changed in place, and snapshots that arrive while a pass is running collapse into one more pass. The first copy of a 14 000-row chat still travels whole (about 94 batches, ~55 MB sealed, measured by Drew on 2026-09-06); a single message or metadata larger than the relay's 10 MiB logical limit is not split yet.

## Where the machine keeps data

Under the user-data directory: `accordagents.sqlite3` (its copy of the chats it hosts, artifacts, chat events), `settings.json` (the desktop's shareable settings plus the machine's own records), `machine-secrets.key` (0600; seals the machine's secrets), `machine-outbox.json` (finished turns not yet acknowledged by the desktop; an unreadable file is never overwritten, a damaged one is set aside as `.corrupt-<time>`, entries with an unexpected shape are kept in `.rejected-<time>.json`; a failed write is retried every 30 s and reported in the machine's hello, which the Machines settings show as a warning), `machine-instance.json` (start counter, advanced atomically; when it cannot be read or written the machine publishes no sequence and the desktop falls back to the start time), `chats/<id>/` (history files the CLIs read), `debug-logs/`.

## Local QA on one Mac

`scripts/probes/machines/` holds the drivers used for the end-to-end check: a relay under `wrangler dev` (`--port 18099`), an isolated desktop (`ACCORDAGENTS_USER_DATA_DIR=/private/tmp/accordagents-qa-machines ACCORDAGENTS_MOBILE_RELAY_URL=ws://127.0.0.1:18099/v1/relay npx electron . --remote-debugging-port=9223`), `qa-create-machine.cjs` (mints the enrollment through the bridge), the machine runtime started with that enrollment and its own user-data directory, `qa-wait-machine.cjs`, `qa-machine-turn2.cjs <marker>` (a member turn through the real UI), `qa-machine-approval.cjs` (a permission approval answered on the desktop for a member on the machine), `qa-machine-stop.cjs` (Stop, no orphaned processes), `qa-machine-stop-unreachable.cjs` (Stop while the machine process is frozen: waiting state, then confirmation), and `qa-machine-second-turn.cjs <conversationId> [marker]` (a second turn on the resident session). Loopback `ws:` relays are accepted only for `127.0.0.1`/`localhost`.

## Not yet on machines (tracked, next)

- User choices (`User choice:` blocks) raised by a member on a machine reach the desktop as ordinary messages; the answer travels back as the next user message, which is the same round trip a local member gets. Nothing else is forwarded for them yet.
- A machine-hosted member's requests to other members run on the machine's copy; routing them to the other members' home machines follows the event contract (`docs/machines/02-event-contract.md`).
- Delivery of a finished turn is retried until the desktop is back; delivery of every other event is not yet acknowledged (the outbox/ack of the event contract is the next slice).
- Inbound replicated messages are not yet observed by the hybrid logical clock on the receiving side.
- The doctor/setup flow does not yet install the runtime over SSH; the steps above are manual until it does.
- The legacy worker path and the cloud-only prompt branch remain until the cutover commit removes them.
