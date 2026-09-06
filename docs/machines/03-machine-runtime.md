# Machines transport — the machine runtime

A **machine** is a computer that runs AccordAgents without a window and hosts chat members. It is the same application code the desktop runs (`src/machine/main.ts` composes the same services through `src/main/platform.ts`), enrolled with one desktop through a machine-host pairing, and reachable only through the relay. There is no worker, no SSH turn pipeline, and no shared store: the machine keeps its own copy of the chats it hosts, its own provider sessions, and the settings the desktop sends it.

## What travels between the desktop and a machine

Every message is sealed with the pairing's key inside the machine's own relay room (`src/shared/machineLink.ts`):

| Direction | Message | When |
|---|---|---|
| machine → desktop | `machine.hello` | on every (re)connect: device id, name, app version, platform, installed providers |
| desktop → machine | `machine.hello.ack`, `machine.settings.sync` | after hello; the settings snapshot (roles, rules, saved prompts, member presets, limits, agent environment values) also travels with every turn request |
| desktop → machine | `machine.conversation.sync` / `machine.conversation.delta` | full copy the first time a chat reaches the machine, changed messages afterwards; the machine keeps its own `participantSessions`, `activeRunIds`, `running`, `runId` |
| desktop → machine | `machine.turn.request` | the member's home is this machine: run this member for this message, with the desktop's run id and pending message id |
| machine → desktop | `machine.turn.progress`, `machine.turn.finished` | streamed progress and the finished messages (same ids on both sides) |
| desktop → machine | `machine.turn.cancel` | Stop |

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

## Where the machine keeps data

Under the user-data directory: `accordagents.sqlite3` (its copy of the chats it hosts, artifacts, chat events), `settings.json` (the desktop's shareable settings plus the machine's own records), `machine-secrets.key` (0600; seals the machine's secrets), `chats/<id>/` (history files the CLIs read), `debug-logs/`.

## Local QA on one Mac

`scripts/probes/machines/` holds the drivers used for the end-to-end check: a relay under `wrangler dev` (`--port 18099`), an isolated desktop (`ACCORDAGENTS_USER_DATA_DIR=/private/tmp/accordagents-qa-machines ACCORDAGENTS_MOBILE_RELAY_URL=ws://127.0.0.1:18099/v1/relay npx electron . --remote-debugging-port=9223`), `qa-create-machine.cjs` (mints the enrollment through the bridge), the machine runtime started with that enrollment and its own user-data directory, `qa-wait-machine.cjs`, `qa-machine-turn2.cjs <marker>` (a member turn through the real UI), and the Stop scenario. Loopback `ws:` relays are accepted only for `127.0.0.1`/`localhost`.

## Not yet on machines (tracked, next)

- App-tool approvals and user choices raised by a member on a machine are answered on the machine's copy only; forwarding them to the desktop (and the decision back) is the next slice.
- A machine-hosted member's requests to other members run on the machine's copy; routing them to the other members' home machines follows the event contract (`docs/machines/02-event-contract.md`).
- The doctor/setup flow does not yet install the runtime over SSH; the steps above are manual until it does.
- The legacy worker path and the cloud-only prompt branch remain until the cutover commit removes them.
