# PWA progress — 2026-09-12

Status: implemented locally; desktop/native/relay and browser checks pass.
Not deployed and not verified in the installed iPhone PWA.

## Defects and changes

- `mobileRelayControl.ts`: the initial native `running` event had neither text
  nor an activity label and was dropped as `no-content`. Saved empty pending
  participant messages were also filtered out. Both now produce the existing
  waiting representation, with the participant message and run identities.
- `main.ts`: an explicit phone timeline request used another text-only filter.
  Opening a chat now uses the same projection as snapshots, retaining its
  existing 80-message page rather than reading the full conversation.
- `mobileRelayControl.ts`: live and durable publications shared a deduplication
  record. A live row could suppress its durable counterpart; changing live text
  could also cause the unchanged saved row to be published again. They now have
  separate records, advanced after successful delivery, with terminal snapshots
  releasing the corresponding live record. Failed durable writes remain retryable.
- `mobile-app.js`: inside the existing IndexedDB write transaction, a waiting
  snapshot no longer erases the same participant's live text. Pending updates
  retain that row's thread and start time and cannot replace its terminal.
  Matching includes the conversation, message identity, and run.
- `mobile-app.js`: stream controls and elapsed-time clocks were attached only
  after the initial network synchronization. Cached rows could be visible but
  untappable during those waits. They are now connected before the first render.
- `index.html` / `service-worker.js`: prepare shell v69 with a fresh asset URL
  so an eventual deployment can replace the cached application code.

No provider execution, permission, or cancellation semantics changed.

## Verification

The new projection test failed against the old code because the pending row was
absent. The real relay start test timed out without any initial progress frame.
The browser regression reproduced live text being erased by a delayed waiting
snapshot; all three pass with the fix.
The final cold-open check also reproduced an untappable row; a browser regression
holding the initial WebSocket connection failed before the initialization fix
and passes after it.

`make typecheck` and `make build`: pass.

77 focused tests pass across `mobileRelayControl`, `mobileMailboxOutbox`,
`mobileProgressEnvelopeTracker`, `mobile-chat-isolation.test.mjs`, and
`mobile-shell-contract.test.mjs`. They include initial state, actual relay text,
failed persistence/retry, reconnect, stale/double delivery, completion, cancellation,
chat isolation, and retaining an open stream over reload.
Two existing asynchronous tests now wait for their actual callback/publication
instead of assuming it has completed after one event-loop turn.

Real integration: an isolated Electron app, native Codex, the actual
`relay.accordagents.com` service, and Chrome running the PWA:

- Published PWA plus the updated desktop: waiting row after 211 ms, clicking it
  opens live text before completion, then the actual participant's final answer.
- Updated PWA build on a local QA origin plus the actual desktop/relay: waiting
  row after 226 ms, live commentary, reload retaining the open stream and text,
  Stop through the UI, desktop reporting the native turn stopped, and a terminal
  row on the PWA after 720 ms. Another reload does not revive the pending row.
- Final desktop build: disconnect the PWA, start a native turn with no initial
  reply requested, reconnect and reload while it works; the participant's live
  row is visible and a touch opens it at 5.8 seconds from Send. The same open
  view displays the actual final `QA_COLD_OPEN_FIXED_FINAL` at 30.7 seconds,
  with matching run identity and the Stop control removed.

Screenshots: `screenshots/qa-pwa-progress-start.png`,
`screenshots/qa-pwa-progress-fixed-live.png`,
`screenshots/qa-pwa-progress-fixed-stop.png`, and
`screenshots/qa-pwa-progress-reopen.png` / `qa-pwa-progress-final.png`.

## Review and size

Full progress diff reviewed with the gstack review checklist, including unchanged
callers, the explicit timeline request, durable mailbox sink, terminal retention,
and IndexedDB consumer. The separate text-only timeline request was corrected
during this review. No unresolved finding in the changed path.
The final initialization change was reviewed against its existing click, Stop,
reload, visibility, and clock consumers; it adds no new timer or execution path.

Measured read-only on the actual 517-message chat: serialized history 8,933,363
bytes; the 40-row projection 27,333 bytes, including the current pending row;
largest projected row 1,527 bytes. Live progress still carries one participant
row, performs no full-history/card read per fragment, and does not append growing
text to the durable mailbox. The phone updates the existing IndexedDB row.

## Remaining verification boundary

Chrome is supporting browser evidence, not an installed-iPhone result. Both known
iPhones were reported unavailable by `devicectl`; no physical phone was tested.
The updated desktop and PWA must be distributed before the User's installed
combination can exercise this fix. No deployment, release, or production profile
change was made during this task.
