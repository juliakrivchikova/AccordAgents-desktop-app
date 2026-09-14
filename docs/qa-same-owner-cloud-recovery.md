# Same-owner cloud connection recovery

## Scope and lifecycle

A recreated local machine record must reconnect to the existing installation owned by the same desktop, without replacing its remote enrollment, provider home, sessions or worktrees. An installation owned by another desktop still fails the existing ownership guard.

The setup path is: Cloud run selection → AWS access → SSH probe → bounded read of existing enrollment and immutable channel home ID → compare desktop origin and public key plus remote owner marker → drain the unused local connection → atomically persist the original machine ID, sealed pairing and install record → reconnect → existing ownership guard → normal provider/runtime setup → select the restored machine for the participant → real provider turn.

Recovery changes only a never-connected replacement's identity. Existing connected identities, pending turns/cancels/approvals/choices, conflicting original records, stale input, foreign owners and damaged enrollment are refused. Read-only Diagnostics does not restore or write settings. A late cancelled SSH read cannot commit recovery. Duplicate requests share the durable operation, and both temporary and recovered IDs exclude competing installer work.

## Review

The complete change and its callers were reviewed with the gstack review checklist, including DeviceEventStorage's immutable channel-home constraint, MachineHost hello/turn admission, MachineLink reconnect/replication, CloudRunPreparation's returned machine, installer progress and settings persistence. No unresolved blocking finding remains in the reviewed implementation; real-workflow verification is recorded below.

Two defects found during implementation were corrected before release: joining a duplicate before the first save was durable, and restoring the channel without its immutable home ID. The latter was detected by a real AWS turn, not inferred from component tests.

**How large does this get on actual data?** The inspected desktop settings were 120,499 bytes. Recovery reads at most 64 KiB of enrollment plus one scalar home ID; it does not copy conversation histories or provider sessions. The retained QA provider history was two sessions totaling 180,387 bytes; its checksums were compared before/after.

**Where does the data end up?** The enrollment travels through SSH stdin/private stdout and then encrypted local settings, atomically with its machine/install mapping. It is excluded from progress, diagnostic errors, logs and command arguments. The SQL read is parameterized and uses a read-only connection to the existing database. The remote channel, its event history and native command identities are retained.

## Automated verification

- `npm run test:machine-environments`: 132 passed, covering generated remote scripts, identity recovery, settings/link coordination, concurrency, persistence failure, cancellation and preparation routing.
- `node --test --test-force-exit scripts/machine-link.test.mjs scripts/machine-install-transport-guard.test.mjs scripts/toggle-policy-contract.test.mjs`: 18 passed.
- `make typecheck`, `make build`, `make lint-colors`, `make lint-unused`: passed.
- `make lint-lines`: the same 19 existing oversized renderer files; this change does not edit those files.
- Packaged-ASAR dependency and version inspection: passed.

## Real Electron and AWS verification

The installed beta.8 reproduced the user's exact ownership refusal after removing only the local machine record in an isolated QA profile; the existing AWS installation was retained. The final build then restored the existing channel and original machine ID from that same installation, completed Cloud run preparation without another Codex login, and preserved identical checksums for enrollment, owner marker, authentication and both original session files.

The cloud Codex participant returned `QA_OWNER_RECOVERY_FINAL_OK`, with visible running/streaming feedback and a terminal Idle state. After terminating and reopening the isolated desktop process, the original machine reconnected automatically, the chat history remained present, and the same participant returned `QA_OWNER_RESTART_OK` in that chat.

The real check used the existing shared AWS instance and an isolated QA environment/profile; the user's main application/profile and other remote environments were not changed. Failure-injection tests cover disk errors and foreign owners; those failures were not injected into the user's production environment. The hosted phone PWA was not changed or deployed by this fix.
