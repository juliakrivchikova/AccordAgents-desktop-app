# Chat-Only MVP Scope

This document describes the MVP scope if the product launches with chat mode only. It is based on the current implementation in `src/main/services/chat.ts`, `src/main/services/settings.ts`, `src/main/services/cliAgents.ts`, `src/shared/types.ts`, and `src/renderer/App.tsx`.

The MVP should treat chat as the product, not as one mode among several. Code review, general question, implementation plan, diff preview, points tables, hosted API providers, and consensus/debate workflows should be considered legacy or future surfaces unless deliberately reintroduced.

## Desired MVP

The desired MVP is a local desktop app for running multi-participant AI chats with local CLI agents.

Users should be able to:

- Create a chat session.
- Add one or more AI participants with named roles.
- Mix local CLI providers in the same chat, so Codex CLI and Claude Code participants can work from the same conversation context.
- Mention participants to ask them to respond.
- Let participants ask other participants to join, with user approval.
- Let participants ask the user to choose between options.
- Save reusable participant presets.
- Create and edit reusable role instructions.
- Maintain reusable app-managed skills and mention them in chat or participant setup.
- Convert app-managed skills into provider-specific setup for Codex, Claude Code, and Gemini-compatible providers without forcing users to maintain separate versions.
- Control each participant's repository, shell, file-editing, and web permissions.
- Reopen chat history and continue prior sessions.

The release target is explicitly API-free:

- Chat-only desktop app.
- Local CLI agents only: Codex CLI and Claude Code.
- No OpenAI, Anthropic, or Gemini API-key setup in the MVP UI.
- No hosted model listing.
- No hosted-provider workflows.
- Non-chat modes hidden from first-release navigation.
- Gemini can be a provider-specific skill rendering target, but Gemini API-key setup and hosted Gemini chat execution are still out of MVP unless a no-API Gemini runtime is added.

Chat currently supports local CLI participants only: `codex-cli` and `claude-code`.

## MVP Positioning

The MVP should be positioned as a shared local chat workspace for cross-model, cross-provider CLI-agent interaction, not as a generic terminal/session manager or hosted model router.

Competitive products commonly cover one or more adjacent jobs:

- Running multiple agent terminals side by side.
- Managing worktrees and isolated task sessions.
- Browsing or resuming past agent sessions.
- Syncing instructions, skills, commands, MCP config, or memory across providers.
- Routing one agent's output to another in coding-specific worker/reviewer loops.

The product gap this MVP should target is narrower and clearer:

- One user-facing chat where participants from different local providers can respond to the same conversation.
- App-managed roles, skills, permissions, approvals, and history as the coordination layer.
- Participant-to-participant requests inside the chat, with the user approving the handoff.
- Provider-specific setup generated from one app-managed source of truth.

This means the MVP should emphasize cross-model interaction in a shared conversation. It should not compete first on terminal multiplexing, worktree automation, hosted model routing, or generic config sync alone.

## MVP Product Principles

These principles should guide first-release scope decisions.

### Conversation as the Main Object

The primary object is the chat conversation, not a provider session, terminal pane, worktree, task board, or model comparison run.

Required product behavior:

- The user opens a chat, adds participants, mentions participants, and keeps a useful transcript.
- Provider sessions exist to serve the conversation, but they should not become the main surface.
- Session details such as runtime IDs, CLI resume state, and provider-specific setup should stay secondary unless needed for troubleshooting.

### Provider-Neutral Participant Identity

The participant is defined by role, skills, permissions, handle, avatar, repository context, and optional model override. Codex CLI or Claude Code is the runtime backing that participant, not the user's primary mental model.

Required product behavior:

- Roles and skills should be reusable across providers.
- The same participant concept should work even if the backing local CLI changes later.
- Provider-specific skill rendering should be an implementation detail of the app-managed source of truth.

### Human-Moderated Collaboration

The app should support collaboration between participants without becoming an automatic agent swarm.

Required product behavior:

