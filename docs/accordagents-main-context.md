# AccordAgents Main Context For Landing Page

This document is a source-of-truth product context for writing a landing page, README introduction, launch copy, demo script, or short product narrative for AccordAgents.

It is intentionally factual and devtool-oriented. It should describe the product as it currently exists, not as a speculative multi-agent platform. When writing public copy from this document, preserve the local-first and user-controlled framing, and avoid overstating future roadmap items as shipped features.

## Product Snapshot

AccordAgents is an open-source macOS desktop app for running local multi-agent chats with CLI agents. It gives the user one shared conversation where named participants backed by Codex CLI and Claude Code can respond to the same context, ask each other for input, request permissions, and continue work under user approval.

The product is built as an Electron desktop app with TypeScript, React, Vite, and Electron Forge packaging. The app is designed for macOS and packages as a macOS app, ZIP, and DMG. The Electron packaging config sets `AccordAgents` as the product name and requires macOS 13.0 or later.

The first-release product surface should be described as chat-first:

- One local chat workspace for multiple CLI-backed AI participants.
- Local CLI providers: Codex CLI and Claude Code.
- Provider-neutral participant identities with roles, handles, avatars, modes, optional model overrides, and permissions.
- Human-approved collaboration between participants, not an unattended swarm.
- Optional repository context, file mentions, image attachments, threads, approvals, and persistent chat history.
- Local app MCP tools that let participants request context, participants, attachments, and permission changes through app-controlled channels.

Open-source positioning note: the project can be described as open-source in product positioning, but the repository currently has no `LICENSE` file. Public copy should not name a specific license until one is added.

## One-Paragraph Product Promise

AccordAgents is a macOS desktop chat workspace where you can bring local Codex CLI and Claude Code agents into one shared conversation, give each participant a reusable role and permission envelope, and stay in control of every handoff. Mention an agent, attach screenshots, approve participant-to-participant requests, and keep the full chat history available locally so the same conversation can continue later.

## What AccordAgents Is

AccordAgents is a desktop coordination layer for local CLI agents. The main object is not a terminal pane, task board, hosted model router, or automatic agent workflow. The main object is the conversation.

The user creates or opens a chat, chooses participants, and talks to them with normal chat messages. Each participant is a named actor such as `@admin`, `@drew-codex-engineer`, or `@taylor-claude-engineer`. Behind that identity, the app launches the selected local CLI runtime, applies the participant's role instructions and permissions, and gives the agent access to app-managed context through the local bridge.

The user decides who responds. Messages use `@handle` mentions to dispatch work. Mentioning one participant runs one participant. Mentioning multiple participants can run them in parallel from the same conversation snapshot. Normal prose mentions are not treated as automatic handoffs unless they are part of the app's explicit participant-request flow.

The product is designed to let several local CLI-backed AI agents participate in the same thread without making the user manually copy context between tools. Codex and Claude can read the same chat history, see relevant repository/file context when allowed, request another participant when they need a second opinion, and ask the user to approve blocked capabilities.

The app is also a control surface. It tracks participant configuration, role versions, model overrides, provider health, approvals, conversation history, repository context, attachments, run state, and local MCP token scope. That makes multi-agent chat more inspectable than manually running several CLI windows and pasting messages between them.

## Who It Is For

AccordAgents is for users who already use local AI coding CLIs and want those agents to collaborate in one conversation with less manual coordination.

Primary users:

- Software engineers who use Codex CLI, Claude Code, or both.
- Developers who want one agent to implement, another to review, and a third to synthesize next steps while keeping the human in control.
- Technical founders and product builders who want named specialist roles for product, engineering, QA, release, security, naming, and marketing review.
- Teams experimenting with local CLI agents but not ready to hand work to an autonomous multi-agent swarm.
- Users who want durable chat history, repository context, file references, screenshots, and approval controls around agent work.

Good fit use cases:

