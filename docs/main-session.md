# Main session and the sessions view

Decided by the User on 2026-11-20 in chat (design artifact "Главная сессия
вместо Ассистента: предложение по образцу T3 Code", v8, answers recorded
verbatim there). Modelled on T3 Code (`~/reference/t3code`,
`docs/orchestration-v2/orchestrator-mcp-server.md`).

## What the User gets

- **Every new chat has one main session** instead of the Chat Assistant: an
  ordinary member on the User's CLI (Claude Code, Codex or Antigravity) with
  ordinary rights. It does ordinary work itself, as the CLI would. Every
  message without an @addressee on the main timeline goes to it.
- **It creates members itself, without a card**, and gives them a task in the
  same call (`app_chat_delegate_task`): a clean session that gets only the
  task, or a **fork** of the main session's own CLI session (Claude
  `--resume <id> --fork-session`, Codex app-server `thread/fork`). Antigravity
  has no fork, and a fork cannot cross providers or devices: the tool refuses
  it and the main session starts a clean member with a full brief instead.
- **A member never gets broader rights than the main session** (repo, edits,
  web, shell and its rules, mode, member requests, member management).
- **No limit** on how many members run at once; every member is listed and
  can be stopped, and there is Stop all.
- **Members ask the main session, not the User.** It answers from what it
  knows of the User's intent and asks the User only when it cannot.
  Approvals of members' commands still reach the User on the main timeline.
- **Only the main session can start an Accord** (`app_chat_start_accord`); a
  member that needs one asks the main session. The User still can, as today.
- **The Chat Assistant and the Workflow Manager role are not in new chats.**
  Chats made before stay exactly as they are (with their Assistant).

## The two views (a view only)

Switched per chat by the User any number of times (the chat header), shared
through her server like the pin (`metadata.chatView`); Settings → General
sets the view a new chat opens in (`defaultChatView`, default `sessions`). A
chat without a main session is always `classic`; its switch is disabled.

- `classic`: today's timeline: avatars, every member's reply on it.
- `sessions` (like T3 Code / Claude desktop):
  - no avatars or author names on the main timeline; the User's messages are
    right-aligned bubbles, the main session's replies full width, its work
    folded into "Worked for …";
  - the main timeline holds the User's messages to the main session, the main
    session's messages, system lines and the cards the User must answer
    (approvals, a member's choice card that is still open);
  - each task the main session gave is a **task card** (member, status, one
    line of result; click opens the member's session), and while the main
    session waits there is a line "Waiting on N members … Stop";
  - the **right panel** lists the chat's members (provider, current task,
    status running / waiting for you / done / error, elapsed time, Stop) with
    Stop all; clicking a member opens its **whole session** in the same panel
    (Back to the list) with a composer that writes to that member only
    (`SendChatMessageRequest.targetParticipantIds`);
  - no threads UI: every message has one place (`sessionsViewLane`).

The placement rules are in `src/shared/mainSession.ts` and are the same on
the desktop and on the phone (bundled through `mobileSharedRules.ts`).

## Contract (src/shared)

- `MAIN_SESSION_ROLE_ID = "main-session"`, handle base `main`.
- `ConversationMetadata.mainSessionParticipantId`: set when the chat is made,
  never changed. `isMainSessionChat()` reads it (and checks the member is
  still there).
- `ConversationMetadata.chatView?: ChatViewMode` (`"classic" | "sessions"`),
  read through `chatViewFor(metadata, settings.defaultChatView)`.
- `AppSettings.defaultChatView?: ChatViewMode`.
- `SendChatMessageRequest.targetParticipantIds?: string[]`: exactly these
  members, no @-parsing for addressees, no fallback.
- `ChatParticipantSession.forkFrom?: { participantId, sessionId, kind }`: the
  member's first turn forks that session; cleared once it has its own id.
  `ChatParticipantSession.forkedFromParticipantId` stays: both CLIs keep the
  source's system/developer instructions in a fork (verified on Claude Code
  2.1.329 and Codex 0.155.1), so the member is told who it is on its first
  turn and reminded on later ones.
- `ChatParticipantRequestBatch.delegation?: { start }`: the main session's
  task to a member it made (`app_chat_delegate_task`); not held to the
  one-request-per-turn limit.
- `ChatMessageMetadata.accordLaunchByMainSession`: an Accord launch the main
  session wrote (`app_chat_start_accord`), read as an Accord card like the
  User's (`accordLaunchCard.ts`).
- Rights: a member the main session makes gets
  `clampChatAgentPermissions(requested, main's effective rights)`
  (`agentPermissions.ts`); her server holds a machine's additions to the same
  rule (`hubMachineScope.ts`), and an addition through the member tools that
  is broader goes to a card.
- Routing (`chatDeliveryPolicy.ts`): in a main-session chat a top-level
  message without an @mention goes to the main session (not the last
  speaker); in a thread the old thread rule holds.

## Sentry

The weekly snapshot reports how many chats in each view had a User message
that week (`chats_sessions_view_active`, `chats_classic_view_active`), so the
User can see whether anyone still works in the classic view before it is
removed. Team devices are marked as for every signal.

## Rollout

The classic view is temporary. When Sentry shows nobody uses it, the classic
view, the Assistant and its code are removed.