- Agents can request another participant, but the user approves the handoff.
- The user can see which participant asked for whom and why.
- Automatic multi-agent loops should stay out of MVP unless they preserve explicit user control.

## Current Code Map

- Shared chat contracts: `src/shared/types.ts`
- Permission defaults and normalization: `src/shared/agentPermissions.ts`
- App-tool capability helpers: `src/shared/appTools.ts`
- Settings, built-in roles, participant presets: `src/main/services/settings.ts`
- Chat orchestration and persistence hooks: `src/main/services/chat.ts`
- Local CLI execution, session resume, permissions mapping: `src/main/services/cliAgents.ts`
- Local app MCP server for roster changes: `src/main/services/appMcp.ts`
- Conversation storage and message paging: `src/main/services/storage.ts`
- Renderer UI for settings, chat setup, chat timeline, choices, approvals, and threads: `src/renderer/App.tsx`
- Skill aggregation, skill mentions, and provider-specific skill setup are desired MVP features but are not currently implemented.

## Implementation Reference: Current Chat Features

The sections below describe the current chat feature surface and should be treated as implementation reference for the desired MVP, not as permission to expose non-chat or hosted-provider workflows.

### 1. Chat Session Creation

The user can start a chat from a dedicated chat setup screen.

Required behavior:

- Chat title is optional; blank title falls back to `Chat`.
- Repository path is optional.
- Saved participant presets can be selected before starting.
- If no participants are selected, the app can start an admin-only chat as long as the `administrator` role exists and at least one local CLI is installed.
- If selected participants do not include an administrator, the backend auto-adds one when the administrator role exists.
- Chat conversations are created with `kind: "chat"` and initial system text listing the participants.

Validation:

- Participant handles must match `^[A-Za-z0-9_-]{1,32}$`.
- Handles must be unique within the chat.
- Each participant must reference an existing role.
- Only `codex-cli` and `claude-code` participants are valid for chat.
- The selected local CLI must be installed.

### 2. Conversation History

The app should keep a persistent sidebar history of chat conversations.

Required behavior:

- Conversations are listed by title, kind, and update time.
- Opening a conversation loads the most recent messages first.
- Older messages can be loaded in pages.
- Running conversations stream snapshots back to the renderer.
- If the app was interrupted during a run, storage clears the `running` flag and adds a warning.

Storage behavior:

- Conversations are stored in Electron `userData` SQLite database `accordagents.sqlite3`.
- Message bodies are split into `conversation_messages` for paging.
- Chat history files are also written under `userData/chats/<conversationId>/history.md` and `history.json` so participants can read prior context.

### 3. Chat Message Dispatch

Chat dispatch is mention-based.

Required behavior:

- The user sends a normal message from the chat composer.
- Mentioning `@handle` dispatches the message to that participant.
- Mentioning multiple participants runs them in parallel from the same conversation snapshot.
- Participants using different local CLI providers can be mentioned in the same message and receive the same shared chat context.
- Unknown handles produce a system warning.
- If the chat only contains `@admin` and the user sends a message without a mention, the message dispatches to `@admin`.
- Otherwise, a message without a participant mention is recorded but does not automatically run every participant.

UI behavior:

- Composer supports `@` autocomplete.
- Enter sends the message; Shift+Enter inserts a newline.
- The timeline shows user, participant, and system messages.
- Messages can be copied.
- Participants show avatars, status, context usage when available, and session details.

### 4. Participant Replies and Parallel Runs

Participants are local CLI agents with persistent chat sessions.

Required behavior:

- Each participant gets a CLI session snapshot of its role, provider kind, model, mode, permissions, and app-tool capabilities.
- Existing sessions are reused when the runtime config still matches.
- Sessions are recreated when role version, provider kind, model, agent mode, permissions, app-tool capabilities, or runtime config version changes.
- Codex uses `developer_instructions` when supported, with prompt fallback.
- Claude Code uses `--agents` / `--agent` when supported, with prompt fallback.
- Claude Code can use warm chat processes; Codex currently uses one-shot resume fallback.
- Stale or missing CLI sessions are restarted with resume fallback.
- Progress updates show running, participant completion, cancellation, errors, and tool activity summaries.