- Ask Codex and Claude to inspect the same codebase question from one shared chat.
- Give one participant a software engineer role and another a QA or security reviewer role.
- Ask a participant to request another participant's input only when it has a concrete reason.
- Let an agent request file edit, web access, repository read, or shell command permission through the app instead of silently escalating.
- Keep a long-running project conversation with context, threads, and prior decisions.

Poor fit use cases:

- Hosted API model comparison.
- A generic terminal multiplexer.
- Fully autonomous background task execution.
- A cloud agent orchestration platform.
- Automatic swarm workflows where agents run without user approval.
- Public claims about broad provider support beyond the local CLI providers currently supported by chat.

## Core Workflow

1. Configure local CLIs.

   AccordAgents detects Codex CLI and Claude Code installation status, executable paths, versions, errors, enablement, and app skill sync health. Chat participants run through these local CLI tools. The app itself does not need hosted API-key setup for the chat-first MVP UI; local CLIs use their own installed runtime and authentication configuration.

2. Define roles and participants.

   The user can use built-in role instructions or create/edit reusable roles. A saved participant preset combines a handle, role, local CLI provider, optional model override, avatar, agent mode, and permissions.

3. Start a chat.

   The user creates a chat, optionally selects a repository, and adds saved participants. If no saved participants are selected and a suitable local CLI is available, the app can start an admin-only chat using the built-in administrator role.

4. Mention participants.

   The user sends messages with `@handle` mentions. Mentioning multiple participants dispatches parallel runs. Messages without a relevant mention are saved as conversation context rather than automatically triggering every participant.

5. Share context.

   The chat can include normal text, repository file mentions using `#path`, and image attachments. The selected repository can be inspected for branch and status information. Repository access is still controlled by each participant's permissions.

6. Approve handoffs and escalations.

   Participants can request other participants, ask the user to choose between options, or request capability changes through app MCP tools. The app validates these requests and presents approval controls before applying them.

7. Continue the conversation.

   Chat history is persisted locally. The app can reopen prior conversations, page older messages, show threads, recover interrupted pending runs as warnings/errors, and continue work from the stored transcript.

## Current Feature Inventory

### Shared Multi-Participant Chat

AccordAgents supports chat conversations with multiple named participants. Each participant has:

- A stable app-generated ID.
- A visible `@handle`.
- A reusable role configuration.
- A local CLI provider, currently `codex-cli` or `claude-code`.
- Optional model override.
- Optional avatar.
- Agent mode.
- Permission envelope.

Participants appear in the chat UI with identity, status, and session/runtime details when available. The app keeps participant records in chat metadata, so each conversation has its own roster snapshot.

### Local CLI Providers

Chat currently supports Codex CLI and Claude Code participants. The app detects both local CLIs and records:

- Whether the CLI is installed.
- Path.
- Version.
- Errors.
- App-owned bridge skill sync status.

The app can enable or disable these local providers in settings. Optional model strings can be configured globally or per participant, with runtime sessions recreated when relevant participant or role configuration changes.

### Roles

Roles are reusable instruction templates. The app includes built-in roles and lets the user create or edit custom role instructions. Saving an existing role increments its version, and live participant sessions keep role snapshots until the app recreates the runtime session.

Built-in roles include practical specialist identities such as:

- Administrator.
- Synthesizer.
- Arbiter.
- Software Engineer.
- Product Strategist.
- Brand Strategist.
- Naming Consultant.
- Product Marketer.
- UX Content Strategist.
- Trademark Attorney.
- Domain and SEO Specialist.
- Engineering Manager.
- Product Designer.
- Developer Experience Reviewer.
- Debugger.
- QA Lead.
- Security Reviewer.
- Release Engineer.
- Code Reviewer.

The Administrator role is special because it has participant management capability. Public copy should explain that roles are reusable instruction profiles, not separate hosted accounts.

### Saved Participant Presets

Saved participants are reusable presets that become concrete chat actors when copied into a conversation. A preset includes:

- Handle.
- Role.
- Provider: Codex CLI or Claude Code.
- Optional model override.
- Agent mode.
- Permissions.
- Avatar.

