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
  - no avatars, author names or handles anywhere: a member is its
    provider's logo tile and its current or latest task's short title, as
    T3 Code titles a thread: the 2–6 word `title` the main session gives
    the task in `app_chat_delegate_task`, else the task's first sentence cut
    at a word to 40 characters (`sessionsTaskTitle`, `sessionsMemberTitle`;
    the phone gets it with the task), with provider, model and a non-generic role
    under it (`sessionsMemberDetail`); a mention of a member in a message
    is a chip (logo + task) that opens its session, a mention of the main
    session or of nobody is its plain name, and a leading mention of the
    main session is left out of the User's bubble (`withoutLeadingMention`);
  - one reading column (`--chat-reading-width`, 768px) holds the main
    timeline and the composer; the User's messages are right-aligned
    bubbles, the main session's replies full width;
  - the main composer always writes to the main session
    (`targetParticipantIds=[main]`, `deliveryTargets=[main]` on the phone),
    offers no members to mention (`/` and `#` stay), and carries the main
    session's model chip, which opens its settings; a member's composer
    the same for that member;
  - the main timeline holds the User's messages to the main session, the
    main session's messages, system lines and the cards the User must
    answer; the member-added cards of its delegations are not shown
    (`isMainSessionDelegationRosterCard`);
  - the main session's tasks are not cards: each is a row inside the
    "Worked for …" fold of the reply of the turn that gave it
    (`sessionsTaskPlacement`, by the message both answer; under the reply
    while it is being written): logo with a state dot, task title, one line
    of result, time; a row opens the member's session at its reply (else
    the task), marked for a moment. A task whose reply is not loaded is one
    such row of its own. While the main session waits there is a line
    "Waiting on N members: <tasks> · Stop";
  - one icon at the top right opens the side panel (a running count on it,
    a dot while an Accord is open); the view switch is in the chat title's
    menu and the roster's popover is not shown. The side panel lists the
    chat's latest Accord, the main session (its settings), the members
    (provider, task, status, elapsed time, Stop) with Stop all; while some
    member runs or waits for the User the ended ones are under "Previous";
    members no longer in the chat are under "Removed"
    (`sessionsFormerMembers`). A member opens its **whole session** in the
    same panel (Back to the list) with its settings (gear) and a composer
    that writes to it only; a removed member's session is read-only;
  - no threads UI: every message has one place (`sessionsViewLane`); the
    main session's answer to a member's question is in that member's
    session from its first token (placed by the request it answers);
  - a finished message shows no member state; its time is with its controls
    on hover. A message still being written keeps "Running 12s" or "Queued";
  - a task's state is not taken from the member's earlier stopped or failed
    turn while the task waits (queued, a machine preparing);
  - a turn-finished note about another member is not on the main timeline
    (`isOtherMemberTurnFinishedNote`);
  - the Accord: above the composer one quiet line (Accord · its name ·
    where it stands) that opens the whole card in the side panel; the
    classic view keeps the pinned card;
  - pages: the main timeline stops loading older pages by itself after two
    pages that added nothing to it ("Load older messages" goes on); "Load
    older" in a member's session goes on until a message of that member
    arrives or the chat's start, six pages at most.

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
  turn and reminded on later ones. When the source session is gone (only
  the CLIs' own words: Claude Code "No conversation found", Codex "no
  rollout found for thread id", `isForkSourceMissingError`): Claude Code's
  one-shot start falls back to a clean session at once, from a prompt that
  still carries the member's identity note and its role's instructions;
  otherwise the next turn tries the fork once more
  (`forkFrom.failedAttempts`), and when that fails too the member becomes a
  clean member (fork and its chat-context pointer dropped). Either way the
  chat gets a warning ("@x could not start from a copy of @main's session,
  …"), and the failed reply the main session reads says it too.
- `ChatParticipantRequestItem.title?`: the main session's short title for
  its task (`app_chat_delegate_task`'s `title`, at most 80 characters).
- `ChatParticipantRequestBatch.delegation?: { start }`: the main session's
  task to a member it made (`app_chat_delegate_task`); not held to the
  one-request-per-turn limit. Delegations and a member's requests to the
  main session alone are not held to (nor counted toward) the per-message
  chain limit (`CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES`; the User: no
  limit on members); the depth and rate limits still hold.
- `ChatMessageMetadata.accordLaunchByMainSession`: an Accord launch the main
  session wrote (`app_chat_start_accord`), read as an Accord card like the
  User's (`accordLaunchCard.ts`).
- Rights: a member the main session makes gets
  `clampChatAgentPermissions(requested, main's effective rights)`
  (`agentPermissions.ts`). `app_chat_delegate_task` takes only roles offered
  for new members (`isRoleOfferedForNewMembers`: not the Workflow
  Manager's). In a main-session chat every addition without a card, by any
  member through any member tool, has nothing beyond the rights of the
  member adding it and of the main session (`additionsExceedMainSession`);
  a broader one goes to a card. Such a member is marked
  `ChatParticipant.delegatedByParticipantId` (who added it; shared through
  the server with the member) and runs, asks, compacts and manages members
  no more broadly than the main session as it is at each turn
  (`participantForRun`, `requireParticipantManager`), so lowering the main
  session lowers it; its own settings stay. Members the User added or
  approved herself are not marked.
- Her server (`hubMachineScope.ts`) holds a machine to the same: a
  machine's own member keeps the mode and rights the server has for it,
  raised only by a permission the User granted it for the chat on its card
  (once); a member a machine adds without a card, wherever it runs (the
  User's Mac, another machine), has nothing beyond the rights of a member
  there that may add it and of the main session as the server has them
  before the write, and says who added it; `delegatedByParticipantId` stays
  as the server has it; the main session's `/accord` gives its facilitator
  no more leave to ask than the main session's own. A new chat names as its
  main session only a member with the main session's role, and moving a
  chat to the server keeps the main session the server has.
- Routing (`chatDeliveryPolicy.ts`): in a main-session chat a top-level
  message without an @mention goes to the main session (not the last
  speaker); in a thread the old thread rule holds.

## Sentry

The weekly snapshot reports how many chats in each view had a User message
that week (`chats_sessions_view_active`, `chats_classic_view_active`), so the
User can see whether anyone still works in the classic view before it is
removed. The snapshot goes at the first chance in an ISO week, so "that week"
is the seven days before it is sent; the counts are bucketed like the
snapshot's other counts. Team devices are marked as for every signal.

## Rollout

The classic view is temporary. When Sentry shows nobody uses it, the classic
view, the Assistant and its code are removed.
