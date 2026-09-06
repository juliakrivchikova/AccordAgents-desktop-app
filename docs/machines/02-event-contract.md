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

Implementation checkpoint (2026-09-06): `StorageService.appendChatEvents` now
persists the global accepted-event clock floor in the same SQLite transaction as
the events, including phone mailbox ingress. Rejected conflicts do not advance
it; duplicate delivery retains the original timestamp. `ChatEventLogService`
restores that floor before every local mint and ticks strictly after it, across
chats and process restarts. This lazily performs receive advancement at the next
mint. The one-time upgrade reads at most 500 event headers per batch, including
legacy `createdAt`, without transferring payloads into Node; ongoing writes add
one small clock row, independent of chat size. Corrupt clock state refuses new
events instead of silently resetting their order. This covers the signed event
log; the direct machine-link protocol still needs conversion to durable events
and the PWA still needs its IndexedDB clock/outbox.

Measured on the current user database (read-only): 58,976 event rows in a
3,671,216,128-byte database; the actual upgrade query took 19.1 s, transferred
13.75 MB of headers in batches no larger than 117,001 bytes, and transferred no
message bodies. Concurrent first receives share that upgrade pass. It is a
one-time cost, not work on each snapshot; large-chat replication costs are
unchanged by this clock change. The clock is stored only in the machine's local
SQLite `schema_meta`; existing signed envelopes keep their current sealed
mailbox destinations.

Event commits and clock initialization request SQLite `synchronous=FULL` and
`fullfsync=ON`; the normal conversation-save setting is unchanged. `NORMAL`
in WAL mode can lose a committed transaction on power loss, so it cannot back
an event that has already been published ([SQLite's durability contract](https://www.sqlite.org/pragma.html#pragma_synchronous)).
The 84-test storage suite covers failed clock writes rolling back the event,
restart into another chat, legacy upgrade, concurrent first receives, corrupt
clock refusal, overflow, and conflicting duplicate IDs within one batch.
Real Electron + the published PWA in an isolated browser profile + the public
relay + a separate Mac machine runtime passed before and after an Electron
restart: one user message and one completed machine reply on both surfaces.
This browser check does not replace the physical-phone cutover gate.

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

### Implemented delivery foundation, 2026-09-06

`DeviceEventChannel` now carries machine conversation copies, deltas, copy
boundaries, back deltas, terminal outcomes and terminal acknowledgements. Their
signed envelopes and recipient outbox rows commit together in local SQLite with
the accepted clock floor before either live-room or sealed-mailbox transmission.
An event keeps its identity and ordering on retry; the receiver stores ingress
before applying it and acknowledges only after its domain owner confirms saving.
Separate conversation streams cannot apply across a gap, but a failing chat does
not hold other chats. A deferred live terminal is acknowledged after ChatService
saves it; a late terminal saves the messages and final run state together.

Bodies over 32 KiB use immutable SHA-256 references and 384 KiB raw fragments in
the same local database. Every fragment must be durable and the assembled body
must match its hash before apply. Missing ranges or expired fragments request the
original retained events. The relay's arrival cursor advances after durable
ingress, independently of a failed domain projection; failed ingress holds it.
Receiver receipts also form a local outbox, so failed ACK delivery survives
restart. Small header probes repair expired events or ACKs even when peers never
overlap online; normal delivered bodies are not uploaded again on every poll.
Mailbox acceptance, peer acknowledgement and application remain distinct.

Native dispatch, Stop, started-state feedback and encrypted settings now use this
channel too. Dispatch acceptance and executor claims have a separate durable
ledger; process-loss recovery never repeats already claimed native input and
requires verified guardian closure before relinquishing an old executor.
Settings are encrypted before they enter the immutable event/blob store.

This is not the complete event-contract cutover: approvals and progress still
require conversion; PWA IndexedDB outbox,
canonical chat-wide roster fan-out, pure conflict projections, hash-bound
artifact signatures, pressure UI and history/blob garbage collection remain.
The retained history and blob fragments currently stay in local SQLite after
ACK for origin repair. Replication inventory and partial-copy barriers also
survive machine restart. No relay deployment is needed for these changes.

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