The renderer validates handles, provider availability, role selection, duplicate handles, and permission rule safety before a participant is used. Later edits to saved participant presets do not automatically rewrite existing chat rosters.

### Mention Dispatch

The chat composer supports participant mention autocomplete using `@`. Dispatch is mention-based:

- `@participant` runs that participant.
- Multiple mentions can run multiple participants in parallel.
- Unknown handles produce a system warning.
- If a chat only contains `@admin`, a user message without an explicit mention can dispatch to admin.
- Otherwise, messages without participant mentions are recorded but do not automatically run every participant.

This is one of the core product differentiators: the user controls which local agent gets each prompt.

### Parallel Participant Runs

When multiple participants are mentioned, AccordAgents can run them from the same conversation snapshot. Active chat runs are tracked with run IDs, and concurrent conversation mutations go through the chat service mutation queue so concurrent runs do not overwrite each other with stale snapshots.

The renderer shows pending participant bubbles immediately. Long turns can stream visible text or at least activity and elapsed-time status before the final answer replaces the pending message.

### Participant-To-Participant Requests

Participants can ask other participants to respond through the app-managed participant request workflow. This can happen through explicit app MCP tools and inferred participant-request protocol blocks.

The important landing message is not "agents freely talk to each other." The accurate message is "agents can ask for another participant, and the user approves the handoff."

The workflow supports:

- Requesting one or more target participants.
- Providing a concrete prompt and reason.
- Showing pending approval in the UI.
- Approving or denying the request.
- Running approved participants.
- Returning to the original requester after replies when requested and allowed.
- Tracking request status, replies, errors, and completion.

### User Choice Cards

Participants can ask the user to choose between concrete options. The app parses a structured `User choice:` block and renders a decision card in the chat UI.

The user can:

- Pick a listed option.
- Add an optional note.
- Write a custom answer.
- Send the selected answer back to the requesting participant.

This is useful when an agent needs a product, design, implementation, or prioritization decision before continuing.

### App Tool Approvals

The app exposes local MCP tools to participants, but state-changing or capability-changing requests are approval-gated.

Current approval categories include:

- Permission requests.
- Participant requests.
- Roster change requests from participants with participant-management capability.

The UI shows approval cards with the requester, summary, reason, operation, and approve/deny actions. Some approvals can be allowed once, while others can be allowed for the current chat when policy permits it.

### Participant Permissions

Each participant has a permission envelope. This is one of the most important current features for landing copy because it turns local CLI agents into controlled chat participants instead of unrestricted command runners.

Permission fields include:

- `repoRead`: whether the participant can read the selected repository as context.
- `workspaceWrite`: whether the participant can edit files.
- `webAccess`: whether web search/fetch capability is available.
- `shell.enabled`: whether shell commands are available.
- `shell.rules`: command-specific allow, ask, or deny rules with exact or prefix matching.
- Claude Code provider-native allowed tool grants where configured or approved.

Agent modes include:

- `default`: normal local CLI behavior under the configured permissions.
- `plan`: blocks shell commands and file edits even if permissions would otherwise allow them.
- `auto`: uses configured permissions and native approval behavior where supported.

Agents can request portable permission grants, shell rules, or Claude-native allowed tools through app MCP. Broad shell access is not granted through that request tool; agents request explicit shell rules instead.

### Repository Context

A chat can run with or without a repository. When a repository is selected, AccordAgents can inspect it and show:

- Repository path.
- Whether it is a Git repository.
- Current branch.
- Available branches.
- Changed path count and status lines.
- Errors when the selected path is not a Git repository.

Participant access to the repository is controlled by `repoRead` and mode settings. If repository read is blocked, or if no repository is selected, the participant runs against the app-managed chat history directory instead of the project repository.

### Repository File Mentions

The composer supports `#path` file mentions when a repository is selected. The app can search repository files, attach validated file references to the message, and include a "Referenced repository files" section in prompt/history context.

