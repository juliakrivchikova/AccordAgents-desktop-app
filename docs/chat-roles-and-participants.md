# Chat Roles and Participants

Roles are reusable instruction templates. Participants are concrete chat actors that bind a role to a handle, CLI provider, model, avatar, agent mode, permissions, and runtime session state.

Read this before changing role presets, participant settings, or chat session behavior.

## Core Types

- `ChatRoleConfig` in `src/shared/types.ts` describes a reusable role: `id`, `label`, `instructions`, `version`, `builtIn`, `appToolCapabilities`, and `updatedAt`.
- `ChatRoleConfig.appToolCapabilities` is the server-enforced grant list for app MCP tools. In the built-ins, only `administrator` has `participants.manage`.
- `ChatParticipantConfig` describes a saved participant preset in settings: `handle`, `roleConfigId`, `kind`, optional `model`, optional `avatarId`, `agentMode`, and `permissions`.
- `ChatParticipant` is the participant shape copied into a chat conversation. It is stored in `conversation.metadata.participants`.
- `ChatParticipantSession` is the runtime session lock for a participant. It stores the CLI `sessionId`, resolved `roleLabel`, resolved `roleInstructions`, `roleConfigVersion`, resolved app-tool capabilities, runtime type, model, agent mode, permissions, and `lastSyncedMessageId`.
- `ChatAppToolApproval` records a proposed or applied app-tool mutation in `conversation.metadata.pendingAppToolApprovals`.
- `ChatAppToolApprovalPolicy` records per-chat auto-approval grants in `conversation.metadata.appToolApprovalPolicies`.

Do not treat these as interchangeable. A role can exist without a participant. A participant points at one role. A session is created only when a participant actually runs.

## Where Things Live

- Built-in role presets live in `src/main/services/settings.ts` as instruction constants plus entries in `DEFAULT_CHAT_ROLES`.
- Settings persistence is handled by `SettingsService` in `src/main/services/settings.ts`. It writes JSON under Electron `userData`, not inside the repo.
- Chat orchestration is handled by `ChatService` in `src/main/services/chat.ts`.
- App MCP server behavior lives in `src/main/services/appMcp.ts`; chat roster mutations still go through `ChatService`.
- Shared wire types live in `src/shared/types.ts`.
- Renderer editing UI is currently in `src/renderer/App.tsx`.

## Runtime Flow

1. `SettingsService.getPublicSettings()` returns role configs and saved participant configs to the renderer.
2. `mergeDefaultRoles()` adds missing built-in roles for existing users and upgrades older built-ins when their stored `version` is lower than the fallback built-in version.
3. The user creates a chat with selected participants. The selected participant data is copied into `conversation.metadata.participants`. If no participant with role `administrator` is present, `ChatService` injects `@admin` using an installed CLI provider, preferring Codex CLI and then Claude Code.
4. On the first participant turn, `ChatService.sessionForParticipant()` resolves the participant's `roleConfigId` to the current `ChatRoleConfig`.
5. `newSessionForParticipant()` creates a `ChatParticipantSession` with a snapshot of the role label and instructions.
6. The CLI participant receives the role through native role support when available, or prompt fallback when necessary.
7. After a run, `upsertSession()` stores the session and `lockParticipantRoleVersion()` records the role version on the conversation participant.

If a chat contains only the injected administrator, unmentioned user messages are routed to `@admin`. Once additional participants are present, normal mention-driven dispatch applies.

The important consequence: existing chat sessions are intentionally coherent across turns. A role edit does not blindly rewrite the prompt history of an already-running CLI session; the service recreates the session only when the role version, app-tool capabilities, provider kind, model, agent mode, permissions, or runtime config requires it.

## App MCP Tools and Approvals

`AppMcpService` runs a loopback MCP endpoint inside the Electron main process. It is intended for CLI agents launched by this app, not arbitrary local clients.

