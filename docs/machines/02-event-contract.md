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
boundaries, back deltas (retired 2026-10-01 for chat change events, below),
terminal outcomes and terminal acknowledgements. Their
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

Approval requests, updates, decisions and results also use this channel. A
decision is saved locally before feedback; the machine records a durable native
effect claim after validation and before applying it. Delivery retries never
repeat that effect, and a lost execution receipt is reported as uncertain.
The source stores the matching result before acknowledging it.

Machine progress now uses signed `machine.turn.progress.delta` events with
per-run sequence/parent identities, text suffix replacements and activity-row
changes. Only text snapshots coalesce; observed tool transitions and the final
short burst precede the terminal. The local projection stores event references
and overlays pending messages on reads, so a desktop restart does not erase
already stored partial output. A machine recovers its published local frames
before native-run recovery; received frames still follow channel gap rules.

Artifact mutations now use the same writer and receiving adapter in desktop and
headless runtimes. Collection, metadata, draft save/submit/withdraw, publication,
revision and signature changes commit with their outgoing event. Draft events
carry the complete resulting draft, its identity and reader ACL; version events
carry the complete version, with initial publication metadata and source
references. Signatures carry only signer, signed time and immutable version id
plus content hash. Large bodies use the same durable fragments; a short chat
note or a content hash alone is not a substitute for the body. Receiving an
artifact event refreshes the open desktop panel, including late signatures.

This is not the complete event-contract cutover: PWA IndexedDB outbox,
canonical chat-wide roster fan-out for artifacts (chat changes have it, see
below), general conflict projections and superseded-revision navigation,
pressure UI and history/blob garbage collection outside chat changes remain. Draft-state events are refolded in total order; revision storage binds
signatures to immutable revision identities and content hashes.
The retained history and blob fragments currently stay in local SQLite after
ACK for origin repair. No relay deployment is needed for these changes.

### Chat change events: every chat on every machine, 2026-10-01

Machines hold every chat of their owner, whether or not a member of that chat
runs on them, so their members can search every chat of a project (the User's
decision of 2026-09-22; it replaces "local-only conversations stay outside
sync"). The only way a machine gets chat state is events through the relay,
plus one direct copy at setup (below).

- **One event per save.** Every chat save writes one signed `chat.changes`
  event in the same SQLite transaction as the save (`chatChanges.ts`,
  `chatChangeTransport.ts`): a crash loses both or neither. The log scope is
  `chat-changes:<chatId>`, one sequence per author. The payload lists what that
  save changed: `conversation.created` / `conversation.updated` (shared fields
  only), `message.created` / `message.updated`, `message.reactions` (adds and
  removes) and `message.removed`. The diff is taken against what the database
  held before the save, so a restart never turns into "every message changed".
  Saves of device-local state (run state, sessions, leases, queue positions,
  local paths) produce no event; an applied incoming change is saved without
  being sent again.
- **Who may change what.** A message's content and status come only from its
  author: the device it was typed on, or the member's home machine for that
  member's replies. A member's message is added only by its home machine or by
  the desktop that dispatches it; a message is removed only by the desktop or
  by the device that may change it. Reactions come from anyone and merge; a
  removal is a union. A chat's shared fields (title, members, project,
  archived, app-tool grants) come only from the desktop, and so does a new
  chat: every chat starts on the desktop. A member's turn that never left the
  desktop (refused, or stopped while being prepared) is settled by the
  desktop; its home machine only ever had the empty bubble. Changes from
  anyone else are ignored and logged. A chat id from another device must be a
  plain token, because it names a directory on every device.
- **Order between authors.** A change written on a machine names the desktop
  change of that chat it was written after. Another machine that has not
  applied that one yet holds a change it would otherwise refuse (a member it
  does not know yet, a home that has just moved) until it has; a change that
  applies anyway is not held, and a held one is tried again only once more of
  the desktop's changes have arrived (trying means reading the whole chat). A
  change of a newer version than a device folds waits there, unapplied, until
  that device is updated.
- **Recipients.** The desktop addresses every enrolled machine, online or not,
  and keeps each change until that machine confirms it. One whose runtime
  cannot fold chat changes yet (its hello says so) is sent none of them, by
  the desktop or by another machine (the roster says which can), and gets
  them all, in order, once it can: no machine is ever left with a gap. Kept
  changes are left out of what is sent at all, not read and skipped on each
  pass, and those a setup copy already contains are confirmed once the
  machine has imported it rather than sent after it. The list is read from
  the stored machines before any chat is saved, so a save made while machines
  are still connecting reaches them too, and a machine stays on it through a
  disconnect until it is removed. A machine addresses the desktop and every
  machine in its trust roster; the roster says which machines can read chat
  changes, and is sent again when that changes (at setup, or in a hello). The
  desktop also forwards each change a machine wrote to every other machine,
  unchanged and signed by its author; a machine accepts such a forward only
  when the author is one of the owner's machines. A missing change can be
  served by any device that holds it, so an author that is off does not hold
  the others back.
- **Turns.** A turn request names the newest chat change the machine must have
  applied first. The machine waits for it, and fails the turn honestly after
  10 minutes instead of running on stale messages. A phone's request names no
  change; the machine waits for the message the turn answers. A machine whose
  runtime cannot fold chat changes yet is sent no turn: the turn fails, saying
  that the machine is updated the next time it is connected and idle.