File mentions are validated so paths cannot escape the repository. If a participant lacks repository read permission, the prompt explains the blocked state and the permission escalation path.

This is a concrete app capability, but current landing copy should emphasize rules, decisions, permissions, and history rather than repository file handling.

### Image Attachments

Chat messages support image attachments. The feature is designed for macOS screenshot workflows and also supports file picker and drag/drop.

Current attachment support:

- PNG.
- JPEG.
- WebP.
- Up to 5 images per message.
- Up to 10 MB per image.
- Up to 8192 px per side.
- Up to 25,000,000 pixels per image.

Images are stored outside SQLite under app `userData`, scoped by conversation. Message metadata stores attachment information, not image bytes. Attachments can be listed, read, and exported by app MCP tools scoped to the issued participant token, so agents can inspect durable attachment IDs or copy exact image bytes into the selected repository without receiving arbitrary local filesystem access.

Landing page copy can honestly say that AccordAgents supports screenshots and image attachments in chat, with local app-managed storage and scoped agent access.

### Threads

The chat UI supports threaded replies. Any non-system message can be opened as a thread root. Thread replies preserve thread metadata and can be shown in a resizable thread panel.

Thread features include:

- Reply counts on top-level messages.
- Thread-specific composer.
- Mention autocomplete inside threads.
- File mention and image attachment support in thread composers.
- Top-level timeline hiding thread replies so the main chat stays readable.

This matters for multi-agent conversations because follow-up debates and participant request replies can stay grouped instead of flattening every message into one long timeline.

### Run Control And Progress

AccordAgents tracks active chat runs and supports cancellation. The renderer can show:

- Pending participant reply bubbles.
- Streaming text when available.
- "Thinking" or activity status when text is not yet available.
- Elapsed time.
- Tool activity summaries such as reading, searching, listing, running commands, or using named tools.
- Completion and error states.
- System warnings.

Interrupted or stale pending runs are recovered as warnings/errors when conversations are reopened, so users are not left with unexplained running state after a restart.

### Persistent Local History

Conversations are persisted in Electron `userData`. The storage layer uses a local SQLite database named `accordagents.sqlite3` and also writes chat history files under:

```text
userData/chats/<conversationId>/history.md
userData/chats/<conversationId>/history.json
```

Message bodies are stored separately for paging, so older messages can be loaded without keeping every full conversation body in the initial sidebar list. The sidebar can show conversation summaries, update times, unread/running state, and project grouping.

Public copy should describe this as local persistent chat history, not cloud sync.

### Local App MCP Bridge

AccordAgents runs an app-managed MCP bridge inside the Electron main process. It listens on loopback (`127.0.0.1`) and is intended for CLI agents launched by the app, not arbitrary local clients.

Participant sessions receive scoped bearer tokens. The token identifies the conversation, participant, role snapshot, capabilities, trigger message, thread, and request context. This lets the app expose useful tools while enforcing conversation and participant scope.

Read-only app MCP tools include:

- Get current chat context.
- Get current participants.
- Read paginated messages.
- List visible attachments.
- Read visible image attachments.
- Get participant request status.

Repository-writing app MCP tools include:

- Export visible image attachments into an existing directory under the selected repository when the participant run has effective `workspaceWrite`.

Approval-gated tools include:

- Request participant responses.
- Request permission changes.
- Request roster changes when the participant has participant-management capability.

This bridge is a major product differentiator, but copy should keep it understandable: "agents can ask the app for scoped context and request approvals through a local bridge."

### App-Owned Bridge Skills

The app includes bundled app-owned skills that help local agents understand how to reply in AccordAgents chat and how to request other participants. `AppSkillsService` syncs those internal bridge skills into Codex and Claude skill locations when the corresponding CLI provider is installed and available.

This is infrastructure for the app protocol. It is not the same as a complete user-facing skill manager. Public feature copy should not claim that AccordAgents currently provides a full skill library editor, provider-to-provider skill marketplace, or broad user-skill sync UI unless that feature is added.

Safe wording:

