# PWA chat isolation — 2026-09-12

Request: messages from another chat appeared inside the open PWA chat. Continue
in `drew/machine-member-ownership`, alongside the existing environment isolation
change. This check does not claim installed-iPhone verification or publication.

## Cause and affected lifecycle

Desktop snapshots and live progress name their conversation; machine events carry
the conversation in their durable envelope. All three paths enter
`handleRelayTimelinePayload`, which stores timeline entries under a conversation
and message identity in IndexedDB. Mailbox replay and machine receipts retain
their existing behavior.

Navigation changes the selected conversation and begins `render`. The heading
was changed before asynchronous outbox/timeline reads completed, leaving the old
rows visible; an earlier read could then overwrite the new view. Reproduced on
the unchanged source with a delayed real IndexedDB callback: the DOM reported
`Chat B` over `ONLY_CHAT_A`, although the database contents still named A.
Separately, the timeline filter included rows with no conversation in every chat.

The fix gives each render a revision, refuses stale commits after asynchronous
reads, clears the previous chat's rows and stream controls on navigation, and
requires exact conversation identity for reading and cleanup. Unscoped legacy
records remain stored but are not assigned to a chat. No new message payload,
database store, or delivery protocol is introduced. The service-worker cache
version advances to v68 so an eventual deployment can replace the cached code.

## Evidence

- `scripts/mobile-chat-isolation.test.mjs`: three reproduced failures before the
  fix; nine scenarios pass afterwards (10/10 including the parent), covering
  delayed A→B and A→B→A reads, loading, Back, open-stream preservation on reload,
  a failed IDB read with an open stream/Stop control, legacy unscoped rows,
  scoped terminal cleanup, interleaved delivery and reload.
- `make typecheck` and `make build`: pass.
- Mobile shell/journal/crypto/machine channel: 32 tests pass.
- `mobileRelayControl.test.js`: 38 tests pass, including unknown/other-chat run
  rejection and relay/mailbox duplicate delivery.
- Mobile timeline browser group: 15 pass; the WebKit case initially could not
  bind port 8181 because a sibling test also uses it. Its separate run passes.
  This was a test-server collision, not a successful initial WebKit run.
- Real desktop/relay verification: PASS on the final source. A fresh, isolated
  Electron profile created two chats and received real Codex replies. Its QR
  paired the locally built PWA in Chrome with `relay.accordagents.com`; each PWA
  send was followed by switching to the other chat while the native answer
  arrived. Both continuations were verified in desktop storage and phone IDB,
  exactly once in their own chat; a DOM observer saw no foreign answers and a
  reload preserved the correct view. Screenshot:
  `screenshots/qa-pwa-chat-isolation.png`. The final run bypassed the local
  service-worker cache to load the final source. Temporary QA profiles were separate from the User's data; their pairing
  was revoked through Settings and their Chrome, Electron and static server were
  stopped afterwards. The root `beta` checkout remains clean at `3d185c1`.
- Additional live stream-opening probe did not complete: it timed out waiting
  for the stream view, while the short native replies themselves arrived.
  A test-script selector quoting error was also corrected. The exact cause of
  the live opening timeout was not established, so this is not claimed as live
  stream/reload evidence. That transition passes the dedicated browser case.

## Review

Applied the gstack `/review` checklist to the complete PWA change, including the
unchanged ingestion, deduplication, cancellation cleanup, navigation and stream
callers. Review found that clearing the stream on the first render would discard
the view saved for a same-chat reload: the new regression failed, then passed
after clearing was restricted to an observed conversation change. No remaining
finding in this diff; the extra live stream probe above and installed-iPhone QA
remain explicit verification gaps. Typecheck and build were rerun after that
correction. The existing environment-isolation edits were preserved.

## Data size and destination

Read-only measurement of the current User chat: 473 messages, 9,658,773 bytes of
history JSON, 451,801 UTF-8 bytes of message content, largest message 9,823 bytes.
The desktop's requested timeline projects up to 80 messages; snapshot publication
projects the last 40. The phone retains accumulated timeline entries in IDB and
reads that store before filtering, so its total retained size cannot be inferred
from the desktop's current batch. The new render revision and DOM conversation
identity are constant-size local state; this fix adds no history copies, SQL
arguments, or network payload growth. The unavailable phone's actual IDB size was
not measured.

## External verification still needed

The reviewed PWA was deployed to the Cloudflare Pages Production branch
`staging` as deployment `d3784ef5-4c58-498d-8252-1fcda560fa2e` on 2026-09-12.
`https://mobile.accordagents.com/` serves cache v68 and its `mobile-app.js`
SHA-256 matches the reviewed local build.

The connected iPhone 17 is paired and wired, but Xcode cannot mount a Developer
Disk Image for its iOS 27 build (`PersonalizedBundleMissingVariantError`). CUA
access to Safari was also denied, so the installed PWA could not be driven or
observed automatically. After v68 was published, the User manually closed and
reopened the installed PWA and switched between two existing chats; she reported
that it looked correct, with no observed cross-chat messages. This is a physical
iPhone smoke check, not automated or exhaustive device evidence. Existing
correctly scoped history is preserved.
