# Machine member ownership verification — 2026-09-11

## Change and review

A copied roster supplies context; only a member's home may start its native
session, infer requests from its output, resume it, or advance its watcher.
Direct, inferred, and approved requests share the same per-home dispatch path.
Receivers reject foreign targets before starting any member. An unavailable
machine link cannot fall back to the desktop CLI.

Reviewed the full diff with the gstack review checklist, including session
entry points, request creation/approval/delegation/replies, copy completion,
watcher cursors, cancellation, and restart. Review and real QA also caught and
fixed request rows being watched twice and a machine watcher failing to wait
for a desktop member's pending response. No remaining findings in this change.
These preserve existing idle-watcher and local/cloud behavior; no new product
exception, storage schema, or wire format is introduced.

## Automated checks

- `make typecheck` and `make build`: pass on the final tree.
- Focused `chat.permissions` routing/request/auto-watch selection: 57/57 pass.
- `npm run test:machines`: 92/92 pass.
- Broader chat permissions, request threads, delegation status, and native CLI
  selection: 439 pass, 2 skipped, 1 failure. The failure is `tool permission
  request denies and marks approval on timeout`; its `undefined` versus
  `pending` assertion reproduces on an independently compiled, unchanged
  `3407c58` baseline. It is not reported as a passing suite.

## Real surface

Used Electron 31.7.7 with an isolated profile and a separately running built
machine runtime, both on macOS arm64, over the production WSS relay and real
Codex CLI sessions. Configured members, enabled watchers, and submitted messages
through the Electron UI; checked saved outcomes and each process's native-run log.

- Original scenario: machine member answers; desktop watcher runs on the desktop
  once, with no attempt to start that member on the machine.
- Direct MCP request: machine member asks desktop member; `REQUEST_HOME_OK`
  returns to the requester. Its source/request rows do not also trigger a watch.
- Inferred request: one inferred batch, desktop reply `INFERRED_HOME_OK`, and
  requester continuation `INFERRED_REQUEST_DONE` on the machine.
- Opposite watcher location, final build: desktop replies `FINAL_DESKTOP_OK`;
  exactly one machine-owned watcher trigger contains both the user message and
  that completed reply. No early watcher run while the desktop is pending.
- Restart of both processes preserves the cursor and replays no prior turns.
- Native logs contain only desktop-member sessions on the desktop and only
  machine-member sessions on the machine.

An earlier interrupted QA session was blocked by an unclosed native-supervisor
record; the request test was completed with a fresh QA participant instead of
altering that record. Normal shutdown/restart subsequently passed.

## Data size and destinations

The affected real chat had 445 stored message rows totaling 7,004,767 bytes and
five members; the containing database was 3.4 GiB. The new reconciliation builds
a temporary set of user-message IDs, not copies of message bodies. Watcher
cursors remain small per-member metadata in SQLite. Delegation still carries
the existing request row and its source through the existing event/fragment
transport; no whole-chat snapshot or growing command-line argument was added.

This proves the desktop and separate machine-runtime path, not deployment to
the user's AWS instance or a physical phone. No release, push, or live service
upgrade is part of this change.