- "AccordAgents syncs app-owned bridge skills for supported local CLIs when available."
- "Local agents receive app-specific instructions for chat replies and participant requests."

Avoid wording:

- "Manage all your Codex and Claude skills."
- "One-click sync any skill between providers."
- "Universal skill library."

### Settings And Local Setup

Settings currently cover local CLI provider enablement, provider health, role management, and saved participant management. The app also retains the last repository path.

The chat-first landing page should focus on:

- Detect Codex CLI and Claude Code.
- Enable or disable local CLI providers.
- Configure roles.
- Configure saved participants.
- Set participant permissions.
- Use optional model overrides where available.

Hosted OpenAI, Anthropic, and Gemini API-key setup should not be advertised for the current chat-first product.

### macOS Desktop Packaging

AccordAgents is packaged as a macOS desktop app through Electron Forge. The current packaging config includes:

- Product name: `AccordAgents`.
- App bundle ID default: `com.juliakrivchikova.accordagents`.
- Minimum macOS version: `13.0`.
- DMG maker.
- ZIP maker.
- App icon path.
- Hardened runtime and notarization configuration when the required Apple signing environment variables are present.
- Electron fuses that disable Node-as-node behavior and tighten packaged app loading.

Landing copy can say "macOS desktop app." Avoid claiming App Store availability, automatic update availability, signed distribution status, or notarization status unless the release artifact being promoted has been built and verified with those properties.

## Local-First And Security Boundaries

The security and control story should be stated plainly.

AccordAgents is local-first in the sense that the desktop app, settings, chat storage, history files, attachments, app MCP bridge, and CLI orchestration run on the user's Mac. Chat history is stored under Electron `userData`, not in an AccordAgents cloud service.

Important boundaries:

- The app runs local CLI agents; those CLIs may call their own model providers according to their own configuration.
- The chat-first UI does not require users to enter hosted provider API keys into AccordAgents.
- The app MCP bridge listens only on loopback.
- App MCP calls use scoped bearer tokens issued per participant session.
- State-changing app tool requests require validation and user approval.
- Participant permissions constrain repository access, file edits, shell use, and web access.
- Image attachment tools expose app-managed attachment IDs, not arbitrary storage paths; exports are constrained to repository-relative targets under the selected repository.
- Repository file mentions are validated against the selected repository and cannot escape it.
- Agent sessions are recreated when role versions, provider configuration, model, mode, permissions, app tool capabilities, or runtime config versions change.

Good landing framing:

- "Local desktop app, local CLI agents, local chat history."
- "Human-approved handoffs between agents."
- "Per-participant permission envelopes."
- "Agents request more access through approval cards instead of silently escalating."

Avoid framing:

- "Private by default" without explaining that local CLIs may still use external model services.
- "Offline AI" because Codex CLI and Claude Code typically depend on provider access.
- "No data ever leaves your machine" unless separately verified for the exact local CLI configuration.

## Landing Page Messaging Ingredients

### Suggested Hero Direction

Headline options:

- AccordAgents
- AI agents in one project workspace
- Coordinate local CLI agents in one shared project workspace

Subheadline options:

- Coordinate AI agents in one macOS workspace while rules, decisions, permissions, and history stay attached to the project.
- Mention local CLI agents by name, share repository context and screenshots, and choose when they ask for approval.
- A human-controlled project workspace for AI agents, with task-focused chats, roles, configurable permissions, attachments, and persistent context.

Primary CTA options:

- Download for macOS
- View on GitHub
- Start a local agent chat

Secondary CTA options:

- Read the docs
- See current features
- Watch demo

Use only CTAs that match the current distribution channel and assets.

### Short Product Description

AccordAgents is a macOS desktop app for coordinating AI agents in one shared project workspace. Create named participants backed by local CLI runtimes, give them reusable roles and permission envelopes, mention them with `@handle`, attach screenshots, and choose when handoffs or permissions require approval.

### Positioning Statement

