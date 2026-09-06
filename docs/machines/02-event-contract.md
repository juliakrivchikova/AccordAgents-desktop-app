# Machines transport — step 1: event contract (ids, delivery states, merge)

Companion to `01-native-control-probes.md`. This is the contract work items 3–5 of the resolution implement. Everything here builds on what exists: the signed `ChatEventEnvelope` (`src/shared/chatEvents.ts`), the projector with per-origin gap and fork detection (`src/shared/chatEventProjection.ts`), device capability grants (`src/shared/chatDeviceCapabilities.ts`), residency (`src/shared/chatEventResidency.ts`), the sealed mailbox with server-stamped `arrivalSeq` and TTL retention (`cloudflare/relay/src/index.ts`), and per-device ed25519 identities (`ChatEventLogService`).

## 1. Identities

| Id | Meaning | Source |
|---|---|---|
| `originId` | One device or machine: `device-<sha256(publicKey)[0:32]>`; also the signing identity (`keyId`). A machine is a device that hosts participants. | `createChatEventDeviceIdentity` (existing) |
| `conversationId` / `logScopeId` | The chat and its log scope (today `logScopeId === conversationId`). | existing |
| `participantId` | A participant of the chat; its **home** is one `originId` (`participant.homeOriginId`, replacing `remoteExecution`). | new field on `ChatParticipant` |
| logical session id | `${conversationId}:${participantId}`; the provider session/thread id (`sessionId`) is a property of it and may change on native resume. | existing `participantSessions` |
| `runId` / `turnId` | One turn of one participant. Codex: `turn.id` from `turn/start`; Claude: assigned by the home machine per `user` message it writes (`turn-<uuid>`), correlated by `session_id` and order. | existing `runId` |
| `commandId` / `operationId` | Idempotency key of a request-like event (turn request, Stop, decision, draft op). Retries reuse it; receivers dedupe on it. | new |
| `eventId` | `evt-<uuid>`; unique per event; the outbox and the mailbox dedupe on it. | existing |
| `executorGeneration` | Monotonic counter per logical session on its home machine, bumped when a provider process is (re)started; every receipt carries it. | new |

## 2. Envelope and clocks

The envelope is unchanged in shape. `logicalTs` becomes a **hybrid logical clock** key:

```
hlc:<wallMs 13 digits>:<counter 6 digits>:<originId>
```

- Each machine keeps `(wallMs, counter)`; on every event it emits: `wallMs = max(now, lastWallMs)`, `counter` increments when `wallMs` did not advance; on every event it **receives** it advances to `max(local, received) + 1 counter`. A machine that was offline therefore cannot emit an event that sorts before what it has already seen.
- Fixed-width digits make plain string comparison the clock comparison.
- **Legacy `logicalTs`** (`<seq 16 digits>:<originId>:<scope>`, produced by the mirror and by the mobile runner) is mapped by the comparator to `hlc:<Date.parse(createdAt)>:<originSeq mod 1e6>:<originId>` so old and new events interleave by time deterministically on every machine. Legacy logs are mirrors, not sources of truth, so this changes no user-visible state.

**Total order** used by every machine: `hlcKey`, then `originId`, `logScopeId`, `originSeq`, `eventId` (`compareEventsForProjection`, updated).

**Per-origin contiguity** is kept: an origin's events are applied only in `originSeq` order; a missing sequence is a gap (`ChatEventVisibleScopeGap`), events after it are held, and repair is requested (§5). Forks (two events with the same `originSeq` from one origin) are rejected as today.

## 3. Event kinds

Existing kinds stay (`message.created`, `message.updated`, `conversation.metadata.updated`, `device.capability.granted|revoked`, legacy import kinds). New kinds, all in the same envelope:

