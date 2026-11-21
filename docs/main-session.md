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
- **The main session is woken only by its own tasks** (the User,
  2026-11-21): when the tasks it gave end. A member's turn that is not its
  task (the User's message in that member's session, a scheduled task's
  wake-up) does not wake it; it reads those messages on its next turn.
- **The tasks of one turn come back as one turn.** The main session is
  resumed once for all the tasks it gave in one turn: when that turn is over
  and every one of them has ended (answered, failed or stopped), with every
  answer in that one resume (the User saw it resumed once per member and
  said so). A task given after its turn ended comes back on its own.
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

## Posts during a turn (every chat)

Decided by the User (2026-11-20, in her own classic, Assistant-era chat):
what a member posts with `app_chat_send_message` during its own turn, in its
turn's own place, lives inside that turn's reply (`metadata.interimPosts`,
`shared/interimPosts.ts`), shown in order above its final answer, like the
text a CLI writes between its tool calls. This holds in **every chat**, with
or without a main session, in both views. Posts stay messages of their own
when they are an Accord resolution (`accordResolution`), go to another thread
or parent, or arrive after the turn ended (or once the reply's posts are
full).

- The tool returns the reply's `messageId` with the post's own `postId`
  (`postedInto: "running-reply"`) and says that `app_chat_react` with that
  id reacts to the whole reply.
- A member whose turn starts while the poster still runs reads the posts
  made since the newest post it already read (`postsReadThrough` on its
  context pointer), as one finished message under the poster's handle
  (`pendingReplyPostsForPromptContext`). The posts never move its context
  pointer to the reply, but the finished reply stays where the poster's
  turn began: a later turn of the reader reads it only if the reader's
  pointer is still before that place. When the pointer has already moved
  past it (the reader read a finished message written after the poster's
  turn began, such as the question it was asked), the finished reply is not
  read automatically; the reader saw only the posts, and reads the reply
  with `app_chat_read_messages`.

## The two views (a view only)

Switched per chat by the User any number of times (the chat header), shared
through her server like the pin (`metadata.chatView`); Settings → General
sets the view a new chat opens in (`defaultChatView`, default `sessions`). A
chat without a main session is always `classic`; its switch is disabled.