For people coordinating project work with multiple AI agents, AccordAgents is a desktop chat workspace that keeps agents in the same conversation under user-controlled roles, context, and permissions. Unlike terminal multiplexers or hosted model routers, AccordAgents treats the conversation as the main workspace and keeps agent handoffs explicit and configurable.

### Differentiators

- Shared conversation instead of copy-paste between separate CLI sessions.
- Provider-neutral participant identities backed by local CLI runtimes.
- User-controlled `@handle` dispatch instead of automatic all-agent fan-out.
- Configurable approvals for participant requests and permission escalations.
- Per-participant repository, shell, edit, and web permissions.
- Local app MCP bridge for scoped context and app-controlled tools.
- Persistent local chat history, threads, file mentions, and image attachments.
- macOS desktop workflow for people already using local AI CLI agents.

### Feature Grouping For A Landing Page

Suggested landing sections:

1. Shared local chat.

   Explain that local CLI-backed participants can join the same conversation, with handles, roles, avatars, and persistent history.

2. Control every run.

   Explain mention dispatch, parallel participant runs, run cancellation, streaming/pending responses, and visible progress.

3. Approvals, not swarms.

   Explain participant-to-participant requests, permission requests, roster change requests, user choice cards, and saved approval behavior.

4. Work with real project context.

   Explain optional repository context, branch/status inspection, `#path` file mentions, and image attachments for screenshots.

5. Local desktop boundaries.

   Explain local app storage, local CLI execution, loopback MCP bridge, scoped tokens, and per-participant permissions.

### Demo Script Outline

1. Open AccordAgents on macOS.
2. Show Codex CLI and Claude Code detected in settings.
3. Create or select two saved participants, for example a Codex-backed engineer and a Claude-backed reviewer.
4. Start a chat with a repository selected.
5. Mention `@engineer` with a task and reference a file using `#path`.
6. Attach a screenshot or image.
7. Mention both participants to get parallel responses.
8. Show a participant requesting another participant's input.
9. Approve the request.
10. Show the answer returning in the same conversation/thread.
11. Show a permission request card if the agent needs repo read, web, edit, or shell access.
12. Reopen the chat history to show persistence.

### Proof Points To Capture For The Landing Page

Useful screenshots or short clips:

- Chat setup screen with saved participants.
- Settings screen showing local Codex CLI and Claude Code health.
- Role editor with built-in roles.
- Participant preset editor with permissions.
- A chat where two participants are mentioned in one message.
- Pending participant response streaming or showing activity.
- Approval card for a participant request.
- Permission approval card.
- User choice card.
- Thread panel with replies.
- Composer with `@handle`, `#path`, and image attachment previews.
- Sidebar with persistent conversation history.

## Claims To Avoid Or Soften

Do not advertise these as current shipped features:

- Hosted OpenAI, Anthropic, or Gemini API workflows in the chat MVP UI.
- Gemini as an active chat runtime.
- Full user-facing skill library management.
- One-click sync of arbitrary user skills between providers.
- Generic terminal/session management.
- Worktree automation.
- Fully autonomous multi-agent swarms.
- Cloud sync.
- Team collaboration in a hosted workspace.
- App Store distribution.
- A named open-source license.
- "No data leaves your machine" as an absolute claim.
- "Private by default" without the local CLI/provider caveat.
- Broad "all models" or "all agents" provider support.
- The legacy consensus/review/debate modes as the first-release product promise.

Safer alternatives:

- Say "local CLI agents" instead of "all AI agents."
- Say "Codex CLI and Claude Code" instead of "every model."
- Say "human-approved handoffs" instead of "autonomous swarm."
- Say "local app storage" instead of "cloud-free privacy guarantee."
- Say "chat-first" instead of "workflow automation platform."
- Say "app-owned bridge skills" instead of "universal skill management."

## Source Notes From The Repo

This section records where the product facts above come from, so future copywriters and agents can refresh the document when the app changes.