Guardrails:

- Participant prompts tell agents to answer in chat, not claim work was written elsewhere.
- Responses mentioning forbidden internal mechanics are rejected and retried.
- Verbose affirmative confirmations are retried with a short-confirmation prompt.

### 5. Role Management

Roles are reusable instruction templates.

Required behavior:

- The user can view built-in roles.
- The user can edit role label and instructions.
- The user can create custom roles.
- Saving an existing role increments its version.
- Existing live participant sessions keep a locked role snapshot until the app decides the session must be recreated.

Current built-in roles:

- Administrator
- Synthesizer
- Arbiter
- Software Engineer
- Product Strategist
- Brand Strategist
- Naming Consultant
- Product Marketer
- UX Content Strategist
- Trademark Attorney
- Domain & SEO Specialist
- Engineering Manager
- Product Designer
- Developer Experience Reviewer
- Debugger
- QA Lead
- Security Reviewer
- Release Engineer
- Code Reviewer

Special role behavior:

- The built-in Administrator role has `participants.manage`.
- Role capability editing is not exposed in the current UI, so custom roles cannot currently receive app-tool capabilities through settings.
- Role deletion is not currently implemented.

### 6. Skills Mentioning and Provider-Specific Setup

Skills are reusable app-managed instruction/tooling bundles that can be attached to chat context without asking users to maintain separate provider-specific versions.

Desired behavior:

- The app maintains a canonical skill library.
- The user can mention or attach skills when creating a participant, starting a chat, or writing a chat message.
- Mentioned skills are included in the participant's runtime setup for that turn or session.
- Skills remain provider-neutral in the app's data model.
- The app renders each skill into the correct provider-specific setup for Codex, Claude Code, and Gemini-compatible providers.
- Provider-specific rendering should support different setup mechanisms, such as Codex developer instructions/config, Claude agents/MCP/config, and Gemini-compatible setup output.
- The same app-managed skill should not need to be manually duplicated for each provider.
- Skill mentions should be visible in chat history so the user can understand which skills influenced a response.

API-free MVP boundary:

- Codex and Claude Code are the active no-API runtime targets for chat.
- Gemini is included as a provider-specific skill setup target, but Gemini API-key setup and hosted Gemini chat execution remain out of MVP.

Current implementation status:

- No app-managed skill library exists yet.
- No skill mention parser or UI exists yet.
- No provider-specific skill rendering layer exists yet.

### 7. Saved Participant Presets

Participants are reusable saved presets that become concrete chat actors when copied into a conversation.

Required behavior:

- The user can create, edit, and delete saved participants.
- A participant preset includes:
  - Handle
  - Role
  - CLI provider: Codex CLI or Claude Code
  - Optional model override
  - Agent mode
  - Permissions
  - Avatar
- New participants get generated handles such as `alex-codex-engineer`.
- Avatar choices are provider-specific.
- Invalid participants cannot be selected for a new chat.

Live-chat behavior:

- Saved participant presets are copied into the chat metadata at chat creation.
- Later edits to saved presets do not rewrite existing chat participants automatically.

### 8. Adding Participants During a Chat

The MVP should support adding participants after a chat starts.

Manual path:

- The chat header participant menu shows current participants.
- The user can fill a participant draft and click `Add participant`.
- The backend validates and appends the participant.
- A system message announces the added participant.

Administrator app-tool path:

- The Administrator can call `app_roster_request_change`.
- The only supported operation is `add`.
- The app validates the request before showing it to the user.
- The user can deny, allow once, or allow for this chat.
- `Allow for chat` creates a chat-scoped approval policy for the same participant, role, tool, and capability.
- Future matching requests can be auto-applied in that chat.

Out of scope for current MVP:

