# Chat Roles and Participants

Roles are reusable instruction templates. Participants are concrete chat actors that bind a role to a handle, CLI provider, model, reasoning effort, avatar, agent mode, permissions, and runtime session state. `agentMode` is a permission/run profile such as Custom access, Plan only, or Auto-run; it is separate from the old implementation-plan product flow.

Read this before changing role presets, participant settings, or chat session behavior.

## Core Types

- `ChatRoleConfig` in `src/shared/types.ts` describes a reusable role: `id`, `label`, `instructions`, `version`, `builtIn`, `appToolCapabilities`, optional participant creation defaults in `participantDefaults`, `updatedAt`, and optional `archivedAt`. A role with `archivedAt` set is soft-deleted: it stays in settings so existing references keep resolving, but is hidden from the Roles list and from role pickers.
- `ChatRoleConfig.appToolCapabilities` is the server-enforced grant list for app MCP tools. Role/member management is also controlled by `participantDefaults.manageRolesParticipants`; the built-in Workflow Manager defaults this to `allow`, while Chat Assistant defaults it to `ask`.
- `ChatParticipantConfig` describes a saved participant preset in settings: `handle`, `roleConfigId`, `kind`, optional `model`, optional `reasoningEffort`, optional `avatarId`, `agentMode`, and `permissions`.
- `ChatParticipant` is the participant shape copied into a chat conversation. It is stored in `conversation.metadata.participants`. `participantConfigId` optionally links it back to the saved participant preset it came from.
- `ChatParticipantSession` is the runtime session lock for a participant. It stores the CLI `sessionId`, resolved `roleLabel`, resolved `roleInstructions`, `roleConfigVersion`, resolved app-tool capabilities, runtime type, model, agent mode, permissions, and `lastSyncedMessageId`.
- `ChatAppToolApproval` records a proposed or applied app-tool mutation in `conversation.metadata.pendingAppToolApprovals`.
- `ChatAppToolApprovalPolicy` records per-chat auto-approval grants in `conversation.metadata.appToolApprovalPolicies`.

Do not treat these as interchangeable. A role can exist without a participant. A participant points at one role. A session is created only when a participant actually runs.

## Where Things Live

- Built-in role presets live in `src/main/services/settings.ts` as instruction constants plus entries in `DEFAULT_CHAT_ROLES`.
- Settings persistence is handled by `SettingsService` in `src/main/services/settings.ts`. It writes JSON under Electron `userData`, not inside the repo.
- Chat orchestration is handled by `ChatService` in `src/main/services/chat.ts`.
- App MCP server behavior lives in `src/main/services/appMcp.ts`; role, participant, permission, and compatibility roster mutations still go through `ChatService`.
- Shared wire types live in `src/shared/types.ts`.
- Renderer editing UI is split across `src/renderer/components/settings`, `src/renderer/components/chat`, and state/action hooks under `src/renderer/app`; `src/renderer/App.tsx` only wires views together.

## Runtime Flow

1. `SettingsService.getPublicSettings()` returns role configs, saved participant configs, and participant seed state to the renderer.
2. `mergeDefaultRoles()` adds missing built-in roles for existing users and upgrades older built-ins when their stored `version` is lower than the fallback built-in version.
3. CLI detection seeds one generic saved participant preset per installed CLI provider unless the user deleted that provider's seed preset. Seeded presets use the `generic-participant` role and Codex/Claude logo avatars.
4. The user creates a chat with selected participants. If no local CLI is installed, chat creation is blocked. If no participants are selected, the setup UI starts with Chat Assistant only by sending `skipDefaultParticipants`; callers that omit that flag still receive matching seeded generic presets. The selected or seeded participant data is copied into `conversation.metadata.participants`, including `participantConfigId` when the participant came from a saved preset.
5. If no participant with role `administrator` is present, `ChatService` injects `@assistant` using an installed CLI provider, preferring Codex CLI and then Claude Code. Existing `@admin` chats remain mention-compatible and display as Chat Assistant.
6. On the first participant turn, `ChatService.sessionForParticipant()` resolves the participant's `roleConfigId` to the current `ChatRoleConfig`.
7. `newSessionForParticipant()` creates a `ChatParticipantSession` with a snapshot of the role label and instructions.
8. The CLI participant receives the role through native role support when available, or prompt fallback when necessary.
9. After a run, `upsertSession()` stores the session and `lockParticipantRoleVersion()` records the role version on the conversation participant.

If a user message mentions one or more participants, explicit mention routing wins. If a message has no participant mention, it routes to the last roster participant sender in the relevant scope: the newest participant message in the active thread, or the newest visible top-level participant message on the timeline. Chat Assistant is a valid last sender. If no eligible prior participant exists, the message falls back to Chat Assistant when present; otherwise the existing mention-required behavior applies.

The important consequence: existing chat sessions are intentionally coherent across turns. A role edit does not blindly rewrite the prompt history of an already-running CLI session. Provider kind is captured in the participant session snapshot. Model, reasoning effort, agent mode, and permissions are refreshed from current participant metadata on the next turn so quick controls apply without resetting provider history. Saved participant avatar and behavior-rule changes sync into linked existing chat participants; legacy chats without `participantConfigId` may match once by handle and provider kind, then backfill the link.

