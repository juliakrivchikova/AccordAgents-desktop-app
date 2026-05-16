# Image Attachments Implementation Notes

## Scope

Implement image attachments after the Codex app-server chat migration has been tested. The first version should support user-attached images in chat messages, persist them with the conversation, render previews in the app, and propagate them to agents without relying on local URLs.

## Storage

- Store image bytes outside SQLite under app `userData`, scoped by conversation:
  `chats/<conversationId>/attachments/<attachmentId>.<ext>`.
- Store only attachment metadata on `ChatMessage`, not the image bytes.
- Add shared metadata similar to:
  - `id`
  - `filename`
  - `mimeType`
  - `sizeBytes`
  - `width` and `height` when available
  - app-managed storage key/path
  - `createdAt`
- Keep attachment paths app-owned. Do not expose arbitrary filesystem paths through IPC or MCP.

## Renderer

- Add image attach support to the chat composer through file picker, paste, and drag/drop.
- Show pending attachment previews before send, with remove controls.
- Render sent image previews in chat messages.
- Keep message text optional only if at least one attachment is present.
- Support `png`, `jpeg`, and `webp` in v1.

## Main Process

- Validate MIME type, file extension, and size before persisting.
- Default max image size: `10 MB`.
- Copy image bytes into the app-managed attachment directory before creating the chat message.
- Include attachment metadata in history JSON and a concise attachment reference in history Markdown.
- Extend `SendChatMessageRequest` and `ChatMessage` with attachment metadata.

## App MCP

- Add read-only attachment tools scoped by the issued chat token.
- Suggested tools:
  - `app_chat_list_attachments`
  - `app_chat_read_attachment`
- `app_chat_read_attachment` should accept an attachment ID and return metadata plus a data URL or base64 payload.
- Enforce conversation, participant, and trigger/thread visibility from the MCP actor token.
- Never allow MCP callers to request arbitrary local paths.

## Agent Propagation

- Prompt agents with attachment IDs and tell them to use App MCP for durable attachment access.
- For Codex app-server, pass triggering-message images directly as `data:image/...` inputs in `turn/start`.
- Do not use `localhost` URLs, `file://` URLs, or app-server `localImage`; probes showed those are not reliable for this integration.
- For Claude Code, start with MCP attachment access unless a native image input path is separately verified.

## Validation

- Run `make typecheck` and `make build`.
- Manual test text-only messages still work.
- Manual test attach, remove, send, render preview, reload conversation, and read image through MCP.
- Manual test Codex receives a triggering image through app-server data URL.
- Manual test oversized, unsupported, and missing attachment inputs fail with useful errors.