- Removing live participants from a chat.
- Renaming live participants.
- Changing a live participant's role, model, mode, permissions, or avatar in place.

### 9. Participant Permissions

Permissions are part of each participant preset and runtime session.

Permission fields:

- `repoRead`: whether the participant can use the selected repository as its working context.
- `workspaceWrite`: whether the participant may edit files.
- `webAccess`: whether web search/fetch is available.
- `shell.enabled`: whether shell commands are available.
- `shell.rules`: command-specific rules with `allow`, `ask`, or `deny` and `exact` or `prefix` matching.

Defaults:

- Repository read: allowed.
- Workspace edits: blocked.
- Web access: blocked.
- Shell commands: blocked.
- Shell rules: empty.
- Agent mode: `default`.

Agent modes:

- `default`: normal local CLI behavior with the configured permissions.
- `plan`: blocks shell commands and file edits even if permissions enable them.
- `auto` (Auto-review): runs the provider's native auto-review preset; repo read, workspace write, web, and shell execution are granted regardless of stored toggles. Codex uses a `workspace-write` sandbox with `approval_policy=on-request` routed to the `guardian_subagent` auto-reviewer. Claude runs under native `--permission-mode auto`, whose classifier auto-approves safe commands and edits without prompting and blocks dangerous ones; if the installed Claude CLI lacks `--permission-mode auto`, the run fails loudly rather than downgrading.

Permission mapping:

- Codex runs with `read-only` or `workspace-write` sandbox based on `workspaceWrite`.
- Codex gets `--search` only when `webAccess` is enabled.
- Claude Code receives read tools when repo or history context is available.
- Claude Code receives edit tools only when `workspaceWrite` is enabled.
- Claude Code receives `WebSearch` and `WebFetch` only when `webAccess` is enabled.
- Claude Code receives `Bash` when shell is enabled. In `default` mode allow/ask/deny tool rules are derived from shell rules; in `auto` mode Bash is governed by the native `--permission-mode auto` classifier and only `deny` rules are forwarded as hard stops (allow/ask are ignored).
- Claude Code receives approved provider-native `allowedTools` tokens through native `--allowedTools`; matching tool names are also exposed through `--tools`.

Permission request app-tool path:

- Every chat participant can call `app_permissions_request_change` to request portable grants (`repoRead`, `workspaceWrite`, or `webAccess`), command-specific `shellRules`, or Claude-only provider-native `allowedTools` tokens for itself.
- The app validates the request. If the effective launch profile already covers it (for example Auto-review repo/read/write/web, or Auto-review shell decisions handled by native auto), the MCP tool returns `already_granted` and does not create a user approval item.
- Requests outside the effective launch profile create a user approval item. Approval updates the participant's chat-scoped permissions, or overlays a once grant for the next run, and invalidates the runtime session on the next run through the normal permission/session matching.
- Broad shell access is not requestable through this tool. Outside Auto-review, agents can request explicit command rules; in Auto-review, shell decisions are provider-native and `shellRules` requests do not create user approvals.

Validation:

- Shell rule patterns must be non-empty.
- Shell rule patterns cannot include commas, parentheses, or newlines.
- Normalization truncates shell rule patterns to 160 characters.

### 10. Repository Context

Chat can run with or without a repository.

Required behavior:

- Repository selection is optional for chat.
- The app can inspect a selected repository and show branch/status summary.
- If `repoRead` is allowed, a participant runs in the selected repository.
- If `repoRead` is blocked or no repository is selected, the participant runs against the app-managed chat history directory.
- The generated history directory is always made readable to participants so they can inspect chat history.

Chat-only MVP implication:

- Git diff selection, branch comparison, staged/uncommitted diff modes, and consensus review diff previews are not needed for chat MVP.

### 11. Participant-to-Participant Requests

Participants can request follow-up from other participants, but the user remains in control.

Required behavior:

