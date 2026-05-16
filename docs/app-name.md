# App Naming Research

This document tracks naming research for the chat-only MVP.

Research status: quick web/name-collision scan, not legal or trademark clearance. Treat every "avoid" below as a product/SEO/market collision signal, not a legal conclusion.

Research date: 2026-05-16.

## Current Product Positioning

The current MVP is no longer a broad consensus/review/workflow app. It should be positioned as:

> A local-first shared chat workspace where multiple CLI agents can participate in one conversation, with app-managed roles, skills, permissions, approvals, and user-controlled handoffs.

Important product principles:

- Conversation is the main object.
- Participants are provider-neutral identities backed by local CLIs.
- Collaboration is human-moderated, not an automatic swarm.
- Skills are app-managed once and rendered into provider-specific setup.
- The MVP is API-free in the UI: local Codex CLI and Claude Code only.

Names should avoid suggesting that the product is mainly:

- A generic terminal/session manager.
- A worktree or task-board manager.
- A hosted model router.
- A config sync utility only.
- A generic autonomous agent orchestration platform.

## Naming Takeaways

- Avoid bare `Agent*` names. The space is crowded, generic, and full of direct competitors.
- Avoid `Sync`, `Relay`, `Mux`, `Hub`, `Room`, `Board`, `Bridge`, `Switchboard`, and `Roundtable` unless the name is very distinctive. Those words are already heavily used in agent tooling.
- Avoid bare `Tandem`. It has the right feel, but it is already heavily occupied in AI/devtools and adjacent chat/workspace markets.
- Prefer names that imply moderated conversation, shared context, provider-neutral participants, and user control.

## Explored Names With Collision Signals