- `package.json`
  - Product name: `AccordAgents`.
  - Package name: `accordagents`.
  - Repository metadata points to `https://github.com/juliakrivchikova/AccordAgents-desktop-app.git`.
  - Package description is "Desktop app for multi-participant AI chat that debates a question or code diff and converges on a consensus answer." (chat-first positioning).
  - Scripts include build, dev, packaging, typecheck, and targeted service tests.

- `forge.config.ts`
  - Electron Forge packaging config.
  - Product name: `AccordAgents`.
  - macOS minimum version: `13.0`.
  - DMG and ZIP makers for Darwin.
  - Signing and notarization are configured through environment variables, not guaranteed by source alone.

- `docs/chat-only-mvp.md`
  - Strongest source for chat-first positioning.
  - Defines the MVP as local desktop multi-participant AI chat with local CLI agents.
  - Explicitly warns against positioning the first release as hosted provider routing, terminal multiplexing, or generic autonomous orchestration.
  - Contains both current and desired items; landing copy should only promote current capabilities unless future work is clearly labeled.

- `docs/chat-roles-and-participants.md`
  - Source for role, participant, prompt envelope, and app MCP contract details.
  - Reinforces that chat role/participant behavior is a contract across main service, shared types, storage, and renderer UI.

- `docs/image-attachments-implementation.md`
  - Source for image attachment storage, validation limits, renderer behavior, MCP tools, and agent propagation.
  - Supports current claims about PNG/JPEG/WebP attachments and local app-managed storage.

- `docs/skill-management-design.md`
  - Source for the distinction between internal app-owned bridge skills and future user-facing skill management.
  - Important warning: do not advertise a full user skill manager until that separate feature exists.

- `src/shared/types.ts`
  - Source for provider types, conversation kinds, chat participant shape, permissions, approval types, image attachment shape, app skill sync health, agent health, Git repo info, and bridge interface types.
  - Confirms chat provider kinds are `codex-cli` and `claude-code`.

- `src/main/services/chat.ts`
  - Source for chat orchestration, message dispatch, participant runs, approvals, permissions, app MCP integration, image attachment handling, repository file mention validation, history files, concurrent run state, and cancellation behavior.

- `src/main/services/cliAgents.ts`
  - Source for Codex CLI and Claude Code detection/execution, warm/one-shot behavior, permission mapping, MCP configuration, context usage extraction, and provider-specific runtime handling.

- `src/main/services/appMcp.ts`
  - Source for local loopback app MCP tools, bearer token actor scope, chat context tools, participant request tools, permission request tools, roster change tools, and image attachment tools.

- `src/main/services/appSkills.ts`
  - Source for app-owned bridge skill sync into supported provider skill locations.
  - Confirms this is infrastructure, not a user-facing skill library manager.

- `src/main/services/settings.ts`
  - Source for default providers, built-in role definitions, role saving, participant preset saving, and validation.

- `src/main/services/storage.ts`
  - Source for local SQLite storage path and conversation persistence model.

- `src/main/services/git.ts`
  - Source for repository inspection, diff support, branch/status information, and repository file search used by chat file mentions.

- `src/renderer/App.tsx`
  - Source for current renderer surfaces: chat setup, settings, roles, participants, permissions panel, chat timeline, composer, file mention autocomplete, image attachment UI, app tool approval cards, user choice cards, thread panel, and sidebar history.

## Maintenance Guidance

Update this document when any of these product facts change:

- A new chat runtime becomes supported.
- Hosted provider setup returns to the public first-release UI.
- User-facing skill management ships.
- The product gets a LICENSE file and public license name.
- macOS distribution channel, signing, notarization, or minimum OS version changes.
- App Store, auto-update, or cloud sync claims become true.
- Non-chat consensus/review/planning modes become part of the public product promise again.
- Permissions, app MCP tools, or participant request behavior materially changes.

When using this document for landing page generation, prefer concrete workflow copy over abstract "multi-agent orchestration" language. The strongest current story is: one macOS chat, local Codex and Claude participants, shared context, explicit mentions, human approvals, per-participant permissions, and persistent local history.