- A participant can include a `Participant requests:` block.
- Normal prose mentions like `@alex` are citations only and do not dispatch another agent.
- The app extracts requested participants and marks them pending.
- The user can:
  - Approve all pending mentions.
  - Approve an individual mention.
  - Reject pending mentions.
  - Approve mentions and return to the requester afterward when requested.
- If a participant includes `Return to requester after replies: yes`, the app can run requested participants and then continue the original requester after the approved replies.

UI behavior:

- Pending mentions render as approval controls under the source message.
- Approved mentions are shown as approved.
- Continuation can only be run once per source message.

### 12. User Choices

Participants can ask the user to choose between concrete options.

Required behavior:

- A participant can include one `User choice:` block.
- The parser supports:
  - `T:` title
  - `Q:` question
  - `O1:`, `O2:`, etc. options
  - Optional `R:` recommended option
  - Optional option descriptions using `label | description`
- At least two options are required.
- The UI renders a decision card.
- The user can pick an option, add an optional note, or write a custom answer.
- The app records the selection, appends a user message explaining the choice, and returns control to the requesting participant.

Display behavior:

- Raw `User choice:` protocol lines are stripped from the visible participant message.
- Answered choices stay visible with receipt status.

### 13. Threads

The chat UI supports thread replies.

Required behavior:

- Any non-system message can be opened as a thread root.
- Thread replies keep `threadId`, `parentMessageId`, and `chatThreadRootId`.
- The thread panel is resizable.
- Thread composers use the same mention autocomplete and dispatch rules.
- Top-level timeline hides thread replies and shows reply counts.

### 14. Run Control, Progress, and Errors

Required behavior:

- A running chat turn can be stopped.
- The app tracks runs by `runId` and aborts the matching controller.
- Participant progress is shown inline in the pending participant reply bubble.
- A pending participant bubble appears immediately, shows streamed text when available, and otherwise shows "Thinking" with elapsed seconds.
- The final participant response replaces the pending bubble in place.
- Composer/global status is reserved for progress that is not tied to an inline pending participant message.
- Agent tool activity can be summarized as reading, searching, listing, running command, or using a named tool.
- Warnings and errors are displayed above the main content.

### 15. Settings and Local CLI Setup

Chat MVP needs only local CLI setup.

Required behavior:

- Detect Codex CLI and Claude Code installation, path, version, and errors.
- Enable or disable local CLI providers.
- Allow optional model overrides for participants.
- Persist settings in Electron `userData/settings.json`.

Out of MVP:

- OpenAI, Anthropic, and Gemini API-key setup.
- Hosted model listing.
- Hosted provider selection for non-chat consensus workflows.

API-related code can remain internally for now if it is cheaper than deleting it, but it should not be exposed in the MVP UI or documented as MVP behavior.

### 16. Security and Local Boundaries

Required behavior:

- Settings, conversations, and debug logs stay under Electron `userData`.
- The app MCP server listens only on `127.0.0.1`.
- App-tool calls require bearer tokens issued per participant session.
- Roster mutation app tools are gated by role capability and user approval.
- Participants cannot manage participants unless their role has `participants.manage`.

Hosted API-key storage is not part of the desired MVP because hosted provider setup is out of scope for release.

## Recommended MVP Cut

Keep:

- Chat setup
- Chat timeline
- Shared cross-model conversation for Codex CLI and Claude Code participants
- Sidebar history
- Local CLI detection
- Local CLI provider enablement
- Role management
- App-managed skill library
- Skill mentions in chats, participants, or sessions
- Provider-specific skill setup rendering for Codex, Claude Code, and Gemini-compatible providers
- Saved participant management
- Participant permissions
- Optional repository context
- Mention dispatch
- Pending mention approvals
- User choice cards
- Thread replies
- Manual live participant addition
- Administrator roster-change approval flow
- Stop/cancel handling
- Conversation persistence and paging

Hide or remove from first-release navigation:

- Session mode tabs for code review, general question, and implementation plan
- Diff mode controls
- Arbiter/planner provider picker
- Points result view
- Implementation-plan decision and review flows
- Hosted provider API-key setup
- Hosted model listing
- Hosted-provider workflows

