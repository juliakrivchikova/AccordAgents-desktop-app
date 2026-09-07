# Implementation handoff after 29ff1eb

This is an unfinished checkpoint, not a release approval or completed QA.
User transferred the entire remaining implementation back to Taylor on
2026-09-07, prioritizing the basic user flow and conserving Drew's quota.
Continue through implementation, end-to-end QA and self-review in one task;
return a final handoff for Drew's review, not a series of partial review rounds.
Keep the root beta checkout untouched. The checkpoint branch is
`drew/machines-final`, based on Taylor's `29ff1eb`.

## First work

1. Finish the in-progress choice integration and its old tests, then typecheck
   and build the combined tree. The last typecheck failed only in
   `chatActionNativeClaims.test.ts`: it still imports removed
   `createNativeTargetClaims` and passes removed `nativeClaims` options.
   Do not restore the unsafe old path merely to make those tests compile.
2. Run the focused changed-path checks, then the browser machine lifecycle
   with real native continuation after a choice, not just a SQL claim.
3. Complete the main installation/message/response/approval/choice/Stop flow,
   self-review and prepare the beta. Avoid new searches for unrelated edge
   cases. Required external evidence still needs the actual surface, not a
   substituted fixture.

## Choice: integration is unfinished

`chatActionNativeClaims.ts` now contains `MachineChoiceExecutor`, patterned
after `MachineApprovalExecutor`; `ChatService.respondToChoice` gains a guard
after validated saved selection. `chatActionEmitter`, `chatActionEffects`,
the main IPC and shared machine-choice result contract are being connected.
`nativeCommandStore.pendingChoiceActions` was added for recovery.

Finish runtime wiring in `src/machine/main.ts`, host/link result propagation,
startup recovery, and PWA result/card handling; inspect the actual files to
distinguish completed edits from remaining wiring. The existing claim tests
have not yet been rewritten for the new executor. Test the actual ChatService
and SQLite boundary and ensure local IPC does not start a second continuation
alongside the canonical home-machine event.

The old path let desktop IPC directly respond and publish a receipt while the
home also consumed the event. It also claimed execution before domain
validation/persistence, and the generic save wait ignored save failure.
Those are the reasons for the in-progress change, not optional new behavior.

## Delete: implemented, combined validation pending

Storage now commits a tombstone and bounded per-machine delivery intents
with the local deletion. MachineLink drains those intents through the durable
channel and retries after missing connection, write failure or restart.
The host, ChatService and SQL writes guard deleted identities against stale
turns/copies/results. Deletion fanout reaches desktop listeners, renderer and
phone tombstone projection. Renderer/preload/shared notification wiring is new.

The focused delete run passed 12/13; the remaining test expected one closure
proof although startup and ingress legitimately repeat it. That assertion was
corrected, but the final run after this edit is pending. Renderer typecheck
passed. This is not yet real UI QA of deleting a running machine chat.

## Confidentiality: pair-key transport implemented

29ff1eb delivered the new controller keys under the old shared room key, and
machine-to-machine send/receive used different room keys. The checkpoint uses
pinned `@noble/curves` 1.9.7 to convert the existing Ed25519 identities to
X25519 and derive a room/identity-bound pair key locally. No replacement
secret is transmitted in the roster/access package. Native and PWA wrappers,
bundle wiring, settings payload sealing and peer fabric are changed.
Clear envelope public-key identity is a key-selection hint; pinning and
signatures must still authorize the sender. Ordinary content has no shared
room-key transport fallback. Old inner settings ciphertext is accepted only
inside the authenticated pair-encrypted transport for retained-history repair.

Reported focused evidence on this worktree: crypto helper 8, host 7, peer
sealing 2, MachineLink 7 and PWA channel 11 passed; the latter required an
escalated run because sandbox denied listening/process spawn. Mobile bundle
built under native arm64 Node. Later retained-history/delegation probes were
not collected before handoff.

One already-identified revocation issue remains: untrust-device removes the
roster entry but the active mobile pairing may still receive desktop timeline
content and `onPhoneIdentity` can automatically grant the removed identity
again. The planned fix is durable pairing-to-identity binding/revocation,
checked for content and enrollment, with owner-created fresh pairing allowing
explicit re-pairing. It was not yet implemented when handoff interrupted work.
Already delivered plaintext or old ciphertext cannot be taken back.

## Phone fragments: changed after the channel test run

The old ACK handler deleted bytes after the first peer ACK, and blob `take`
deleted bytes before projection/receipt succeeded. Fragments now enter the
journal with event/outbox/clock in one IndexedDB transaction: channel `prepare`
is memory-only and `channels.append` passes prepared fragments to log append.
Receipt/release removes a blob in that same transaction only after its last
event reference is gone, preserving equal-hash incoming/outgoing bodies.
Private room events wait for their named recipients, not unrelated machines.
The unapproved phone-only 8 MiB refusal was removed; larger bodies use the
same 384 KiB fragments as desktop, subject to actual storage failure.

`scripts/mobile-event-log.test.mjs` passed 8/8, including atomic rollback,
partial roster ACK/restart and shared-body receipt failure. JS syntax checks
passed. The modified `mobile-machine-channel.test.mjs` and actual browser
IndexedDB path have not been rerun after these edits. Its blob fixture now
shares the journal port so cleanup is exercised rather than hidden in a
separate Map. Verify this integration first, and do not call it QA-complete.

## Browser harness

`scripts/mobile-phone-machine-e2e.mjs` now uses ephemeral site/CDP ports and
its own Chrome profile, rather than killing whatever owns a fixed port.
Choice proof requires saved answered choice, a non-uncertain receipt and a
new participant response `CHOICE_NATIVE_ORCHID` after the tap. A claim count
alone is not proof. Missing approval/choice/desktop-relearn now fails the run.
The old script could print NOT PROVEN and still end PASS.
The updated harness has not yet run on this combined tree.

## Process tests and environment

Taylor's uncommitted timeout widening was preserved in his checkout and in a
temporary patch, but not adopted here: it is not a demonstrated root-cause
fix. The original `cliAgents.permissions.test.ts` ran outside sandbox on a
quiet machine: 138 total, 136 passed, 2 skipped, no failures (26.7 seconds).
This does not establish why previous loaded runs failed. Avoid concurrent
native lifecycle tests and browser/native QA on this host.

Use native arm64 Node v24.19.0 from the installed NVM tree; default x64 Node
breaks esbuild/Rollup. `node_modules` in this worktree points at the installer
worktree's dependencies. Generated output must be rebuilt; do not trust an
old dist after current changes. Git diff whitespace checks passed.

## External evidence and authority

Signed packaged Settings-to-Linux installation, physically installed PWA/iOS,
real AWS power and long-duration acceptance remain unverified. Chrome and a
reference relay are supporting evidence only. User authorized beta release;
normal signing is within that task, but do not bypass Keychain protection.
The previously rejected persistent IAM credential setup must not be retried,
replaced with an equivalent identity, or bypassed with broader credentials
without the exact required approval. Complete independent work first.
The approved resolution is artifact a6f1e5ad-097e-442f-9396-f7566984a01f v4;
`docs/parity-requirements.md` governs. AWS creation/doctor/setup and BYO SSH
installation stay reachable under Machines; per-turn worker controls stay gone.

Review sizes and destinations explicitly: pair keys are fixed 32-byte values,
deletion intents contain identifiers rather than chats, choice actions/results
must not attach whole conversations, fragment bytes live in IndexedDB/SQLite
and bounded relay fragments, never command arguments. No fresh measurement
against the real multi-gigabyte user database was performed in this checkpoint.