Claude Code participants always receive two tools regardless of stored permission toggles: the read-only `Skill` tool, and the subagent-spawning tool (`Agent`, with the legacy `Task` name also passed for older CLIs). This is a deliberate exception to the `Plan only` permission profile: `Plan only` forces `workspaceWrite`/`shell` off so `Write`/`Edit`/`Bash` are hard-disallowed, but `Agent`/`Task` stay allowed, governed only by the model honoring the "no non-readonly tools" reminder. A subagent spawned under `Plan only` still cannot edit or run shell (those tools are disallowed process-wide), but it can spawn and consume tokens. Spawned subagents inherit the run's permissions and are separate from chat participant requests, so they never appear in chat. Warm sessions keep their prior tool argv until restarted.

## Prompt Split

Chat participant prompts are split between static session instructions and a thin per-turn prompt.

- Static participant/session instructions contain role identity, role instructions, App MCP usage policy, response rules, participant dispatch rules, user-choice formatting, clarification policy, and response-guard behavior. They are passed through native provider setup when available, such as Claude Code agents or Codex developer instructions.
- Per-turn prompts contain only the current envelope: participant sanity check, current repository and permission state, App MCP context pointer, fallback/debug history paths, triggering message identifiers, triggering message content, and the current request.
- Prompt fallback is the exception. If a provider cannot accept native role/session instructions, the fallback prompt includes the full static contract in-band so the participant still has the role and response rules.
- Dynamic roster, provider, participant, thread, and message details should come from App MCP tools instead of repeated prompt prose.

## App MCP Tools and Approvals

`AppMcpService` runs a loopback MCP endpoint inside the Electron main process. It is intended for CLI agents launched by this app, not arbitrary local clients.

- `ChatService` issues a scoped bearer token for each participant run. The token binds to the actual `conversationId`, `participantId`, role id, role version, and resolved app-tool capabilities.
- MCP tools derive the actor from that token. Tool arguments must never be trusted to identify the conversation or participant.
- `app_chat_get_context`, `app_chat_get_participants`, `app_chat_read_messages`, `app_chat_list_attachments`, and `app_chat_read_attachment` are read-only context tools available to every issued participant token. They let agents read the active turn, roster, provider status, focused message pages, and visible image attachments without rereading full history files.
- Role, participant, roster, and permission mutation tools are filtered by the token's capabilities, and every mutating `tools/call` rechecks the current participant role through `ChatService`.
- `app_permissions_request_change` is available to every chat participant. It can request portable grants (`repoRead`, `workspaceWrite`, or `webAccess`), command-specific `shellRules`, or Claude-only `providerNative.allowedTools` for the requesting participant only. In Auto-review mode, in-preset portable requests return `already_granted` because the launch profile already grants `repoRead`, `workspaceWrite`, and `webAccess`; out-of-preset requests still create a pending approval.
- `app_tool_permission` is the Claude Code `--permission-prompt-tool` bridge for default-mode chat runs. Claude Code calls it automatically when an unmatched CLI tool request needs approval; the app creates a User approval card and returns `{ behavior: "allow" | "deny" }` to the blocked tool call. It is runtime plumbing, not a tool that participant prompts should instruct agents to call directly.
- `app_chat_read_messages` reads only the token-bound conversation and supports thread and sequence filters. Do not add arguments that let agents select an arbitrary conversation or participant.
- Static participant/session instructions should describe MCP tools as the required path for app-managed mutations. If a task needs blocked web access, file edits, a specific shell command rule, or a native Claude tool grant, the agent should call `app_permissions_request_change` rather than only saying the task is blocked or asking User in prose.
- `app_roles_describe_options` is the read-only role discovery tool. It returns built-in/custom flags, instructions, app-tool capabilities, and role usage counts.
- `app_roles_request_change` is the mutating role request tool. It supports `create_role`, custom-role-only `edit_role`, and custom-role-only `archive_role` (the UI label is "Delete role"). Built-in roles are matched or copied by creating a custom role; Chat Assistant cannot edit or delete built-ins. `archive_role` needs only `role.roleConfigId`, and is rejected for built-in roles or for any role still used by a saved participant preset. Create-role responses include a temporary `draftRoleRef`. `archive_role` cannot be combined with a participant change in one grouped request.
- `app_participants_describe_options` is the read-only participant discovery tool. It returns saved participant presets, current chat participants, available roles, CLI provider installed/enabled state, configured provider models, provider reasoning-effort options, default participant values, and validation rules.
- `app_participants_request_change` is the mutating participant request tool. It supports `add_new_participant_to_chat` with `saveAsPreset` and `add_existing_participant_to_chat`. If a participant depends on a pending custom role, the assistant uses the role tool's `draftRoleRef` as `participant.roleConfigId`; the app collapses the role and participant drafts into one grouped approval and commits role plus saved participant settings in one write.
- `app_roster_describe_options` and `app_roster_request_change` remain compatibility tools for additive chat-local roster changes. Do not teach Chat Assistant to use them for the v1 role/participant flow.
- If no matching per-chat approval policy exists, roster mutating tool calls create a pending approval item and return `pending_user_approval`. Permission requests return `already_granted` when covered by current or effective permissions; otherwise they create a pending approval item.
- Roster approval `Allow once` applies only the pending roster change. Roster approval `Allow for chat` applies the pending change and stores a per-chat policy for the same participant, role, tool, and capability.
- Role and participant request tools always create pending approval items. Roster approval policies must not authorize durable role or participant-preset writes.
- Permission approval `Allow once` grants the requested permission only to the requesting participant's next run, then marks the grant consumed. Permission approval `Allow @handle in this chat` stores the permission on that chat participant only; it does not grant access to other participants. Permission requests from an in-flight participant carry resume context so approval can rerun that blocked turn with the upgraded permissions.
- Tool-permission approval `Allow once` approves only the currently blocked tool call. `Allow @handle in this chat` stores a per-chat policy for that requester and exact tool name, so future calls to the same external tool skip the approval card while other tools still prompt.
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