| Kind | Emitted by | Payload (essentials) | Precondition at apply |
|---|---|---|---|
| `turn.requested` | any device/machine | `commandId`, `participantId`, `homeOriginId`, `messageId` (the user message), `steerOfTurnId?` | participant home matches; dedupe on `commandId` |
| `turn.started` | home machine | `turnId`, `commandId`, `executorGeneration`, `sessionId`, `providerTurnId?` | — |
| `turn.progress` | home machine | `turnId`, activity rows and text deltas (coalesced ≤ 100 ms; terminal/approval/tool-identity rows never dropped) | `turnId` known |
| `turn.finished` | home machine | `turnId`, `status: completed \| interrupted \| failed \| uncertain`, final message id, `sessionId`, `contextUsage`, `warnings` | one per `turnId` (dedupe) |
| `receipt.native` | home machine | `turnId`, `executorGeneration`, `itemId`, `phase: started \| completed`, `itemKind` (command, fileChange, mcpToolCall, permissionAnswered…), `outcome?` | **immutable**; never superseded; a `started` without `completed` at process loss becomes `turn.finished{status: uncertain}` |
| `turn.cancel.requested` | any device | `commandId`, `turnId` | idempotent; visible as "stop requested" until `turn.finished{interrupted}` (Rule 2) |
| `permission.requested` | home machine | `requestId` (= provider request id), `turnId`, `executorGeneration`, native options and scope, `expiresAt?` | — |
| `permission.decided` | any device | `requestId`, `decisionRevision`, decision, `decidedBy` | first decision in total order wins; later ones → superseded; a decision for a request from an older `executorGeneration` is rejected |
| `choice.requested` / `choice.answered` | home machine / any device | `choiceId`, options / `optionId` | first answer wins |
| `request.created` / `request.answered` / `request.cancelled` | any | participant-request lifecycle (existing metadata as payload) | lifecycle order per `requestId` |
| `artifact.created` / `artifact.revised` / `artifact.signed` / `artifact.access.changed` / `artifact.draft.saved` / `artifact.draft.submitted` / `artifact.draft.withdrawn` / `artifact.published` | any | `artifactId`, `versionEventId` (= this event's id for created/revised/published), `contentHash`, `expectedHeadVersionEventId` for revise/sign/access, `operationId` for drafts | see §6 |
| `blob.fragment` | any | `blobHash`, `index`, `total`, bytes (≤ 384 KiB, the existing scheme) | an event referencing `blobHash` is applied only after all fragments are stored |
| `ack` | every roster machine | `forOriginId`, `upToOriginSeq`, `logScopeId` | drives outbox retention (§4) |
| `sync.resend.requested` | any machine | `forOriginId`, `fromSeq`, `toSeq`, `logScopeId` | the origin re-appends the same events (idempotent by `eventId`) |

Presence (`machine.hello`, heartbeat) is live-room traffic, not a durable event.

## 4. Delivery states and the outbox

States of one event as seen by its emitter, all visible on the sending surface:

1. **local-applied** — folded into the emitter's own copy; App MCP tool results are returned at this point.
2. **delivered** — the relay mailbox accepted it (`arrivalSeq`); the live room may have fanned it out earlier, which never counts as delivery.
3. **acknowledged by \<machine\>** — that machine appended an `ack` covering this `originSeq`.
4. **applied / superseded there** — derived from the machine's own projection; shown when the machine reports it (acks carry the projection outcome for precondition-bearing events).

The **outbox** persists every event before the first send (Electron: SQLite; PWA: IndexedDB; headless machine: SQLite) and keeps it until every machine in the chat's roster has acknowledged it, independent of relay retention (72 h). Roster machines = home machines of the chat's participants plus machines that opened the chat. Outbox pressure (a roster machine absent for long) is visible in Machines settings.

## 5. Channel and repair

- The relay room is extended from `desktop | phone` to addressed enrolled devices (any number), with per-connection generations and fan-out to all peers; the mailbox stays the delivery buffer with cursor reads; the relay assigns no order and applies no rules (the `arrivalSeq` is a cursor, never an ordering key).
- Catch-up on reconnect: mailbox cursor read (`afterArrival`), then per-origin `afterSeq` reads for detected gaps, then `sync.resend.requested` to the origin when the mailbox no longer holds the range.
- Resend reproduces the identical events (same `eventId`, `originSeq`, `logicalTs`), so merge order is identical however an event arrived.
- Sealing, enrollment, revocation (`device.capability.revoked` with `effectiveAfterLogicalTs`), and tombstones stay as today. Local-only conversations never enter the network.

## 6. Merge, supersede, receipts, signatures

- Every machine folds the union of events it holds in the total order of §2. Precondition-bearing events are validated against the state produced by the events before them; a failing event is marked **superseded** (with the winning event id) identically on every machine, and its author sees it on their own surface after merge. Duplicate `commandId`/`operationId` are idempotent.
- **Supersede changes projections only.** `receipt.native` events are immutable facts; re-projection never re-runs anything. A `permission.decided{deny}` that sorts before an `approve` already answered to the provider (a `receipt.native{permissionAnswered}` exists with the same `requestId`) does not undo the action: the projection shows both and marks the later-sorted decision superseded.
- **Artifacts.** A version is identified by `versionEventId` + `contentHash`; the displayed number is a projection. `artifact.signed` binds to `versionEventId` + `contentHash`, never moves, and signatures from different signers on the same version accumulate. Two offline "v2" revisions: the earlier-sorted `artifact.revised` wins; the other is projected as a superseded revision, and a signature made on it stays bound to it and does not count toward the winner. Drafts keep the existing reader ACL; draft bodies travel as sealed events readable by the user's devices only (all devices of one user share the pairing keys, as the phone does today).
- **Turns.** Exactly one `turn.started` per `commandId`; a `turn.requested` for a participant whose home is offline stays "waiting for \<machine\>" and is executed once when it returns; `turn.cancel.requested` is honored by the home machine with a native interrupt plus process-tree termination (probe findings), then `turn.finished{interrupted}`.

## 7. What each machine stores

- Its copy of every conversation it participates in (events + projections in SQLite), its outbox, its receipts, its executor generations and process-group records, its provider sessions.
- A controller device (phone) stores its outbox and a display cache only.

## Relay tunnel client note (2026-09-06)

A socket the tunnel client has already moved on from (replaced by a newer connection, or closed and reconnected before the old close arrived) must never start another dial: the second dial evicts the live socket at the relay with code 4001, whose close dials again, and the two sockets evict each other forever. `RelayTunnelClient` now ignores the close of a socket that is no longer current (`scripts/relay-tunnel-client.test.mjs`, "does not dial again for a socket it already replaced"). The phone↔desktop tunnel uses the same client, so this fix applies there too.