- **First copy.** At setup, and at the first upgrade of a machine that never
  had one, the desktop copies every chat over the setup SSH connection while
  the machine's runtime is stopped: chats with their shared state, artifacts,
  deletion records and pictures (`chatCopy.ts`). Order: the machine's identity
  is read and recorded, so every later change is addressed to it; saves already
  in flight are waited for; the copy's marks (the newest change per chat and
  author) are read; then the chats are exported. The machine continues from the
  marks; a change the copy already contains is confirmed when it arrives
  without being applied again. Changes other machines wrote that the desktop
  holds beyond the marks are shared with the new machine as events. The copy
  says which device wrote each message, so a machine keeps what it wrote
  itself (its members' replies, a phone's messages typed into it) and the
  reactions its members made; a member that watches a chat from the machine
  starts caught up rather than answering what was said before the copy.
- **Cleanup.** A chat change every recipient has confirmed (and this device
  applied, if it came from elsewhere) is forgotten after a day; the newest
  event of each chat and author stays, because the next one continues its
  sequence. A machine that never confirms keeps its share waiting: once every
  10 days the User is asked about each machine inactive for 10 days or more,
  and "Remove" takes it out of the app, drops what was kept for it, and stops
  offering the other machines what it wrote (they no longer trust its
  signature). A removal the app stopped in the middle of is finished at the
  next start. A machine that connects while the question is open is in use,
  and the question is withdrawn. Known limit: what the removed machine wrote
  that another machine had not received yet stays missing on that machine
  (seen in QA as an empty reply bubble there); the desktop's chat, the one
  the User sees, has it. Closing it would make the desktop the writer of a
  removed machine's members' messages. A machine whose runtime is never
  updated keeps its share of every change on this desktop until it is updated
  or removed.
- **Retired.** `machine.conversation.sync`, `.delta` from the desktop,
  `.sync.done` and `.resync` are no longer sent; one that still arrives from an
  older peer is logged and ignored. A `.backdelta` from a runtime that has not
  been updated (or one it queued before its update) is stored, limited to that
  machine's own members' messages and what it created itself.
- **Phone.** A phone that talks to a machine while the desktop is away still
  sends its message as a `.delta`, which may carry only the User's own
  message; a machine that does not hold that chat yet keeps it (and the turn
  behind it) until the chat arrives. The phone receives the machine's own
  chat changes (shared in the machine's room while the desktop has not
  confirmed them) to show its members' messages and choices, in the order
  they arrive: what it missed went to the desktop, so no gap holds them. A
  change that arrives after a newer one for the same message (a late copy, a
  resend) does not put the older text back.

## 5. Channel and repair

- The relay room is extended from `desktop | phone` to addressed enrolled devices (any number), with per-connection generations and fan-out to all peers; the mailbox stays the delivery buffer with cursor reads; the relay assigns no order and applies no rules (the `arrivalSeq` is a cursor, never an ordering key).
- Catch-up on reconnect: mailbox cursor read (`afterArrival`), then per-origin `afterSeq` reads for detected gaps, then `sync.resend.requested` to the origin when the mailbox no longer holds the range.
- Resend reproduces the identical events (same `eventId`, `originSeq`, `logicalTs`), so merge order is identical however an event arrived.
- Sealing, enrollment, revocation (`device.capability.revoked` with `effectiveAfterLogicalTs`), and tombstones stay as today. Every chat goes to every enrolled machine (§4, chat change events).

## 6. Merge, supersede, receipts, signatures

- Every machine folds the union of events it holds in the total order of §2. Precondition-bearing events are validated against the state produced by the events before them; a failing event is marked **superseded** (with the winning event id) identically on every machine, and its author sees it on their own surface after merge. Duplicate `commandId`/`operationId` are idempotent.
- **Supersede changes projections only.** `receipt.native` events are immutable facts; re-projection never re-runs anything. A `permission.decided{deny}` that sorts before an `approve` already answered to the provider (a `receipt.native{permissionAnswered}` exists with the same `requestId`) does not undo the action: the projection shows both and marks the later-sorted decision superseded.
- **Artifacts.** A version is identified by `versionEventId` + `contentHash`; the displayed number is a projection. `artifact.signed` binds to `versionEventId` + `contentHash`, never moves, and signatures from different signers on the same version accumulate. Two offline "v2" revisions: the earlier-sorted `artifact.revised` wins; the other is projected as a superseded revision, and a signature made on it stays bound to it and does not count toward the winner. Drafts keep the existing reader ACL; draft bodies travel as sealed events readable by the user's devices only (all devices of one user share the pairing keys, as the phone does today).
- **Turns.** Exactly one `turn.started` per `commandId`; a `turn.requested` for a participant whose home is offline stays "waiting for \<machine\>" and is executed once when it returns; `turn.cancel.requested` is honored by the home machine with a native interrupt plus process-tree termination (probe findings), then `turn.finished{interrupted}`.

## 7. What each machine stores

- Its copy of every chat of its owner, whether or not one of its members takes part (events + projections in SQLite), its outbox, its receipts, its executor generations and process-group records, its provider sessions.
- A controller device (phone) stores its outbox and a display cache only.

## Relay tunnel client note (2026-09-06)

A socket the tunnel client has already moved on from (replaced by a newer connection, or closed and reconnected before the old close arrived) must never start another dial: the second dial evicts the live socket at the relay with code 4001, whose close dials again, and the two sockets evict each other forever. `RelayTunnelClient` now ignores the close of a socket that is no longer current (`scripts/relay-tunnel-client.test.mjs`, "does not dial again for a socket it already replaced"). The phone↔desktop tunnel uses the same client, so this fix applies there too.
