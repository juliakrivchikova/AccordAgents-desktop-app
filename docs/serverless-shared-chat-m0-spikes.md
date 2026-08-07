# Serverless Shared Chat M0 Spikes

This records the M0 implementation facts for the approved #3 serverless shared chat plan. It is an implementation checkpoint, not a product launch claim.

## Event Envelope

The shared event envelope is implemented in `src/shared/chatEvents.ts` and currently includes `eventId`, `conversationId`, `logScopeId`, `originId`, `originSeq`, `logicalTs`, `kind`, `payload`, `payloadHash`, `prevHash`, `keyId`, `signature`, `eventHash`, and `createdAt`.

Sequences are scoped by `(originId, logScopeId)`. This is required so local-only or capability-hidden events do not create false gaps for peers that cannot see those events.

## CLI Resume Fact Check

Local CLI help exposes resume controls:

- Codex: `resume`, `fork`, `--remote`, and `--remote-auth-token-env`.
- Claude Code: `--resume`, `--continue`, and `--fork-session`.
- agy: `--continue` and `--conversation`.

This proves the commands expose resume handles. It does not prove cross-host session continuity. Runner reclaim must therefore treat provider/CLI resume as verified per provider/session. If cross-host resume is not verified for a participant session, reclaim must visibly start a new session/reset only when policy allows, or stay `waiting for current executor`.

## Storage Measurement

Current worktree size is small enough for local development, but remote workers had stale mirrors and disk pressure before this branch. The active serverless worktree measured:

- repo worktree: 22 MB
- `src`: 8.6 MB
- `src/main`: 3.8 MB
- `src/shared`: 368 KB

The append benchmark used a 752-message, 4.76 MB real-shaped conversation:

- ten legacy append-shaped `saveConversation` writes: 1431 ms
- ten-event batch append: 41.4 ms
- ratio: 34.5x faster in this harness

The implementation keeps the existing `sqlite3` CLI contract for now, but adds WAL, a busy timeout, `synchronous=NORMAL`, and batched append APIs so new event-owned paths do not rely on whole-conversation rewrite.

## Relay Chunk Policy

The relay protocol is written to the smallest accepted provider floor: 10 KB text frames. The conformance helper chunks sealed ciphertext frames with stable frame IDs, resumable cursors, duplicate-frame handling, missing-frame detection, and conflict detection.

Provider facts to revalidate before managed-provider selection:

- AWS API Gateway WebSocket: 32 KB frame, 128 KB message payload, 10 minute idle timeout, 2 hour hard connection duration, oversize closes with code 1009.
- Cloudflare Workers/Durable Objects: strong managed candidate; capability manifest must be measured before selection.
- Ably: mature realtime provider; message size varies by plan and relay history must not become message authority.
- Pusher Channels: mature realtime provider; ordinary event payload floor is 10 KB, so it is the binding floor if kept as an option.

## Relocatable Control Plane Branch

`drew/relocatable-control-plane` remains a reference branch, not a base to merge wholesale. The #3 implementation supersedes it structurally with smaller slices: storage floor, event log, relay protocol, policy extraction, mailbox, runner/provider seam, then lifecycle. Any useful code from that branch should be re-landed only after it fits the new event/relay/provider contracts.

## Managed Relay Operating Model

The final product requires an AccordAgents-managed default relay for AC2. The implementation order is:

1. self-hosted reference relay and conformance suite;
2. provider capability matrix;
3. one managed provider behind the same interface;
4. no end-user relay/provider account in the default QR pairing flow.

No provider account setup, domain purchase, paid service, or irreversible infrastructure action is authorized by this spike record.

## Static Origin And Real iOS QA

Static-origin domain/TLS ownership and physical iOS QA are later gates. They do not block M1/M2 or dark shared-code milestones, but public/default mobile AC evidence cannot be claimed until they are performed on the real target paths.
