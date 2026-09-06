# Machines transport — the machine runtime

A **machine** is a computer that runs AccordAgents without a window and hosts chat members. It is the same application code the desktop runs (`src/machine/main.ts` composes the same services through `src/main/platform.ts`), enrolled with one desktop through a machine-host pairing, and reachable only through the relay. There is no worker, no SSH turn pipeline, and no shared store: the machine keeps its own copy of the chats it hosts, its own provider sessions, and the settings the desktop sends it.

## What travels between the desktop and a machine

Every message is sealed with the pairing's key inside the machine's own relay room (`src/shared/machineLink.ts`):

| Direction | Message | When |
|---|---|---|
| machine → desktop | `machine.hello` | on every (re)connect, including the machine's own link coming back: device id, name, app version, platform, installed providers, runtime instance id, active runs, results waiting in the outbox |
| desktop → machine | `machine.hello.ack`, `machine.settings.sync` | after hello; the settings snapshot (roles, rules, saved prompts, member presets, limits, agent environment values) also travels with every turn request |
| desktop → machine | `machine.conversation.sync` / `machine.conversation.delta` | the first time a chat reaches the machine: the conversation shell, then its messages in bounded batches (at most 150 messages / ~1.5 MB of JSON per relay message, so a chat of any size stays under the relay's 10 MiB limit); changed messages afterwards, batched the same way. The machine keeps its own `participantSessions`, `activeRunIds`, `running`, `runId`, `pendingAppToolApprovals`; approval policies are the union of both sides. A fresh copy after a reconnect never erases messages the machine produced meanwhile. |
| desktop → machine | `machine.turn.request` | the member's home is this machine: run this member for this message, with the desktop's run id and pending message id. Settings sync and replication precede it; a Stop that lands during that preparation means the request is never sent. |
| machine → desktop | `machine.turn.progress`, `machine.turn.finished` | streamed progress and the finished messages (same ids on both sides), sent in order. The machine keeps a finished turn in its outbox (`machine-outbox.json` under its user data, so it survives a restart of the runtime) and resends it on every hello until the desktop answers `machine.turn.finished.ack`; a desktop that finds no pending turn for it (restart) lands the messages as a back-delta. |
| desktop → machine | `machine.turn.finished.ack` | the finished turn is applied on the desktop; the machine drops it from its outbox |
| machine → desktop | `machine.conversation.backdelta` | messages the machine wrote outside a turn result (mid-turn `app_chat_send_message`, artifact notes) |
| machine → desktop | `machine.approval.requested` / `machine.approval.updated` | a member on the machine needs a permission or app-tool approval: the desktop shows the same card it shows for a local member, tagged with the member's home machine |
| desktop → machine | `machine.approval.decision` | the User's whole card answer (approve/deny, scope, an edited Codex proposal, the native decision id); the machine applies it through the ordinary approval path and the member resumes |
| machine → desktop | `machine.approval.result` | outcome of applying that decision; the desktop's card call resolves or fails with it. After a reconnect the machine offers every approval it holds again, so one raised while the desktop was away is not lost |
| desktop → machine | `machine.turn.cancel` | Stop. If the machine is unreachable or does not confirm within a few seconds, the bubble shows "Stop requested — waiting for machine <name>" (Rule 2, an approved parity exception in `docs/parity-requirements.md`); the stop is kept and delivered again on the machine's next `machine.hello`, and "stopped by user" appears only after the machine confirms. A held stop is stored in the machine's record on the desktop, so it survives a desktop restart. A hello carries the runtime's `instanceId` plus `activeRunIds`/`pendingTerminalRunIds`: only a turn dispatched to a previous instance whose result is not in the new instance's outbox is closed on the desktop, and it is closed as failed ("restarted before confirming the stop"), never as "stopped", because a restart proves nothing about the run's processes. |

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

Under the user-data directory: `accordagents.sqlite3` (its copy of the chats it hosts, artifacts, chat events), `settings.json` (the desktop's shareable settings plus the machine's own records), `machine-secrets.key` (0600; seals the machine's secrets), `machine-outbox.json` (finished turns not yet acknowledged by the desktop), `chats/<id>/` (history files the CLIs read), `debug-logs/`.

## Local QA on one Mac

`scripts/probes/machines/` holds the drivers used for the end-to-end check: a relay under `wrangler dev` (`--port 18099`), an isolated desktop (`ACCORDAGENTS_USER_DATA_DIR=/private/tmp/accordagents-qa-machines ACCORDAGENTS_MOBILE_RELAY_URL=ws://127.0.0.1:18099/v1/relay npx electron . --remote-debugging-port=9223`), `qa-create-machine.cjs` (mints the enrollment through the bridge), the machine runtime started with that enrollment and its own user-data directory, `qa-wait-machine.cjs`, `qa-machine-turn2.cjs <marker>` (a member turn through the real UI), `qa-machine-approval.cjs` (a permission approval answered on the desktop for a member on the machine), `qa-machine-stop.cjs` (Stop, no orphaned processes), `qa-machine-stop-unreachable.cjs` (Stop while the machine process is frozen: waiting state, then confirmation), and `qa-machine-second-turn.cjs <conversationId> [marker]` (a second turn on the resident session). Loopback `ws:` relays are accepted only for `127.0.0.1`/`localhost`.

## Not yet on machines (tracked, next)

- User choices (`User choice:` blocks) raised by a member on a machine reach the desktop as ordinary messages; the answer travels back as the next user message, which is the same round trip a local member gets. Nothing else is forwarded for them yet.
- A machine-hosted member's requests to other members run on the machine's copy; routing them to the other members' home machines follows the event contract (`docs/machines/02-event-contract.md`).
- Delivery of a finished turn is retried until the desktop is back; delivery of every other event is not yet acknowledged (the outbox/ack of the event contract is the next slice).
- Inbound replicated messages are not yet observed by the hybrid logical clock on the receiving side.
- The doctor/setup flow does not yet install the runtime over SSH; the steps above are manual until it does.
- The legacy worker path and the cloud-only prompt branch remain until the cutover commit removes them.
