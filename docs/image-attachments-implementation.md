# Image Attachments Implementation Notes

## Scope

V1 supports image attachments in chat messages. It is optimized for macOS screenshot paste (`Control+Command+Shift+4`, then `Command+V`) and also supports file picker and drag/drop images.

## Storage

- Store image bytes outside SQLite under app `userData`, scoped by conversation:
  `chats/<conversationId>/attachments/<attachmentId>.<ext>`.
- Store only attachment metadata on `ChatMessage`, not the image bytes.
- Shared metadata is `ChatImageAttachment`: `id`, `filename`, `mimeType`, `sizeBytes`, `width`, `height`, app-managed `storageKey`, and `createdAt`.
- Keep attachment paths app-owned. Do not expose arbitrary filesystem paths through IPC or MCP.

## Renderer

- The chat composer accepts image paste, file picker selection, and drag/drop.
- Pending images appear above the textarea with thumbnails, size/status, and remove controls.
- Sent image previews are read back through `chat:read-attachment`; raw bytes are not stored in React conversation state.
- Keep message text optional only if at least one attachment is present.
- Support `png`, `jpeg`, and `webp` in v1.

## Main Process

- Validate MIME type, magic bytes, decoded dimensions, byte size, and pixel count before persisting.
- Limits: 5 images per message, `10 MB` per image, max `8192px` per side, and max `25,000,000` pixels.
- Image bytes are temp-written and atomically renamed into the app-managed attachment directory before the chat message is saved.
- If the initial conversation save fails, newly written image files are removed.
- History JSON stores metadata only; history Markdown includes a concise attachment reference.

## App MCP

- Read-only attachment tools are scoped by the issued chat token:
  - `app_chat_list_attachments`
  - `app_chat_read_attachment`
- `app_chat_read_attachment` accepts an attachment ID and returns metadata plus MCP image content.
- Enforce conversation, participant, and trigger/thread visibility from the MCP actor token.
- Never allow MCP callers to request arbitrary local paths.

## Agent Propagation

- Prompt agents with attachment IDs and tell them to use App MCP for durable attachment access.
- Native direct image injection into Codex app-server remains disabled until the runner capability is verified. The app logs `chat.attachments.direct-delivery-skipped` when a triggering message has images.
- Do not use `localhost` URLs, `file://` URLs, or app-server `localImage`; those paths are not the durable contract.
- For Claude Code, start with MCP attachment access unless a native image input path is separately verified.

## Validation

- Run `make typecheck`, `make build`, and `npm run test:permissions`.
- Manual test text-only messages still work.
- Manual test attach, remove, send, render preview, reload conversation, and read image through MCP.
- Manual test oversized, unsupported, and missing attachment inputs fail with useful errors.