- `classic`: today's timeline: avatars, every member's reply on it.
- `sessions` (like T3 Code / Claude desktop):
  - no avatars, author names or handles anywhere: a member is its
    provider's bare glyph (Claude's orange asterisk, Codex's glyph,
    Antigravity's "A", sized to the text line, no tile; `ProviderIcon`
    `bare`, the phone's `providerLogoElement`; Settings → Local CLI setup and
    the classic New chat keep the tile) and its current or latest task's short title, as
    T3 Code titles a thread: the 2–6 word `title` the main session gives
    the task in `app_chat_delegate_task`, else the task's first sentence cut
    at a word to 40 characters (`sessionsTaskTitle`, `sessionsMemberTitle`;
    the phone gets it with the task), with provider, model and a non-generic role
    under it (`sessionsMemberDetail`); in a message, in prose and in code
    alike, only an exact `@handle` of a member or a former member (at most
    32 characters, not part of a longer word, an e-mail address, a path or
    a package name such as `@types/node`) is a chip (logo + task) that
    opens its session, one rule on the desktop and the phone
    (`sessionsMentionPieces`); everything else, the main session's handle
    and handles of nobody included, stays as written, and a leading
    mention of the main session is left out of the User's bubble
    (`withoutLeadingMention`);
  - one reading column (`--chat-reading-width`, 768px) holds the main
    timeline and the composer; the User's messages are right-aligned
    bubbles, the main session's replies full width;
  - the main composer always writes to the main session
    (`targetParticipantIds=[main]`, `deliveryTargets=[main]` on the phone),
    offers no members to mention (`/` and `#` stay), and carries the main
    session's model chip, which opens its settings; a member's composer
    the same for that member. The settings are a compact picker, T3 Code's
    (`ChatModelAccessPanel`): the model (the CLI's default first), the
    effort, the access in the CLI's own terms and, once a machine exists,
    where it runs (the effort a model lacks reads as Default; nothing is
    saved until a choice is made; Default sends the explicit reset; only
    the chosen setting is sent). The access is the CLI's own mode, run as
    the CLI runs it (`src/shared/chatAccessModes.ts`, the permissions'
    `cliApprovals`: what is not granted the CLI asks about instead of the
    app taking it away; the classic controls keep refusing it):
    - Claude Code (`--permission-mode`): Default reads freely and asks
      before each edit, command and web use, every ask an approval card
      (`--permission-prompt-tool`; deny rules stay hard stops); Accept
      edits edits without asking and asks before commands and web; Plan
      mode reads and plans; Auto mode is Claude's classifier.
    - Codex (its 0.155 presets): Read only (read-only sandbox) and Default
      (workspace-write), both asking (approval policy `on-request`, every
      ask an approval card) to go further; Auto-review, where Codex reviews
      its own asks; Plan mode, the read-only sandbox that never asks.
    - Antigravity (`agy --mode`; its Default is `agentMode: ""`, which
      `--mode` does not take): print mode cannot ask, so what a mode would
      ask about is refused (agy 1.5.14, 2026-11-21): Default reads and
      refuses edits and commands, Accept edits edits in the workspace and
      refuses commands, Auto mode edits and runs safe commands where the
      account has it (elsewhere agy says so and stays in Default), Plan
      mode reads and plans. No agy mode is called Read only.
    A main session starts in its CLI's own default: Claude Code's Default,
    Codex's Default, agy's Default. Settings from the classic controls are
    no mode: the picker marks none and says so, and a classic toggle (Read
    Files, Edit Files, Run Shell, Access Web) ends a mode chosen in the
    picker (`withClassicChatPermissions`), so what it turns off is refused,
    not asked about. A member held to a main session without the CLI's own
    mode loses its own mode too; an Antigravity member then runs Default with
    no edits (`--sandbox`), never with its confirmations skipped
    (`clampChatAgentAccess`). Its … menu has Restart
    (picks up changed connectors, idle only, naming background work it
    stops; not Antigravity) and, for a member, Remove from chat. Its
    provider stays the one it was made with. No name, status,
    member rights or auto-watch: the main session's chat behaviour is fixed
    (it creates and asks members, request and manage are allowed as its role
    gives them, and it is told when its tasks end). A member other than the
    main session is removed from the picker's … menu; the gear in its
    session's header opens the same picker. The chip names the member's own model, else
    the one its CLI runs on by default (the CLI's model list: Claude Code's
    initialize answer, Codex's model/list, `agy models`; an added
    provider's vendor default), else the CLI ("Claude Code"), with the
    effort after it (`memberDefaultModelName`; desktop only, the phone has
    no chip). The main composer has no "N active runs" pill (the Waiting
    line and the side panel name and stop the members); while the main
    session itself runs and nothing is typed, its send button is Stop for
    the main session's run, as in T3 Code and Claude; with something typed
    a secondary Stop stands next to Send (a CLI interrupts whatever is in
    its prompt), and Send still sends the message to it;
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
  - a reply still being written reads as T3 Code's turn in progress (the
    User, 2026-11-21), on the desktop and the phone, on the main timeline
    and in a member's session: a quiet "Working for 4s" (live) over a
    hairline, then one muted line per step with an outline icon by its kind
    and what it is about (`sessionsActivityRow`, from the activity events
    the run already reports): thinking (brain), web search (globe, the
    query), shell (terminal, the command), file read (file, the path), edit
    (pencil, the path), any other tool (wrench, its label); the newest one
    shimmers (still for reduced motion). The member's words and its posts
    stay its words, in order between the rows; its turn's tasks follow as
    their rows. No status label, no "Thinking" word, no grouped boxes, no
    Stop or copy on a running reply (the composer stops it, also with
    text typed; a member's session head stops the member); a queued one is
    taken back from a small × on hover (always on a touch screen, the
    phone's at least 32px) and shows "Queued", no clock. A long turn
    draws its newest 50 steps under a muted "N earlier steps" (a finished
    fold opens them); a reply that waited in the queue counts its
    "Working for" from its own turn's start (`turnStartedAt`). A run on a
    machine shows where it stands ("Preparing the workspace") as its
    current step until its first own step. The phone gets a reply's newest 12 steps, each one
    line of at most 120 characters, with how many earlier ones there were
    (`phoneSessionsActivity`; the live copy marks text that is only where
    the run stands, `liveStatus`);
  - every finished reply says how long it worked T3 Code's quiet way,
    on the main timeline and in a member's session: muted "Worked for 44s"
    and a chevron, no pill; the chevron opens, in place, the same rows its
    turn showed while it ran (and the words it wrote between them, which
    its final text does not repeat), then its tasks; a reply with neither
    is the muted text alone; the classic view keeps its pill;
  - one icon at the top right opens the side panel (a running count on it,
    a dot while an Accord is open); the view switch is in the chat title's
    menu and the roster's popover is not shown. The side panel has no title,
    only its close button, as Claude desktop's right panel (the User,
    2026-11-21); it lists the chat's latest Accord and the sessions the main
    session delegated (provider, task, status, elapsed time, Stop) with Stop
    all, never the main session itself (its settings are its composer chip);
    while one runs or waits for the User the ended ones are under
    "Previous"; those no longer in the chat are under "Removed"
    (`sessionsFormerMembers`). With nothing delegated it says nothing. A member opens its **whole session** in the
    same panel (Back to the list) with its settings (gear) and a composer
    that writes to it only; a removed member's session is read-only;
  - the word "members" is never shown (desktop and phone): "Waiting on N
    tasks", "Side panel", "Back", "Close";
  - no threads UI: every message has one place (`sessionsViewLane`); the
    main session's answer to a member's question is in that member's
    session from its first token (placed by the request it answers);
  - a finished message shows no member state; its time is with its controls
    on hover. A reply still being written has its "Working for …" (above),
    one still queued keeps "Queued";
  - a task's state is not taken from the member's earlier stopped or failed
    turn while the task waits (queued, a machine preparing);
  - no turn-finished note ("<X> finished answering"), the main session's
    own included (`isSessionsHiddenTurnFinishedNote`); the classic view
    keeps them;
  - the Accord: above the composer one quiet line (Accord · its name ·
    where it stands) that opens the whole card in the side panel; the
    classic view keeps the pinned card;
  - pages: the main timeline stops loading older pages by itself after two
    pages that added nothing to it ("Load older messages" goes on); "Load
    older" in a member's session goes on until a message of that member
    arrives or the chat's start, six pages at most.

## New chat

A new chat opens in the view Settings → General names (`newChatViewFor`).

- **Sessions view** (the User, 2026-11-21: "как в T3, выбираешь просто
  провайдера и модель"): no members picker, no avatars, handles or
  "members" on the screen. The composer's chip at its bottom right shows
  the main session's provider glyph, model and effort ("✳ Opus 5.5 High")
  and opens the compact picker with the provider choosable: every ready CLI
  and every added provider whose CLI is ready and which has its key
  (`mainSessionProviderOptions`). The default provider is Settings →
  General's "Main session provider" (`resolveMainSessionProvider`); the
  chip's choice is for that one chat and never changes the setting, and
  is forgotten when the User leaves New chat without sending. What was set
  for one provider (model, effort, access, where it runs) is dropped when
  another is in effect, also between visits. A chosen or shown provider
  that stops being ready is said on the screen and the send is refused,
  never made on another one silently. The
  chat is made with that main session alone; an @handle in the first
  message picks nobody. Folder and attach stay.
- **Classic view**: today's New chat, with its members picker.
- **The phone** gets the same from the New chat offer
  (`HubNewChatOptions.mainSessionProviders`: each provider with its
  default model's name, its models, at most 24, and efforts;
  `newChatProviderOffer`), shows the same chip and sheet (with the same
  Access, and Runs on where a machine exists), and makes the chat with the
  offered main session on the chosen provider, model, effort and access
  (`newChatMainSessionFor`). An offer from a computer from before has no
  list: the chip shows the offered main session's CLI. The offer never
  waits for a model list: each provider goes with the list it last had,
  read again in the background (a good one after 10 minutes, a failed one
  after a minute, a failure never replacing a good one), and a list that
  changed publishes the offer again. A provider the phone chose that is
  not ready on the computer when the chat's first turn runs says so in the
  reply ("@main cannot start on this computer: …").

The placement rules are in `src/shared/mainSession.ts` and are the same on
the desktop and on the phone (bundled through `mobileSharedRules.ts`).

## Fork to new chat

The User, 2026-11-21 ("форкнуть любого участника в качестве оркестратора
нового чата"): any member of any chat (a main session, a member it made, a
member of a chat from before with its Assistant) can be copied into a new
chat as that chat's main session, with everything it knew
(`src/shared/forkToNewChat.ts`).

- Offered as "Fork to new chat" in a member's … menu in the sessions view
  (its settings from its session's gear, and the main session's composer
  chip) and as a fork button on its card in the classic roster. Disabled,
  with the reason, for Antigravity (no fork), a member that never ran (no
  session), one waiting for a machine, one on an added provider Settings no
  longer has (its copy would run on another provider), one on a machine
  whose program is older (Upgrade runtime) or has never greeted this
  computer, and one on this computer whose CLI is not ready.
- On the phone (sessions view) it is in the title's menu: for the main
  session on the main timeline (under the chat's view), for a member on its
  own screen (the title opens that menu there; the side panel stays on its
  icon). Opening the menu reads `GET /v1/phone/new-chat?forkOf=<chat>&
  participantId=<member>`: the server adds the member and the chat's main
  session as it holds them (never a session a move hands over) and whether
  the member has a finished reply there; the computer's New chat offer
  carries `fork` (why each of its CLIs cannot run a member now, each
  machine's program by its last hello, the main session's role's rights).
  The phone judges with the same `forkToNewChatUnavailableReason` and
  words, the member as it runs (`memberAsItRunsNow`), and makes the main
  session with `forkedMainSessionFor` (the computer's own result, checked by
  a test), then queues `conversation.create` and the intro line like its New
  chat and opens the chat at once. A server or computer from before says it
  must update. "Ran" for a member on a machine is one rule everywhere
  (`isFinishedMemberReply`: a finished reply, an error too; never one still
  being written nor a placeholder shown for a turn elsewhere), and the
  server reads its copy of the chat by it. One narrow difference: the phone
  cannot see a member's session record, so it applies that rule to a member
  on the computer too; one whose session was dropped since is offered, and
  its fork starts clean with the chat's warning.
- The new chat is made through the same path as every new chat
  (`createConversation` with `forkOf`, saved and so put on the User's server):
  titled "<chat> (fork)" until its first reply names it, in the member's
  project, in Settings → General's view, with one member: its main session on
  the member's provider, model, effort, access (its CLI's mode and what it
  may read, edit, run and reach, as it runs now) and place (this computer or
  the same machine: a fork never crosses devices), with the main session's
  role and its say over members, marked `ChatParticipant.forkOrigin`
  (written only by the computer; her server keeps a machine from writing
  it). The chat opens at once with its composer focused; the member and its
  chat are not touched.
- Its first turn (on the device it runs on) reads the member's session from
  the member's chat there (`startFromForkOrigin`; only that chat's session
  records) and forks it as a delegated fork does (`forkFrom` with the source
  chat's id). It is told it is the new chat's main session, not a member,
  with the main session's role instructions, and reminded on later turns. A
  main session that already answered never becomes a copy again. A member
  that moved to that device and whose session still waits on her server is
  taken first, as its own next turn would take it. When the member's session
  is not on that device, it starts clean and the chat says so; when the CLI
  cannot copy it, the fork's two-strike fallback holds. The member's chat is
  read without its messages (its metadata and newest messages).
- Claude Code 2.1.329 forks a session from another folder as well as from
  its own (checked 2026-11-21); the new chat keeps the member's project so
  the copy works in the folder it knew.
- A machine says it can do this in its hello (`forkToNewChatSupported`).

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
- `ChatParticipantRequestBatch.delegation.turnId?`: the main-session turn (its `turnSegmentId`) that gave the task while that
  turn ran on this device. `autoResumeParticipantRequest` resumes the tasks
  of one `turnId` once: not while the turn runs (`liveTurnSegments`; its end
  looks again), not while one of them runs, then with one trigger listing
  each task and how it ended (a lone task too, a stopped one as "stopped by
  User"; its row in the sessions view says "Stopped", muted), and the other tasks' replies read as untrusted
  context (`extraPromptContextMessageIds`), each cut to 12,000 characters
  and all to 60,000, a cut one naming its message for
  `app_chat_read_messages` (`cappedTaskReplyRecords`; Antigravity takes
  its prompt on the command line); every batch gets the same
  `autoResumeMessageId`. A task a restart ended
  (`markOrphanedParticipantRequestInterrupted`) makes the app look at its
  turn's tasks again; when the restart ended all of them the main session is
  not woken, as a lone task never was. A turn that a restart ended while
  its tasks were held, or whose resume a restart cut short, is looked at
  once on the first read of the chat (`recoverDelegationGroupsOfEndedTurns`):
  the main session is resumed with every answer; a resume that was made and
  failed is not made again. On a cloud machine the same runs on
  the machine that runs the main session.
- `ChatParticipantRequestBatch.delegation?: { start, turnId? }`: the main session's
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
  member adding it and of the main session (`additionsExceedMainSession`;
  a member with a shell keeps every deny rule of theirs,
  `chatAgentPermissionsWithin`); a broader one goes to a card. Such a member is marked
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
  as the server has it, and a member so marked adds or removes members
  without a card no more freely than the main session's right as the server
  has it before the write; a member the User approved on a card is not
  marked, whatever the machine wrote; the main session's `/accord` gives its facilitator
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
