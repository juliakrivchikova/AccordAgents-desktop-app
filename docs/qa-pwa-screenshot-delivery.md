# PWA screenshot delivery — 2026-09-13

Status: fixed locally; reproduced before the fix and verified afterwards through
the actual Electron app, native Codex, production relay, and PWA in Chrome.
Not published; the User's pause on the beta release remains in effect.
An installed iPhone PWA was not verified in this run.

## Cause and affected path

The reported participant message `3e52aaaa-20f4-4516-b16b-f717311aa4cc`
contains both persisted screenshots, 304,058 and 239,429 bytes. The message
and its attachment metadata were present; the files had not been lost.

1. `app_chat_send_message` imports each image into the conversation's attachment
   storage and saves an `imageAttachments` record on the participant message.
2. The mobile timeline carries attachment metadata. The PWA requests each image
   separately by conversation and attachment ID over the sealed relay.
3. `MobileRelayControlService` can answer those requests, but its construction in
   `main.ts` omitted `readChatAttachment`. Every real request therefore returned
   `reason: unavailable`. The existing service test provided a fake reader and
   did not exercise that missing desktop connection.
4. Opening history also used a separate text-only projection in `main.ts`, which
   discarded attachment metadata. The already pending progress fix replaces it
   with the same bounded projection as live snapshots, including pictures.

The fix wires the existing `ChatService.readChatAttachment` and makes that method
required in `MobileRelayChatSender`. The service still checks pairing scope, and
ChatService checks that the attachment belongs to the requested conversation.
No new image store, provider behavior, or wire format is introduced.

## Verification

- Before: attach the two exact screenshot files through the isolated Electron's
  composer; its paired PWA shows two `Image unavailable` notes, with zero decoded
  image width. The actual native participant finishes its turn normally.
- After rebuilding and restarting only that Electron: reload the same PWA;
  both images decode at 2400 × 1800 and their bytes equal the original files.
- Exact participant path: create a repository-enabled QA chat, send a prompt
  through the desktop composer, and let native Codex call the real
  `app_chat_send_message` with both files. The paired PWA opens that chat and
  renders both images under `QA_PARTICIPANT_SCREENSHOTS`, beside the separate
  final reply `QA_PARTICIPANT_IMAGES_DONE`.
- Fresh history: clear only the isolated PWA's timeline cache, then reload.
  The actual desktop/relay restores four rows, exactly one screenshot message,
  and both original files. No participant is re-run.
- Ownership: ask the real desktop attachment API for an image using the other
  QA chat's ID; it refuses with `Attachment was not found in this conversation`.
  The relay test also checks that a request outside pairing scope never reaches
  the attachment reader, while subsequent valid requests still work.
- Type regression: remove only the new desktop binding in a virtual TypeScript
  compiler host, without modifying files; the original omission now fails with
  TS2345 because `readChatAttachment` is required.

Proof captures, inspected after capture:
`screenshots/qa-pwa-attachments-before.png`,
`screenshots/qa-pwa-attachments-fixed.png`, and
`screenshots/qa-pwa-participant-attachments.png`.

Original and received SHA-256 values:

| Image | SHA-256 |
| --- | --- |
| AWS overview | `2a4660834e736d3d2fc3caada010c94859199b6f5305844b36408bfe09ac4c7a` |
| AWS details | `6f0428083e9396049e5a6c5bdca340a074a66426f852bdc7b73fb6a218004bab` |

`make typecheck`, `make build`, and the 77 focused tests across
`mobileRelayControl`, `mobileMailboxOutbox`, `mobileProgressEnvelopeTracker`,
`mobile-chat-isolation.test.mjs`, and `mobile-shell-contract.test.mjs` pass.
The initial sandbox test attempt failed on localhost `listen EPERM`; the same
tests passed with localhost access.

## Review, size, and destination

Reviewed with the gstack review checklist through the unchanged import,
conversation save/read, pairing checks, timeline projection, encrypted response,
and PWA rendering/cache consumers. No unresolved finding in the changed path.

How large on the actual reported data: both images total 543,487 bytes; their
base64 bodies total 724,652 characters, fetched in two separate requests. Each
is below the existing 4 MiB per-image relay limit. History remains an 80-message
page of metadata, not a full conversation plus image bodies.

Where it goes: image files remain in conversation attachment storage. The PWA
stores metadata in its conversation-scoped IndexedDB timeline and receives the
bytes on demand over the existing sealed, fragmented relay transport. Decoded
data URLs use the existing bounded session cache; no growing SQL command-line
argument or per-token image publication was added.