Keep internally if cheaper than deleting:

- Existing storage compatibility for non-chat conversations
- Existing IPC handlers used by old modes
- Existing shared `ConversationKind` union
- Existing hosted-provider code paths, as long as they are not exposed in MVP UI
- Existing provider abstractions, if useful for skill setup rendering without exposing hosted chat/API usage

Do not advertise:

- Consensus review
- Debate rounds
- Implementation planning
- Diff comparison
- Hosted-model multi-provider review
- OpenAI, Anthropic, or Gemini API usage
- Gemini hosted chat execution
- Generic autonomous agent orchestration or unattended swarms

## MVP TODO
- [ ] unrecognized websearch
- [ ] images super small
- 
- [ ] user choice card appearance
- [ ] allow request participant appearance
- 
- [ ] Design improvements
- 
- [ ] Bug: read the latest messages from chat history ( or thread)
- [ ] Bug: when I run accord, the final response should be last message
- [ ] Bug: Context not working (used token percentages). Also let's add time taken to respond to a message.
- [ ] Bug: when both agents are running and one requests permission - after permission is granted, the agent is not resumed
  right after, only when another agent run is finished.
- 
- [ ] Rule management.
- [ ] Auto mode per chat override.
- 
- [ ] Polish Role Feature. Polish View/Edit screen. Role management: create, read, update, delete – should be available via both UI for user and MCP for admin. Role permissions management - only UI.
- [ ] Participant management: when admin creates a participant, it should first check if the participant is already in
  the system. If no, create and make it available for future use. It will allow to attach rules to them and reuse.
- 
- [ ] Add gemini
- [ ] User-friendly delivery
- ✅ Accordance skill.
- ✅ User skill mentioning
- ✅Auto-review mode.
- ✅ Not block when the agent is running, add indicators that chat state is running or run finished.
- ✅ Stop agent.
- ✅ File references from messages.
- ✅ Image pasting.
- ✅ MCP status tool for agents to indicate what they are doing.

## POST MVP TODO
- [ ] User skill management: sync
- [ ] Tool management.


## MVP Acceptance Checklist

- A fresh install can start with no saved participants and open an admin chat.
- The first screen and primary workflow make chat conversations the main object.
- A user can create a role, create two participant presets, select them, and start a chat.
- A participant is understandable by its handle, role, skills, and permissions before provider implementation details.
- A user can start one chat with both Codex CLI and Claude Code participants.
- A user can mention one participant and receive a response.
- A user can mention multiple participants and receive parallel responses.
- A user can approve a participant-to-participant request between participants backed by different local CLI providers.
- A user can maintain an app-managed skill, mention or attach it in chat, and see it applied through the correct provider-specific setup.
- A participant can request another participant, and the user can approve or reject that request.
- A participant can ask a user-choice question, and the user can send a selected or custom answer back.
- A user can add a participant to an existing chat manually.
- The Administrator can request a participant addition through the app tool, and the user can deny, allow once, or allow for chat.
- Participant permissions affect runtime behavior for repo read, shell, edits, and web access.
- Plan mode blocks shell and edits.
- Chat history survives app restart.
- Older messages can be paged in.
- Stop cancels an in-flight chat turn.
- Unknown mentions, missing CLIs, duplicate handles, invalid roles, and invalid shell rules produce useful errors.

## Open Product Decisions

- Whether to keep all 19 built-in roles in the MVP or ship a smaller default set.
- Whether empty admin chat should be the primary onboarding path.
- What syntax should be used for skill mentions or attachments.
- Whether Gemini-compatible skill setup means a local/no-API runtime in MVP or only a renderer/export target until hosted APIs return.
- Whether live participant removal and editing should be added before release.
- Whether role deletion is needed before release.
- Whether the product name and UI copy should stop using legacy "consensus", "Slack", and non-chat terminology.
