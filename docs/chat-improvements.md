# Chat implementation improvements

Near-term MVP prioritized list, agreed in chat between @taylor-claude-engineer and @drew-codex-engineer. Reasoning and pointers for whoever picks this up.

## Context

The chat feature (`ConversationKind = "chat"`) is the multi-participant flow where named agents talk to each other and the user, gated by per-participant permissions and per-mention approvals. The MCP-driven context plumbing (participants, request_participants, read_messages, request_change, etc.) is solid. The biggest remaining friction is in the renderer (everything lives in one file) and in the perceived latency / opacity of long agent turns. The five items below address those in order of leverage.

---

## 1. Split chat UI out of `App.tsx`

**Pain.** `src/renderer/App.tsx` is ~5k lines and contains the entire UI tree: sidebar, chat view, review view, plan view, and settings. Every chat-side change (live status, threading, approvals UX, cost pill) requires touching this file, which makes diffs noisy and review slow. CLAUDE.md already calls out the file's size and warns to touch it with care.

**Why first.** Items 2–5 all extend chat-view behavior. Doing them while the chat code is interleaved with reviews/plans/settings forces every change to read the whole file.

**Approach sketch.**
- Move chat-only components and state into `src/renderer/chat/` (e.g. `ChatView.tsx`, `ChatComposer.tsx`, `ChatMessageList.tsx`, `ApprovalsInbox.tsx`).
- Keep the IPC bridge (`window.consensus`) calls at the top-level `App.tsx`; pass typed callbacks/state down.
- Shared bits (subscriptions to `onReviewProgress`, `onConversationUpdated`) stay in a small `useConversation(conversationId)` hook.
- Don't try to extract review/plan/settings in the same PR — keep the diff scoped to chat.

**Done means.** `src/renderer/App.tsx` no longer references chat-specific JSX or state; chat tree lives in `src/renderer/chat/` and is < 1k lines per file.

---

## 2. Stream agent output into the chat view

**Pain.** Today a turn appears atomically once the CLI finishes (`runClaude`/`runCodex` resolves). For 20-60 second turns the chat looks frozen, which makes multi-agent debates feel sluggish and uncertain.

**Why now.** Lowest-cost perceived-quality win once item 1 is done. The data already exists: `cliAgents.ts` already emits `CliAgentOutputEvent` via the `onOutput` callback, and `ChatService` already pushes `ReviewProgress` events.

**Approach sketch.**
- Reserve a placeholder message bubble keyed by the upcoming participant message id (created when the turn starts, marked `status: "running"`).
- Forward progress events / partial stdout from the main process via the existing `conversations:review-progress` channel; the renderer appends partial text into the placeholder.
- On completion, swap the placeholder for the real message (no new bubble flicker).
- Keep it opt-in per provider — Codex emits progress JSON, Claude streams differently; degrade to a "thinking…" indicator when only a heartbeat is available.

**Done means.** When a participant is producing a long response, the user sees incremental text (or at minimum a "thinking + elapsed seconds" indicator) instead of a frozen UI.

---

## 3. Unified pending-approvals inbox

**Pain.** There are four distinct "the chat is waiting on the user" shapes that each have their own UI surface today:
- `ChatPendingMention` — user must approve before a mentioned agent runs.
- `ChatPendingChoice` — agent asked the user a multiple-choice question.
- `ChatAppToolApprovalRequest` (permissions, roster, request-participants) — agent invoked an MCP tool that requires approval.
- `ChatParticipantRequestApprovalRequest` — separate flow for cross-agent requests.

Each spawns its own banner/modal/affordance. Users miss approvals because they don't all live in one obvious place; agents stall waiting on a button the user can't easily find.

**Approach sketch.**
- Introduce a single `PendingApproval` discriminated union in `src/shared/types.ts` that the renderer derives from the existing four types (don't rewrite the storage model — just project for UI).
- One sidebar/banner component (`ApprovalsInbox`) shows the queue with type-specific renderers.
- Single keyboard-driven Approve/Deny path; approval handlers fan out to the four existing IPC routes (`chat:respond-to-mentions`, `chat:respond-to-choice`, `chat:respond-to-app-tool-approval`, etc.).
- A small "X pending approvals" badge in the chat header is enough to fix the discoverability problem.

**Done means.** All pending approvals for a chat appear in one queue with consistent affordances; users never have to hunt across the UI to unblock the chat.

---

## 4. First-class threaded replies

**Pain.** `ChatMessage.metadata.threadId` / `chatThreadRootId` / `parentMessageId` already exist in the data model, but the renderer flattens everything into the main timeline. When two agents argue under a user message, or one agent makes a participant-request to another and waits for the reply, the resulting back-and-forth interleaves into one long flat list. With 3+ participants the timeline becomes unreadable.

**Approach sketch.**
- In the chat view, group messages by `chatThreadRootId` and render replies under their root as an expandable sub-thread (collapsed by default beyond N messages, or always expanded for the most recent thread).
- Keep system messages (auto-resume notices, "permission granted", etc.) inline under the relevant thread root, not floating in a separate "system" lane.
- Don't re-sort by thread root — preserve chronological order of roots, just visually group children.

**Done means.** A multi-agent debate with branching threads is legible without scrolling past unrelated messages; the user can collapse a thread they've already digested.

---

## 5. Per-participant context & cost pill

**Pain.** Multi-agent chat is more expensive and slower than a single strong model. Today there's no visibility into either, which makes it hard for the user to (a) judge whether the multi-agent flow is worth it for their use case, and (b) know when to start a fresh chat because a participant's session context is getting bloated.

`AgentContextUsage` is already populated on `ParticipantRunResult` (see `cliAgents.ts:extractClaudeContextUsage` etc.) and propagated into conversation metadata.

**Approach sketch.**
- Per participant, surface a small pill next to their handle in the chat header: "ctx 42% · 12k tok · 8s last turn".
- Click expands to per-turn breakdown (last N turns) sourced from existing metadata.
- Aggregate "total spend this conversation" pill in the chat footer if costs are derivable from token counts × known per-model rates.
- No new IPC: the data is already in conversation snapshots.

**Done means.** The user can see, at a glance, how heavy each agent's context is and roughly what the chat cost so far — turning the "extra latency/cost" objection into a transparent number they control.

---

## Out of scope (intentionally deferred)

These were discussed and pushed out so the above items can land cleanly:

- **Fork conversation from a message** (swap participant X for Y). Storage already snapshots JSON; mostly UI + a new IPC route. Useful for prompt iteration, not urgent.
- **Export/import role presets** from `chatRoleConfigs` as shareable JSON. Easy once the chat UI is split.
- **Role-level escalation policy** in `chatRoleConfigs` (arbiter vs engineer behavior when permission-blocked). The per-turn permission envelope already covers the "ask, don't refuse" guidance; role-specific policy can come later.
- **App-managed skill** with worked examples of permission requests. Defer until per-turn envelope proves insufficient in practice.

## Ordering rationale

1 unblocks 2–5; 2 and 3 are the largest perceived-quality wins per hour of work; 4 and 5 handle scale-of-conversation and the core value-prop objection. None of them require new persistence or IPC contracts of significant size — most of the data and event plumbing already exists.