## Deleting (Archiving) a Role

Deletion is soft-delete. The UI action is labeled "Delete role" but stores `archivedAt` rather than removing the record, so references that still point at the role keep resolving.

- The product rule is strict: a role can be deleted only when it is a **custom** role with **0 saved participant presets** using it. Built-in roles can never be deleted.
- `SettingsService.archiveChatRoleConfig(id)` is the single enforcement point. It rejects built-ins and rejects a role whose usage count (saved presets, the only reliable settings-local count) is greater than zero, then sets `archivedAt` in one `readStored`/`writeStored` so the check and write are atomic. Archiving is idempotent.
- The usage gate deliberately does **not** scan stored conversations. A role may still be referenced by an ad-hoc or imported chat participant that is not a saved preset; archive (not the gate) protects those references, since the record stays resolvable. The renderer surfaces such references with an "Archived role" marker.
- Renderer filters archived roles out of the Roles list (`RolesSettingsSection`) and out of every role picker (participant editor, app-tool approval participant change), while still keeping a participant's *current* role selectable so editing never goes blank.
- Both entry points converge on `SettingsService`: the direct UI path calls `archiveChatRoleConfig` via the `settings:archive-chat-role` IPC route; the agent path adds an `archive_role` op to `ChatRoleChangeOperation`, validated in `ChatService.prepareRoleChange` and applied through `applyPreparedRoleChange`.
- Resolver hardening: `ChatService.resolvedRoleForParticipantOrThrow` no longer throws when a `roleConfigId` is missing entirely (deleted record, stale or imported data). It falls back to the `generic-participant` built-in and logs a warning, so a missing role never crashes a participant's turn. Archived roles still resolve to their real (archived) config because they remain in settings, so only genuinely-absent ids hit the fallback.

## Participant Changes

When adding participant fields, update all layers deliberately:

- `src/shared/types.ts` for the contract.
- `SettingsService.saveChatParticipantConfig()` for validation and persistence.
- `SettingsService.normalizeParticipantConfigs()` for reading old settings safely.
- `ChatService.validateParticipants()` for conversation creation.
- `ChatService.sessionForParticipant()` and `warmAgentContextKey()` if the field changes runtime behavior.
- `src/renderer/app/*` hooks plus `src/renderer/components/settings` and `src/renderer/components/chat` for defaults, forms, validation, and display.

If the field affects CLI behavior, also make sure it is captured in `ChatParticipantSession` or `runtimeConfigVersionFor()` so stale warm sessions are not reused incorrectly.

When adding app-tool capabilities, also update `src/shared/appTools.ts`, the built-in role grants in `SettingsService` if role-gated, `AppMcpService.toolsForActor()`, `ChatService` authorization checks, and the approval UI if the tool can mutate chat state. Read-only discovery tools should still derive conversation and participant identity from the MCP token and should recheck current role authorization on each call.

## Common Mistakes

- Adding a new role prompt but forgetting the `DEFAULT_CHAT_ROLES` entry.
- Renaming a built-in role `id` and breaking saved participant configs.
- Updating a built-in prompt without bumping `version`, so existing users keep the old stored copy.
- Updating native runtime prompt behavior without bumping `CHAT_ROLE_RUNTIME_CONFIG_VERSION`, so existing CLI sessions may keep stale instructions.
- Treating `roleConfigId` as a display label instead of resolving it through settings or session state.
- Reading role instructions from current settings when an existing session should use its locked `roleInstructions`.
- Changing participant permissions, model, reasoning effort, or agent mode outside `ChatService.updateParticipantRuntime()` or another `withChatMutation()` path.
- Trusting MCP tool arguments for actor identity instead of the issued bearer token.
- Giving a role app-tool capabilities in prompts but forgetting to enforce them server-side.
- Expecting agents to infer available roles, CLIs, or models from prompt prose instead of using the read-only app discovery tool.
- Applying a mutating app-tool request directly when it should create or honor a chat-scoped approval.
- Editing Electron `userData/settings.json` manually instead of changing defaults or migration code.