- `ChatService` issues a scoped bearer token for each participant run. The token binds to the actual `conversationId`, `participantId`, role id, role version, and resolved app-tool capabilities.
- MCP tools derive the actor from that token. Tool arguments must never be trusted to identify the conversation or participant.
- `app_chat_get_context`, `app_chat_get_participants`, and `app_chat_read_messages` are read-only context tools available to every issued participant token. They let agents read the active turn, roster, provider status, and focused message pages without rereading full history files.
- Roster and permission mutation tools are filtered by the token's capabilities, and every mutating `tools/call` rechecks the current participant role through `ChatService`.
- `app_permissions_request_change` is available to every chat participant. It can request `workspaceWrite` or `webAccess` for the requesting participant only, creates a pending approval, and never grants permissions directly.
- `app_chat_read_messages` reads only the token-bound conversation and supports thread and sequence filters. Do not add arguments that let agents select an arbitrary conversation or participant.
- Participant prompts should describe MCP tools as the required path for app-managed mutations. If a task needs blocked web access or file edits, the agent should call `app_permissions_request_change` rather than only saying the task is blocked or asking User in prose.
- `app_roster_describe_options` is the read-only discovery tool. It returns current roster participants, role IDs and labels, CLI provider installed/enabled state, configured provider models, default roster values, and validation rules. It exists so agents do not infer availability from prompt text or schemas.
- `app_roster_request_change` is the mutating request tool. It supports additive roster changes in v1.
- If no matching per-chat approval policy exists, a tool call creates a pending approval item and returns `pending_user_approval`.
- Roster approval `Allow once` applies only the pending roster change. Roster approval `Allow for chat` applies the pending change and stores a per-chat policy for the same participant, role, tool, and capability.
- Permission approval `Allow once` grants the requested permission only to the requesting participant's next run, then marks the grant consumed. Permission approval `Allow @handle in this chat` stores the permission on that chat participant only; it does not grant access to other participants.
- Denied, approved, and auto-applied requests are written as system messages for auditability.

MCP tool annotations such as read-only or destructive hints are only host-facing metadata. Authorization and mutation safety must stay enforced in `AppMcpService` and `ChatService`.

## Adding a Built-In Role

1. Add a `DEFAULT_<ROLE>_INSTRUCTIONS` constant in `src/main/services/settings.ts`.
2. Add a `DEFAULT_CHAT_ROLES` entry with a stable `id`, readable `label`, `version: 1`, `builtIn: true`, and a meaningful `updatedAt`.
3. Keep the role prompt domain-specific, with clear responsibilities, boundaries, and output style.
4. Avoid product names and legacy branding inside generic role prompts unless the role is explicitly app-specific.
5. Run `make typecheck`. Run `make build` if renderer behavior, IPC, or compiled main-process behavior could be affected.

Existing users receive the new built-in through `mergeDefaultRoles()` as long as the role `id` is new.

## Updating a Built-In Role

- Keep the existing `id` unless you are also migrating all references from saved participant configs and conversation metadata.
- Bump `version` when you want existing built-in roles with lower versions to receive the new prompt.
- Be careful with user-edited built-ins: a future fallback version higher than the stored version will replace the stored built-in role.
- Update `updatedAt` when changing built-in instructions.
- Do not edit `dist`; it is generated by the build.

## Participant Changes

When adding participant fields, update all layers deliberately:

- `src/shared/types.ts` for the contract.
- `SettingsService.saveChatParticipantConfig()` for validation and persistence.
- `SettingsService.normalizeParticipantConfigs()` for reading old settings safely.
- `ChatService.validateParticipants()` for conversation creation.
- `ChatService.sessionForParticipant()` and `warmAgentContextKey()` if the field changes runtime behavior.
- `src/renderer/App.tsx` for defaults, forms, validation, and display.

If the field affects CLI behavior, also make sure it is captured in `ChatParticipantSession` or `runtimeConfigVersionFor()` so stale warm sessions are not reused incorrectly.

When adding app-tool capabilities, also update `src/shared/appTools.ts`, the built-in role grants in `SettingsService` if role-gated, `AppMcpService.toolsForActor()`, `ChatService` authorization checks, and the approval UI if the tool can mutate chat state. Read-only discovery tools should still derive conversation and participant identity from the MCP token and should recheck current role authorization on each call.

## Common Mistakes

- Adding a new role prompt but forgetting the `DEFAULT_CHAT_ROLES` entry.
- Renaming a built-in role `id` and breaking saved participant configs.
- Updating a built-in prompt without bumping `version`, so existing users keep the old stored copy.
- Updating native runtime prompt behavior without bumping `CHAT_ROLE_RUNTIME_CONFIG_VERSION`, so existing CLI sessions may keep stale instructions.
- Treating `roleConfigId` as a display label instead of resolving it through settings or session state.
- Reading role instructions from current settings when an existing session should use its locked `roleInstructions`.
- Changing participant permissions, model, or agent mode without invalidating or recreating the runtime session.
- Trusting MCP tool arguments for actor identity instead of the issued bearer token.
- Giving a role app-tool capabilities in prompts but forgetting to enforce them server-side.
- Expecting agents to infer available roles, CLIs, or models from prompt prose instead of using the read-only app discovery tool.
- Applying a mutating app-tool request directly when it should create or honor a chat-scoped approval.
- Editing Electron `userData/settings.json` manually instead of changing defaults or migration code.
