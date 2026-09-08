# Packaged native participant launch regression

The beta.5 guardian spawned the Electron executable with
`ELECTRON_RUN_AS_NODE=1`, while the packaged executable disabled that fuse.
The guardian never entered its script or confirmed ownership, so both local
Codex and Claude failed before receiving the user's prompt. Development Node
tests and a packaged Settings smoke test did not exercise that combination.

The fix enters the same detached guardian through the signed app launcher,
before desktop initialization, over its private Node IPC channel. Plain Node
machine runtimes retain their standalone entrypoint. The RunAsNode, ASAR
integrity and other release fuses remain unchanged. Stop, process ownership,
provider environment, and durable closure use the existing implementation.

## Repeatable packaging gate

After building a macOS package, run:

```sh
npm run test:packaged-native -- out/AccordAgents-darwin-arm64/AccordAgents.app
```

`signed:mac-arm64` runs this automatically after signature/notarization checks
and before creating the updater ZIP. It requires RunAsNode disabled, sends and
receives 1 MiB through binary IPC, checks durable closure, kills the controller
to test independent cleanup, and reopens the same session after closure.
It rejects the original beta.5 and passes on the fixed signed package.

## Real desktop evidence (2026-09-08)

An isolated signed Electron profile, through the actual chat composer:

- Codex answered `CODEX_PACKAGED_START_OK`.
- Claude answered `CLAUDE_PACKAGED_START_OK`.
- Stop during Claude's next turn closed its process and receipt while Codex's
  separate idle session remained alive.
- Both answered again: `CLAUDE_AFTER_STOP_OK`, `CODEX_SECOND_TURN_OK`.
- Killing the isolated desktop left every provider and guardian gone and all
  process receipts closed, verified using captured PID/start identities.
- Reopening the same profile replayed nothing; both providers answered new
  requests (`CODEX_AFTER_RESTART_OK`, `CLAUDE_AFTER_RESTART_OK`).

Supporting checks: typecheck/build, 37 native-execution cases, including the
41 MiB input regression, disk refusal, shared guardian, cancellation and crash.
The permissions suite completed with `--test-force-exit`: 754 pass, 7 skipped,
one existing timeout-test failure (`undefined` versus `pending`), reproduced
identically on unmodified beta.5. The ordinary command remains held open by
that file's timers; no assertion or product behavior was changed to conceal it.
The fix adds only a fixed launch flag to argv. Conversation data still crosses
bounded 64 KiB IPC chunks; SQLite process receipts contain identities, never
prompts or output. The new gate uses its own temporary database and profile.

Review scope: full diff from beta.5, launcher dispatch, provider admission,
IPC backpressure, Stop/disconnect, persisted ownership, headless entrypoint and
signed release ordering. No changes to provider permission semantics or UI.
This evidence is macOS arm64; it is not Linux or physical-phone QA.