| Name / direction | Collision found | Decision |
| --- | --- | --- |
| `AgentSync` | Direct collision with [AgentSync](https://dallay.github.io/agentsync/guides/mcp/), which syncs MCP/config across Claude, Copilot, Codex, Gemini, Cursor, OpenCode, etc.; also [agent-sync](https://uphy.github.io/agent-sync/) for converting context/commands/modes across agents. | Avoid. Too close to config/skill sync competitors. |
| `AgentManager` | Generic and already used in several contexts, including WSO2 Agent Manager and package/library names. | Avoid. Too generic and hard to own. |
| `AgantManager` | Fewer direct hits because it looks misspelled. | Avoid. Reads like a typo. |
| `AgentHub` | Direct adjacent collision: [AgentHub](https://www.agenthub-app.com/) runs Claude Code, Codex, Gemini CLI, and OpenCode sessions in persistent terminal sessions. | Avoid. Direct competitor naming territory. |
| `AgentRoom` | Direct adjacent collision: AgentRoom desktop app visualizes Claude/Codex/Gemini coding agent sessions; also AgentRoom MCP/chat-room experiments appear in search results. | Avoid. Too close to agent-session/chat-room tooling. |
| `AgentMux` | Direct adjacent collision: [AgentMux](https://agentmux.ai/) is a local-first AI agent control plane, plus [agentmux.app](https://agentmux.app/) for managing multiple coding agents. | Avoid. Direct competitor territory. |
| `AgentRelay` / `Agent Relay` | Direct collision: [Agent Relay](https://agentrelay.com/) is positioned as Slack for agents; [AgentRelay](https://agentrelay.tech/) is a bridge layer for agent task/dialogue relay. | Avoid. Direct cross-agent communication competitor. |
| `AgentBridge` | Multiple direct/adjacent uses, including MCP gateway/agent bridge products and domains. | Avoid. Crowded and close to provider-bridge positioning. |
| `AgentDesk` | Direct/adjacent uses for agent dashboards and desktop agent tools. | Avoid. Crowded. |
| `AgentBoard` | Multiple collisions: agent Kanban/project boards, coding stats/leaderboards, task managers, and the AgentBoard benchmark. | Avoid. Crowded and task-board oriented. |
| `AgentRoster` | Collision with AgentRoster AI agent/skill marketplace and UI component names such as Depute AgentRoster. | Avoid. Too close to agent directory/roster products. |
| `AgentFoundry` | Collision with agentfoundry-style dev tools/sites. | Avoid. Crowded enough to be risky. |
| `AgentMeld` | Collision with [AgentMeld](https://www.agentmeld.com/) / agentmeld.com style distributed agent orchestration. | Avoid. Direct agent-orchestration signal. |
| `AgentPatch` | Collision with [AgentPatch](https://agentpatch.ai/), context-optimized APIs/tools for AI agents. | Avoid. Adjacent AI agent infra. |
| `AgentFloor` | Collision with [AgentFloor](https://agentfloor.ai/) agentic marketplace and AgentFloor benchmark/research. | Avoid. |
| `AgentDocket` | Collision with existing AgentDocket legal-services site. | Avoid unless a very different brand direction is needed. |
| `AgentWright` | Collision with [AgentWright](https://www.agentwright.ai/) AI agent consulting/buildout business. | Avoid. |
| `Roundtable` / `AI Roundtable` / `AgentRoundtable` | Direct collision: [Roundtable AI](https://www.round-table.ai/) brings Claude, ChatGPT, Grok, and Gemini into unified conversations; many multi-agent debate/roundtable tools also exist. | Avoid. Very close to multi-model conversation positioning. |
| `PromptLayer` | Collision with [PromptLayer](https://promptlayer.com/prompt-management), established prompt management/versioning. | Avoid. |
| `ContextForge` | Collision with [ContextForge](https://contextforge.dev/), persistent memory via MCP across Claude Code, Copilot, Cursor, Claude Desktop, etc. | Avoid. Adjacent context/memory layer. |
| `Handoff` | Many collisions, including [Handoff](https://handoff.computer/) shared context for humans/agents, Handoff customer-service products, and agent/file handoff products. | Avoid. Crowded and close to cross-agent context transfer. |
| `Patchbay` | Multiple AI/agent uses, including Patchbay Relay and AI operations platforms; also generic audio/ops meaning. | Avoid. |
| `Switchboard` / `AgentSwitchboard` / `ModelSwitchboard` | Many collisions: AI switchboard products, agent directories, model-routing libraries such as `model-switchboard`, healthcare/call-center switchboards. | Avoid. Very crowded. |
| `Relay` / `ModelRelay` | Collision with [ModelRelay](https://modelrelay.ai/) / [modelrelay.io](https://modelrelay.io/) and agent relay products. | Avoid. Too infrastructure-like and crowded. |
| `ModelBridge` | Collision with modelbridge-style tools/sites. | Avoid. Model-router/infra signal. |
| `ModelRoom` | Collision with [ModelRoom](https://modelroom.ai/) creative/agentic interface for video ads and other ModelRoom uses. | Avoid. |
| `ModelMeld` | Collision with [modelmeld.com](https://www.modelmeld.com/) and 3D AI design references. | Avoid. |
| `ModelBoard` | Collision with [ModelBoard](https://modelboard.net/) and other model-board meanings. | Avoid. |
| `ModelMux` / `ChatMux` / `SkillMux` | `AgentMux` and `Modelmux` are already used; `ChatMux` also appears as an AI/RL project name. | Avoid. |
| `SkillBridge` | Collision with DoD SkillBridge and skill-bridge domains. | Avoid. |
| `SkillMeld` | Collision with skillMeld youth/skills sites. | Avoid. Weak product fit anyway. |
| `SkillRelay` | Collision with SkillRelay AI/judgment inheritance and skill exchange references. | Avoid. |
| `SkillWright` | Collision with SkillWright education/skilling company. | Avoid. |
| `ThreadMeld` | Collision with ThreadMeld brand/merchandise development studio. | Avoid. |
| `ThreadWise` / `AgentThread` / `ModelThread` | ThreadWise is an AI insurance operations platform; AgentThread is used in Microsoft agent APIs. | Avoid. Crowded and not distinctive enough. |
| `ThreadWright` | Collision with Threadwright costume/patterning brand and other references. | Avoid. |
| `ConvoForge` | Collision with [ConvoForge](https://convoforge.net/), an open-source chat platform. | Avoid. |
| `ConvoKit` | Collision with [ConvoKit](https://convokit.cornell.edu/) conversation-analysis toolkit and [convokit.dev](https://convokit.dev/) AI support widget. | Avoid. |
| `ConvoDesk` | Collision with Convodesk AI receptionist product. | Avoid. |
| `ConvoLayer` | Search results are less direct, but close to `Convo*` crowded space and generic conversation-infra naming. | Avoid unless rechecked deeply. |
| `Rostra` | Collision with Rostra communications firm and Rostra AI public-sector product references. | Avoid. |
| `Rostrum` | Collision with [Rostrum](https://rostrum.dev/) engineering AI playbooks and [Rostrum AI](https://www.rostrum-ai.pro/) enterprise AI platform. | Avoid. |
| `Dais` | Collision with DAIS enterprise AI/execution platforms and other Dais AI products. | Avoid. |
| `Dais-E` | Collision with [Dais-E](https://daise.io/) innovation AI product. | Avoid. |
| `Crewboard` | Existing crew/HR management usage. Less direct AI collision, but weak fit and not very ownable. | Defer/avoid. |
| `Runbook AI` | Collision with runbookai/userunbook-style products. | Avoid. |
| `Tandem` | Strong collisions: [Frumu Tandem](https://tandem.frumu.ai/) local-first AI coding/workflow runtime with `tandem` CLI/TUI, [Tandem Labs](https://tandemlabs.ai/) AI teammates for engineering, [Tandem Browser](https://tandembrowser.org/) local-first browser for agents, [Tandem Chat](https://play.google.com/store/apps/details?id=chat.tandem.android) team chat/virtual office, [Tandem Health](https://www.tandemhealth.ai/) AI medical scribe, [withtandem.com](https://withtandem.com/) medication access AI, [tandemai.io](https://tandemai.io/) hardware engineering AI, plus USPTO-style software/AI filings for `TANDEM`. | Avoid as public product name. Good internal codename only. |
| `Smith` | Strong direct/adjacent collision: [Smith](https://getsmith.dev/) is a multi-agent command center for Claude Code, Codex, Gemini CLI, Aider, and OpenCode; [Try Smith](https://trysmith.dev/) runs multiple Claude Code agents in parallel; [Smith.ai](https://smith.ai/) is an established AI/live-agent receptionist company; `Agent Smith` is heavily used in AI tooling/research. | Avoid. Good craft metaphor, but too occupied in AI/devtools and not ownable enough. |
| `Convene` | Many collisions: [Convene](https://letsconvene.ai/) is a meeting/conversation tool, [Convene AI](https://conveneai.com/) is enterprise AI enablement, [Azeus Convene AI](https://www.azeusconvene.com/news/convene-unveils-ai-powered-innovation-for-boardrooms-launches-july-1st) is boardroom AI, [letsconvene.app](https://letsconvene.app/) is a chat product, and [Convena](https://convena.ai/) is close in sound and offers multi-perspective AI advisory. | Avoid. Too crowded around meetings, chat, AI, and multi-perspective advisory. |
| `Convener` / `AgentConvener` | No single obvious commercial app collision found in the quick scan, but `Convener Agent` is a formal concept in multi-agent conversation research / Open Floor Protocol-style work: an agent that initiates or manages multi-party agent conversations. `Convener` is also generic. | Possible but risky. Strong conceptual fit, weak ownability, and would need deeper domain/trademark scan before use. |

## Direct Competitors And Adjacent Products Found

These are the products most relevant to positioning.

### Direct Shared-Agent Chat Competitors

These are the closest matches to "one chat session, add Claude and Codex."

- [agentchattr](https://github.com/bcurts/agentchattr): closest match found. Local shared chat server where humans and agents talk in shared channels. Supports Claude Code, Codex, Gemini CLI, Copilot CLI, and others; agents can mention each other and the server injects prompts into target agent terminals.
- [Band](https://www.band.ai/for-coding-agents): shared workspace/chatroom for coding agents. Very close conceptually, but more platform/infrastructure oriented; examples position Claude Code as planner and Codex as reviewer in one shared Docker workspace/chatroom.
- [Crystl Quest](https://crystl.dev/docs/crystl-quest/): "party of specialized agents" coordinating through shared chat. Primarily Claude Code-focused, with early Codex support and some features tied to Claude hooks.
- [BattleLM](https://www.neura.market/directories/gemini/agents/gh-imd11battlelm): native macOS app described as running multiple AI coding CLIs in one shared/group chat. Found mostly through directory listings, so product quality and activity need deeper verification.
- [Stoops CLI](https://www.mdskills.ai/mcp-servers/stoops-cli): shared chatroom/MCP infrastructure for humans and agents; claims Claude Code, Codex, and humans end up in the same chat room. More CLI/MCP infrastructure than polished desktop product.

### Adjacent Shared Multi-Model / Multi-Agent Conversation

- [Roundtable AI](https://www.round-table.ai/): hosted multi-model conversations with Claude, ChatGPT, Grok, Gemini, comparison, synthesis, and decision trails. Adjacent to shared multi-model chat, but hosted/API-oriented rather than local CLI-agent chat.
- [CliDeck](https://clideck.dev/): runs Claude Code, Codex, Gemini CLI, and OpenCode side by side; Autopilot routes one agent's output to another in worker/reviewer loops. Adjacent to cross-agent handoff, but not primarily a single human-moderated shared chat room.
- [strIDEterm](https://strideterm.com/): includes Worker/Judge task runner where any two of Claude Code, Codex, Gemini, Copilot, or OpenCode can be assigned roles. Adjacent to coding-specific cross-agent workflow.
- [Agent Relay](https://agentrelay.com/): channels, DMs, threads, and real-time messaging for agents. Directly adjacent to agent-to-agent communication, but less specific to local coding CLIs.
- [ModelRelay](https://modelrelay.ai/): durable multi-agent workflows and mailboxes. Infra-oriented but directly adjacent to agents communicating.

### Terminal / Session / Worktree Managers

- [AgentHub](https://www.agenthub-app.com/): persistent terminal sessions for Claude Code, Codex, Gemini CLI, OpenCode, with desktop/CLI/TUI and remote sharing.
- [Smith](https://getsmith.dev/): multi-agent command center for Claude Code, Codex, Gemini CLI, Aider, and OpenCode with tabs/panes, progress/status UI, git worktree isolation, MCP server, config-as-code, remote agents, notifications, and diff review. Adjacent competitor for local CLI-agent management, but not a direct shared-chat-room competitor.
- [Try Smith](https://trysmith.dev/): parallel Claude Code runner with sandboxing, worktrees, live status/progress UI, context battery, and PR flow. Adjacent to multi-agent workflow management; less cross-provider and not positioned as one shared human/agent chat.
- [Canopy](https://canopy.itsol.tech/features/multi-agent): parallel Claude Code, Gemini CLI, Codex, and OpenCode sessions in isolated worktrees.
- [TermLoop](https://termloop.ai/): terminal IDE for Claude Code, Codex, Gemini CLI, Aider, Cline in worktrees.
- [Spaces](https://agentspaces.co/): persistent multi-pane workspaces for Claude Code, Codex, Gemini, Aider, and shell.
- [Pane](https://runpane.com/): pane/tab/worktree manager for CLI agents.
- [webmux](https://webmux.dev/): parallel AI coding agents in isolated worktrees, with mobile-friendly chat for some sessions.
- [lazyagent](https://lazyagent.dev/): monitors Claude Code, Cursor, Codex, Amp, Pi, OpenCode sessions, tokens, costs, and transcripts.
- [Agent Sessions](https://github.com/jazzyalex/agent-sessions): local macOS session browser/cockpit/analytics/limits tracker for Codex, Claude, Gemini, OpenCode, etc.
- [Jack](https://jack.otm.ai/): runs Claude Code, Codex, and Gemini side by side with workspaces, sandboxed runs, git tooling, and mobile approval inbox.

### Config / Skill / Context Aggregators

- [AgentSync](https://dallay.github.io/agentsync/guides/mcp/): syncs MCP/config across multiple agent clients.
- [agent-sync](https://uphy.github.io/agent-sync/): single source of truth for context, commands, and modes across assistants.
- [agents-cli](https://agents-cli.sh/): syncs commands, rules, hooks, skills, and MCP servers into provider-native formats.
- [ContextForge](https://contextforge.dev/): persistent memory via MCP across Claude Code, Copilot, Cursor, Claude Desktop, etc.
- [Handoff](https://handoff.computer/): shared structured context for humans and agents over MCP.
- [AgentFiles](https://agentfiles.io/): shared file layer and handoff artifacts between agents.
- [Nicia Agents](https://nicia.ai/): organization skill library, importing Claude Code skills/scripts/prompts, versioning, evaluation loops.

### Governance / Control Plane

- [AgentMux](https://agentmux.ai/): local-first control plane for Claude, Codex, Gemini, etc., with audit trail, interagent communication, identity/memory bundles, governance.
- [Forge / ACP](https://github.com/forge-agents/forge): universal CLI for coding agents powered by Agent Client Protocol, with unified history across agents.

## What Is Still Distinctive

The distinct product direction is not "agent manager", "agent sync", or "run many terminals side by side".

The distinctive direction is:

> One local chat room for multiple CLI agents, where the app controls shared context, roles, skills, permissions, and user-approved handoffs.

This is narrower than most competitors and should guide naming.

## Names Not Yet Cleared

These were suggested as possible directions but have not been fully scanned or cleared:

- `Pairwise`
- `Sidecar`
- `Convene`
- `Convener`
- `Parley`
- `Caucus`
- `Huddle`
- `Commons`
- `CoDesk`
- `RelayRoom`
- `Pairroom`
- `DuetDesk`
- `AgentParley`
- `ChatForge`
- `Crewline`
- `Bench`
- `Worktable`
- `Toolbench`
- `Atelier`
- `Guildbench`
- `Rivet`
- `Quench`
- `Bellows`
- `Tongs`
- `Loom`
- `Weft`
- `Spindle`
- `Pattern`
- `Tailor`
- `Binder`
- `Folio`
- `Kit`

Smith-adjacent direction to explore: craft/workshop/tooling names can suggest practical setup and provider-neutral skill translation without saying `Agent*`. Best initial candidates from this direction are `Convener`, `Atelier`, `Bench` / `Toolbench`, `Parley`, and `Rivet`, pending collision checks.

Any of these needs a fresh web/domain/trademark scan before serious use.
