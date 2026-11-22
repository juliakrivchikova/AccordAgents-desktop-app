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
- **In the sessions view an @handle in a member's reply starts nobody**
  (the User, 2026-11-22), as a mention in text wakes nobody in Claude Code:
  no turn, no task row, whoever wrote it (the main session included) and
  wherever it runs (`ChatService.createImplicitParticipantRequestApproval`,
  the same code on this computer and on a cloud machine). Its posts
  (`app_chat_send_message`) are the same; a main session's "@x /accord"
  starts no Accord. Members are asked with `app_chat_request_participants`
  or `app_chat_delegate_task`, an Accord with `app_chat_start_accord`, and
  members' replies go back to the main session; the User's own @mentions
  still address members. The member prompt says so instead of "an @handle is
  a request". The classic view of the same chat keeps reading such a mention
  as a request, as before.
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
through her server like the pin (`metadata.chatView`). Every new chat opens
in `sessions`, on the computer and from the phone (the User, 2026-11-22:
Settings no longer names a view for new chats; a `defaultChatView` stored
before is dropped). A chat without a main session is always `classic`; its
switch is disabled.

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
    session's settings as separate quiet controls; a member's composer the
    same for that member. They are laid out as Claude's desktop app
    ("Opus 5.5 · Extra · Auto"), Codex and T3 Code lay theirs out (the User,
    2026-11-21: "please make a normal UI, look at how Claude Code, Codex and
    T3 do it"): one control each for the model (with the provider's glyph),
    the effort, the permission mode, Codex's Plan mode (a toggle beside the
    permissions) and, once a machine exists, where it runs ("Local", the
    machine's name, "Cloud run"); each opens its own small menu
    (`ChatMemberComposerControls`, `composer-menu.tsx`): a muted title (the
    vendor's: "Permission mode", "Permissions", "Agent Mode", "Model",
    "Effort"), each choice's name with the vendor's description wrapped
    under it and a check on the chosen one. A menu is laid over the window,
    never inside the composer or the side panel: above its control when
    there is more room there, never taller than that room nor wider than
    the window less 8px, pushed inside its edges. A long model list is
    split as Claude's desktop app splits it: the CLI's default first, the
    newest model of each family, the rest under "More models" (opened in
    place; open when the chosen model is there; `latestAndOlderModels`).
    The model control names the model that runs: for a member without a
    model of its own, the one the User's own CLI config starts the CLI on
    where it runs (Codex's `config.toml` `model`, the model Claude Code
    says it applies, `agy models`' first), never the one the CLI's list
    marks default (the chip read "GPT-6-Luna", model/list's default, while
    turns ran her config's gpt-5.6-luna, 2026-11-22). The main process
    marks that model `recommended` in the CLI's list
    (`withCliStartModel`); a member on a machine is named by that
    machine's own config (its hello's `cliStartDefaults`). With no effort
    chosen and no model of its own, the effort control names the effort her
    config sets ("Low"; its menu's Default row says it under "Default").
    The effort a model lacks reads as Default; nothing is saved until a
    choice is made; Default sends the explicit reset; only the chosen
    setting is sent. Codex's Default collaboration mode said on a turn
    carries the member's effort, else her config's, else the thread's
    (`codexCollaborationMode`): a null there resets Codex to the model's
    own effort (seen 2026-11-22: turns went at no effort while her terminal
    ran `low`).
    In a narrow composer (the main column or the side panel at the smallest
    window, both panels open) the controls turn into icons one by one, as
    T3 Code's composer footer does: where it runs, Codex's Plan mode, the
    mode (a lock for asking before changes, a pen for edits without asking,
    a list for planning, a checked shield for the CLI deciding, a crossed
    one for Full Access, an eye for Read Only), the effort (a gauge); then
    the model loses its glyph and last its name shortens, never under six
    letters (`useComposerDensity`, measured before paint only when the
    row's width or what the controls say changes, from the fullest form,
    and when their own box narrows because something beside them took
    width (a running turn's chip, the hint under a reply, a long folder
    name), from where they are: never on a render that changes none of
    these, such as one per streamed token; reading the controls' size
    forces a layout of the whole window. Measured 2026-11-22 in the app
    during a Sonnet 5.5 turn: 133 such reads before, none after). An
    icon's value is its tooltip, its accessible name and its
    menu; no control is ever a one-letter stub. Checked 2026-11-22 in the
    app with both panels open: at 1280×820 "Sonnet 5.5 · Medium · Manual"
    in both composers and "GPT-5.6-Luna · Low" with the mode and Plan mode
    as icons; at 1080×720 "Sonnet 5.5" with the effort and mode as icons
    in the main composer, "Sonnet 5.5 · Medium" and the mode's icon in the
    member's, and "GPT-5.6-Luna" without its glyph and three icons in a
    Codex main composer; every control inside its row, Send beside it. Its own turn running, the controls wait (disabled),
    but for the permission mode where its CLI takes one while it works
    (the User, 2026-11-22; checked in the CLIs that day): Claude Code
    2.1.330's Shift+Tab switches the mode mid-turn and it holds for the rest
    of that turn, which the app does with the CLI's own stream-json control
    request `set_permission_mode` to the member's live process (a control
    run refused a Write in default mode; switched mid-turn, the same Write
    ran). Codex refuses it while a task runs (0.171.0's own words: "Cannot
    change: a task is running."; 0.155.1 had "Wait for the current turn to
    finish before changing permissions.", and its Plan mode, Shift+Tab, did
    not change mid-turn), and Antigravity's print mode takes its mode when
    each run starts: their menus wait (`modeChangesWhileTurnRuns`). The
    access is the CLI's own mode, run as the CLI runs it
    (`src/shared/chatAccessModes.ts`, the permissions' `cliApprovals`: what
    is not granted the CLI asks about instead of the app taking it away;
    the classic controls keep refusing it). Each table is the set the CLI
    offers by default, in its own order, in the vendor's words (verified
    2026-11-22, evidence below):
    - Claude Code 2.1.330 (`--permission-mode`): Manual ("Always ask before
      making changes"; `--permission-mode default`, which 2.1.330 still
      takes beside `manual`; every ask an approval card through
      `--permission-prompt-tool`, deny rules stay hard stops), Accept edits
      ("Automatically accept all file edits"), Plan ("Create a plan before
      making changes"), Auto ("Claude handles permission decisions",
      Claude's classifier). The member's process is the same in all four
      (only `--permission-mode` differs), so its stored rules are Claude
      Code's own rules in every mode, as if they were in her own Claude
      settings: shell allow rules and provider-native allow rules in
      `--allowedTools`, ask rules in `--settings permissions.ask`, deny rules
      in `--disallowedTools`; Claude Code applies its parsing, deny > ask >
      allow, what its Auto strips from allow rules, and its Plan mode. In
      Plan a command a stored allow rule covers is treated as Claude Code
      treats a settings allow rule in plan mode (2.1.330 matches a
      `Bash(...)` rule inside the Bash tool's own check, ahead of its
      plan-mode ask; edits stay refused in Plan whatever the rules say). The
      app answers none of them itself. Of the app's own tools only those
      its Auto pre-authorizes are allowed; the rest are asked by card.
    - Codex 0.155.1 (its `/permissions` picker): Ask for approval ("Codex
      can read and edit files in the current workspace, and run commands.
      Approval is required to access the internet or edit other files.";
      workspace-write, `on-request`, reviewer the User), Approve for me
      ("Only ask for actions detected as potentially unsafe."; reviewer
      `auto_review`), Full Access ("Codex can edit files outside this
      workspace and access the internet without asking for approval.
      Exercise caution when using."; `danger-full-access`, `never`). Plan
      mode is Codex's collaboration mode on top of any of them: the app
      says the collaboration mode on every turn (`turn/start`
      `collaborationMode`, plan or default, with the thread's model; a
      thread keeps the last one it was given), Plan with Codex's own effort
      for it, Default with the member's. Read Only is still one of Codex's
      presets but not in its picker: it shows only while a member is in it.
      Ask for approval and Read Only name the User as reviewer explicitly,
      so `approvals_reviewer` in the User's own Codex config does not turn
      the mode her menu shows into another one.
    - Antigravity 1.5.14 (`agy --mode`; its Default is `agentMode: ""`,
      which `--mode` does not take): Default ("Standard behavior."),
      Accept-edits mode ("Auto-approve file edits, prompt for commands."),
      Auto mode ("Auto-approve edits and safe commands, prompt on
      irreversible actions."), Plan mode ("Research and plan without making
      changes."). Print mode cannot ask, so what a mode would ask about is
      refused (agy 1.5.14, 2026-11-21: Default refuses edits and commands,
      Accept-edits mode refuses commands); the menu says so under the list
      ("Antigravity cannot ask for approval here, …").
    A new main session starts in the mode its CLI starts in with the
    User's own config on the device that runs it (the User, 2026-11-22:
    "a new session must start in the mode, model and effort its CLI would
    start in with her config"; `CliStartDefaults`,
    `src/shared/cliStartDefaults.ts`, `startChatAccessOption`), read from
    the CLI itself with its model list: Codex's `config/read` (the preset
    its `/permissions` marks current: sandbox, approval policy and reviewer,
    `guardian_subagent` being `auto_review`; her config starts it in
    Approve for me), Claude Code's `initialize` answer
    (`current_permission_mode`, from `permissions.defaultMode`) and its
    `get_settings` answer (`applied.model`, `applied.effort`), agy's
    settings.json `agentMode` (`""`: Default; none saved: agy starts in Auto
    only where the account has Auto mode, which the app cannot read, so
    Default). A machine reads its own and says them in its hello
    (`cliStartDefaults`, re-sent when a read changes them; a hello without
    them keeps what the machine said before); the
    phone gets this computer's with each provider
    (`NewChatProviderOffer.start`) and each machine's
    (`HubNewChatOptions.cliStart`). The mode follows where it runs until
    one is chosen; a mode chosen stays. The chat is made in the mode the
    screen showed (`newChatMainSessionStartAccess`), never one read again at
    send. A changed config file (Codex's config.toml, Claude Code's
    settings.json, agy's settings.json) is read again the next time a
    composer shows these (`cliConfigStamp`). A config the CLI's own picker
    has no entry for never starts the session wider than the CLI would run:
    it starts in the closest mode that runs nothing without her yes that her
    config would not run without it (asking her is never wider; a wider
    sandbox, or Codex's own reviewer deciding for her, is). A read-only
    sandbox always starts in Read Only, whoever reviews its asks (her config
    with `sandbox_mode = "read-only"` added: `config/read` answers
    `approvals_reviewer: auto_review` beside it, and the session started in
    Ask for approval before, 2026-11-22). Codex's "Custom permissions":
    `never` starts in Ask for approval (it asks her for what `never`
    refuses); `on-failure` like `on-request` (Approve for me under Codex's
    reviewer, else Ask for approval); Full Access's sandbox that asks starts
    in the workspace sandbox the same way; `untrusted` (it asks before
    commands Ask for approval runs), a granular policy, or a sandbox or
    reviewer the app cannot read start in Read Only, Codex's narrowest
    preset (`codexStartAccess`);
    Claude Code's Bypass Permissions, Don't Ask or a mode the app does not
    know start in Manual, which asks before anything her settings do not
    allow (Claude Code 2.1.330's `initialize` says `bypassPermissions` and
    `dontAsk` as they are, an unknown `defaultMode` as `default`;
    `claudeStartAccess`); agy's unknown `agentMode` starts in Default. When
    the config cannot be read, or a machine's program predates start
    defaults, the CLI's built-in default applies: Manual, Ask for approval,
    agy's Default (`defaultChatAccessOption`). A config in the project folder (Claude
    Code's `.claude/settings.json`, Codex's project `.codex/config.toml`) is
    not read for this (docs/parity-requirements.md, known divergences).
    Starting in Full Access from her own config asks nothing, as Codex does
    not; choosing it in the menu asks Codex's own question first, in place
    of the list (`FULL_ACCESS_CONFIRMATION`, Codex 0.155.1's `/permissions`
    in a terminal, 2026-11-22): "Enable full access?" "When Codex runs with
    full access, it can edit any file on your computer and run commands
    with network, without your approval. Exercise caution when enabling
    full access. This significantly increases the risk of data loss, leaks,
    or unexpected behavior." with "Yes, continue anyway" ("Apply full
    access for this session") and "Cancel" ("Go back without enabling full
    access"), which goes back to the list; the phone's sheet asks the same,
    drawn as its question before a pairing code is used: the question, then
    "Yes, continue anyway" as its filled button and "Cancel" as its
    outlined one, each with Codex's line under it.
    Codex 0.155.1 asks it even with `notice.hide_full_access_warning` set.
    Stored choices keep working: a member saved
    with Claude Code's old Default is Manual (same mode), a phone sending
    the old id `default` gets Manual, and a Codex member saved in the old
    Plan entry (Plan as a permission) is Read Only with Plan mode on. Codex's
    Full Access is Codex's alone: a member on another CLI handed it (a Codex
    main session's mode for a member it makes) runs Auto
    (`chatAgentModeForKind`), and only the User chooses it: a mode a member
    or a machine names (a tool's input, a member it adds) is Auto at most
    (`chatAgentModeFromAgent`); her server adds a member in Full Access
    without a card only for a main session in it, which hands its mode to
    the members it makes; and it runs only in the CLI's own mode
    (`cliApprovals`), else as Auto. Codex's Plan mode exists only in the
    CLI's own mode (normalising drops it otherwise), stays as it is when a
    preset is chosen (a member saved in Plan from before too), is not handed
    to a member the main session makes, and fails a turn rather than running
    without it on a Codex that refuses the collaboration mode (Default then
    goes without it). A machine runs both only when its program says so in
    its hello (`cliModesSupported`): on an older one Full Access and turning
    Plan mode on are disabled with "<machine> runs an older program:
    Settings → Machines → Upgrade runtime." (`codexModesUnavailableReason`;
    a Cloud run member by the machine on the AWS instance it names, none
    while that machine is still to be set up with this computer's program),
    and the phone's New chat offers them only from a computer that runs them
    and for a machine whose program does (`HubNewChatOptions.cliModes`). A
    Codex member already in one of them there (moved to that machine, or a
    Cloud run member whose machine turned out older), judged as it runs (one
    held to its main session's mode by that mode, `memberAsItRunsNow`), is
    never run as something else: its turn is refused, as Fork to new chat,
    Restart and compaction refuse an older program, with "<machine> runs an
    older program that cannot run Full Access: Settings → Machines → Upgrade
    runtime, or choose another mode." (or Plan mode; `cliModesTurnRefusal`)
    on its bubble (a member's request to it fails with the line in its card;
    no bubble is left waiting), and its menu and Plan mode's tooltip say the
    reason. The computer never asks the server for that turn (the member is
    left out of the message's `deliveryTargets`, `machineCliModesRefusal`;
    a turn the server already held for it is stopped there); a phone's
    message naming it is refused whole by the server with the same line
    (the phone shows it under the message; the computer posts the message
    and refuses that member alone), and a phone or machine asking it any
    turn but a compaction, a restart or a move is refused too
    (`HubOps.cliModesRefusal`), by each machine's program as the computer
    last said it with her member rules (`HubMemberRules.machineCliModes`,
    published again when a hello changes it; an entry in another shape is
    left out). A machine that never greeted the computer is not held back:
    its program is the one the computer set it up with. Not held back,
    because the older program cannot be changed and nothing asks the server
    for them: turns that machine starts itself (an answered card of its own
    member, a request between its own members, auto-watch, its scheduled
    scripts) and turns queued for it before the computer first said its
    program; and Codex's Ask for approval and Read Only there take the
    machine's own `approvals_reviewer` (the app names the User from this
    version on), which the app's setup leaves unset. Fork to new chat, a
    member the main session adds and a new chat's main session always run
    in their CLI's own mode (`inCliOwnMode`: the mode they were running in,
    their other rights kept; the User, 2026-11-22: "нахера там вообще этот
    кастом?"). A chat switched to the sessions view moves its members with
    rights from the classic view into the CLI mode each was running in, for
    good (back in the classic view they stay in it); a switch made on the
    phone is written by the computer when it reaches it
    (`membersInCliOwnMode`, `convertMembersForSessionsView`; the User,
    2026-11-22: what was refused silently, the CLI now asks about). Settings
    from the classic controls are no
    mode: the mode control says "Custom", its menu says so, and a classic
    toggle (Read Files, Edit Files, Run Shell, Access Web) ends a mode
    chosen in its menu and Codex's Plan mode with it
    (`withClassicChatPermissions`), so what it turns off is refused, not
    asked about. A member the main session made is held to the main
    session's mode: a mode above it is shown disabled with "Not above the
    chat's mode (<its mode>)." (the main composer's mode; the view names no
    main session) (`accessHeldReason`, by the same
    rule its turns run by, `memberAsItRunsNow`), never granted. A member held
    to a main session without the CLI's own mode loses its own mode too; an
    Antigravity member then runs Default with no edits (`--sandbox`), never
    with its confirmations skipped (`clampChatAgentAccess`). Its … actions
    (Restart: picks up changed connectors, idle only, naming background
    work it stops, not Antigravity; Fork to new chat; and, for a member,
    Remove from chat) are in the … menu of its session's header; the main
    session's (Restart, Fork to new chat) are in the chat title's menu under
    the view switch, after a hairline and with no label (no label names the
    main session); Fork's line there and in a member's … menu reads "A new
    chat that starts from a copy of this session" (the classic view's keeps
    its own words). Its provider stays the one it was made with. No name,
    status, member rights or auto-watch: the main session's chat behaviour
    is fixed (it creates and asks members, request and manage are allowed
    as its role gives them, and it is told when its tasks end). The model
    control names the member's own model, else the one its CLI runs on by
    default (the CLI's model list: Claude Code's initialize answer, Codex's
    model/list, `agy models`; an added provider's vendor default), else the
    CLI ("Claude Code") (`memberModelName`; desktop only, the phone has
    no controls in a chat). The main composer has no "N active runs" pill (the Waiting
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
    all, never the main session itself (its settings are its composer's controls);
    while one runs or waits for the User the ended ones are under
    "Previous"; those no longer in the chat are under "Removed"
    (`sessionsFormerMembers`). With nothing delegated it says nothing. A member opens its **whole session** in the
    same panel (Back to the list) with its … menu in its header and a composer
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
  - what the app itself writes names nobody by handle (the User,
    2026-11-21: "so that I never see this crap '@main' anywhere in the
    UI"): the notices, a failed or stopped reply's own lines, the cards
    (approvals, choices, removals, sign-ins, scheduled tasks), the status
    line, task rows, Accord and document notes, reactions, Activity rows and,
    on the phone, its cards, alerts, stream view and chat list name a member
    by its task's title (in quotes inside a sentence) and the main session by
    nothing: a sentence about it loses its subject ("Stopped before it
    returned a response.", "The copy may include what was done after you
    tapped Fork: …"), a "who" line shows no name, a list leaves it out. The
    words are stored as members read them and worded when shown, by one rule
    on the desktop and the phone (`sessionsViewText`, `sessionsViewReplyText`,
    `sessionsViewSummaryText` in `src/shared/sessionsViewText.ts`), so the
    classic view keeps every handle; what a member wrote, a tool's request
    (a command) and anything quoted stay as written. The same holds for search
    results (a member's message shows no author), Activity rows (no avatar:
    the member's provider logo), an add-member card (no handle field or
    avatar picker; the handle is still made underneath) and the urgent
    alert's Telegram message and call (her server names a member by its task
    and the main session by nothing). No label names the main session
    either: in a member's session its task is "Task" and its answers carry
    its provider's logo; Stop is "Stop"; the New chat note says which CLI
    runs the chat;
  - the Accord: above the composer one quiet line (Accord · its name ·
    where it stands) that opens the whole card in the side panel; the
    classic view keeps the pinned card;
  - pages: the main timeline stops loading older pages by itself after two
    pages that added nothing to it ("Load older messages" goes on); "Load
    older" in a member's session goes on until a message of that member
    arrives or the chat's start, six pages at most.

## New chat

A new chat opens in the sessions view (`newChatViewFor`).

**Settings → General → New chats** (the User, 2026-11-22: "для нового режима
— это просто должна быть секция в settings с дефолтными значениями
провайдера, модели и вещей типа этой"; mockup `general-new-chats`): a section
of the General page between Local CLI setup and General, one card. Its words
name no main session.

- **Provider**, "The CLI a new chat runs on." (`assistantProviderKind`, the
  setting the Chat Assistant used; the provider's glyph in the select).
- **Model**, "From <CLI>'s own model list.": the model the CLI runs by
  default first, named (the composer's model menu's list:
  `defaultModelOf`/`explicitModels`), then the others.
- **Effort**: "Default" (with the effort her config sets, when it sets one)
  and the model's efforts; a model without the chosen effort takes the CLI's
  own.
- **Mode**: exactly that CLI's own permission modes as the composer's mode
  control lists them (`chatAccessModes.ts`), its description naming them
  ("Claude Code's modes: Manual, Accept edits, Plan, Auto.", and
  Antigravity's note); none chosen, the one her config starts the CLI in
  where a new chat runs. Codex's Full Access asks Codex's own "Enable full
  access?" first. Codex's Plan mode stays a New chat toggle.
- **Runs on**: This Mac (This computer elsewhere) or one of her machines
  (Settings → Machines' list); a machine no longer set up is this computer,
  and so is any added provider chosen on New chat (its key is this
  computer's: members on one run here only). Codex's Full Access is not
  started on a machine whose program cannot run it (the mode its CLI starts
  in there instead, on the computer and the phone alike).
  The computer's New chat sets it as its Runs on control sets that machine
  when chosen there (`newChatDesktopStart`): a machine on her AWS instance
  as Cloud run on that instance (its first turn makes it ready and copies
  the project), another machine as its own; the phone puts the main session
  on the machine, as its Runs on does.
- **Compact without asking**, a switch, on by default: the main session's
  right to compact its context without a card (`requestCompaction` `allow`;
  off: `ask`).

Changing the provider takes model, effort and mode back to that CLI's own
(`newChatDefaultsForProvider`); where it runs and compaction stay. Model,
effort and mode apply only while a new chat runs on the CLI they were
chosen for, on its own sign-in (`newChatMainSessionStart`); an added
provider or another CLI chosen on New chat starts from its own. The rights
to ask and add members are not settings: the main session's role always
gives them. Stored as `AppSettings.newChatDefaults`
(`src/shared/newChatDefaults.ts`, normalized on read: anything missing or
invalid is the CLI's own); existing chats keep their own settings.

New chat's controls start from these (`newChatMainSessionParticipantConfig`
with `newChatMainSessionStart`); a choice there is that chat's only and
never changes Settings. The computer's `createConversation` gives the main
session the compaction right Settings names (the screen has no control for
it). The phone's New chat offer carries the same main session
(`ensureMainSessionParticipant` with `newChatDefaults`): its model, effort,
mode, machine and compaction right; the phone's controls start from it
(`newChatLeadStart`) the way the computer's start from Settings, another
provider from its own, and a choice made there wins for that chat.

- **Sessions view** (the User, 2026-11-21: "как в T3, выбираешь просто
  провайдера и модель"): no members picker, no avatars, handles or
  "members" on the screen. Its composer has the main composer's controls
  (model with the provider's glyph, effort, permission mode, Codex's Plan
  mode, where it runs once a machine exists); the model's menu lists the
  providers first: every ready CLI and every added provider whose CLI is
  ready and which has its key (`mainSessionProviderOptions`). The default provider is Settings →
  General → New chats' Provider (`resolveMainSessionProvider`); the
  controls' choice is for that one chat and never changes the setting, and
  is forgotten when the User leaves New chat without sending. What was set
  for one provider (model, effort, access, where it runs) is dropped when
  another is in effect, also between visits. A chosen or shown provider
  that stops being ready is said on the screen and the send is refused,
  never made on another one silently. The
  chat is made with that main session alone; an @handle in the first
  message picks nobody. Folder and attach stay.
- The classic New chat with its members picker is no longer reached
  (every new chat opens in the sessions view since 2026-11-22).
- **The phone** gets the same from the New chat offer
  (`HubNewChatOptions.mainSessionProviders`: each provider with its
  default model's name, its models, at most 24, and efforts;
  `newChatProviderOffer`), shows a chip and sheet with the same choices
  (the permission modes under the CLI's own title, with the same names and
  descriptions from the one shared table, Codex's Plan mode as a toggle
  row, Antigravity's note, and Runs on where a machine exists), and makes
  the chat with the offered main session on the chosen provider, model,
  effort, mode and Plan mode (`newChatMainSessionFor`). An offer from a computer from before has no
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

- Offered as "Fork to new chat" in the sessions view in a member's … menu
  (its session's header) and, for the main session, in the chat title's
  menu, and as a fork button on its card in the classic roster. Disabled,
  with the reason, for Antigravity (no fork), a member that never ran (no
  session), one waiting for a machine, one on an added provider Settings no
  longer has (its copy would run on another provider), one on a machine
  whose program is older (Upgrade runtime) or has never greeted this
  computer, and one on this computer whose CLI is not ready.
- On the phone, in the sessions view it is in the title's menu: for the main
  session on the main timeline (under the chat's view), for a member on its
  own screen (the title opens that menu there; the side panel stays on its
  icon). In the classic view (a chat from before with its Assistant) it is a
  small fork action at the end of each member's row in the members sheet, as
  on the computer's roster card; a tap opens the same item under that member
  (what it makes, or why not; a phone has no tooltip) and a tap on the item
  makes the chat. Opening the menu or the item reads `GET /v1/phone/new-chat?forkOf=<chat>&
  participantId=<member>`: the server adds the member and the chat's main
  session as it holds them (never a session a move hands over) and whether
  the member has a finished reply there; the computer's New chat offer
  carries `fork` (why each of its CLIs cannot run a member now, each
  machine's program by its last hello, the main session's role's rights).
  The phone judges with the same `forkToNewChatUnavailableReason` and
  words, the member as it runs (`memberAsItRunsNow`), and makes the main
  session with `forkedMainSessionFor` (the computer's own result, checked by
  a test), then queues `conversation.create` and the intro line like its New
  chat and opens the chat at once (unless she left the chat while it was
  made: below). A server or computer from before says it
  must update. "Ran" for a member on a machine is one rule everywhere
  (`isFinishedMemberReply`: a finished reply, an error too; never one still
  being written nor a placeholder shown for a turn elsewhere), and the
  server reads its copy of the chat by it. One narrow difference: the phone
  cannot see a member's session record, so it applies that rule to a member
  on the computer too; one whose session was dropped since is offered, and
  its fork starts clean and says so (below).
- The new chat is made through the same path as every new chat
  (`createConversation` with `forkOf`, saved and so put on the User's server):
  titled "<chat> (fork)" until its first reply names it, in the member's
  project, in the sessions view, with one member: its main session on
  the member's provider, model, effort, access (its CLI's mode and what it
  may read, edit, run and reach, and whether it compacts without asking, as
  it runs now; never Settings → General → New chats: the User, 2026-11-22, a fork
  of a member allowed to compact is not asked) and place (this computer or
  the same machine: a fork never crosses devices), with the main session's
  role and its say over members, marked `ChatParticipant.forkOrigin`
  (written only by the computer; her server keeps a machine from writing
  it). The chat opens at once with its composer focused (unless she has gone
  elsewhere by then: below); the member and its
  chat are not touched. Making it checks only the CLI its main session runs
  on: a member on this computer has its own CLI checked (a check less than
  30 s old reused, otherwise that CLI alone, never every CLI); a member on a
  machine none (`forkReadiness`, `CliReadinessService.refreshKinds`). When
  the check still takes a moment (reading the computer's environment first),
  a "Forking to a new chat…" notice shows after 150 ms until the chat is made.
  When she has gone to another chat or screen by the time it is made (a
  chat opened from the sidebar, search, Activity or a notice; New chat;
  Activity; Settings), that stays on screen and keeps the keyboard: the new
  chat is listed and a notice says "Forked to a new chat: <title>" with Open
  (`stillHere` in `forkChatParticipantToNewChat`; told by what the latest
  open request was for, `openConversationTargetRef`, since Back from Activity
  and a click on the open chat count as requests too); a refusal is then a
  notice too, not the error banner of the chat she opened. Open takes the
  keyboard to the fork's composer (at once when it is already on screen);
  opening any other chat first drops that request, so it never fires on a
  later visit (`composer-focus-request.ts`). The fork frees New chat as soon
  as its chat is made or refused. On the phone,
  where the tap waits on her server for up to 4 s, the same: gone from the
  chat, she stays where she is and the new chat is in her list
  (`stillInForkedChat`; the phone has no notices).
- Its first turn (on the device it runs on) reads the member's session from
  the member's chat there (`startFromForkOrigin`; only that chat's session
  records) and forks it as a delegated fork does (`forkFrom` with the source
  chat's id). It is told it is the new chat's main session, not a member,
  with the main session's role instructions, and reminded on later turns. A
  main session that already answered never becomes a copy again. A member
  that moved to that device and whose session still waits on her server is
  taken first, as its own next turn would take it. When the member's session
  is not on that device, it starts clean and says so before its turn runs
  ("@main could not start from a copy of @x's session in the chat "T":
  that session is not on your computer / the cloud machine @main runs on,
  so it starts a clean session."; when its provider was changed since,
  "@main now runs on Codex, not Claude Code"); when the CLI cannot copy it,
  the turn starts clean as a delegated fork's does (below: her message
  still gets its reply), said the same way. Every notice of
  a fork (this one, a clean start, the "may
  include" line below; a delegated fork's too) is said by `postForkNotice`
  twice over: as a line in the chat (a system message on the "system"
  thread, id `fork-notice-<kind>-<member id>`), which goes to her server
  with the chat and so reaches every device, a fork run on a cloud machine
  or asked from the phone too; and, as before, as a chat warning on the
  device that ran it, which stays there. Open: the chat's timeline shows no
  system line on any device (`isChatMessageHiddenFromTimeline`, and the
  phone's timeline by the same rule), so today the User sees only that
  warning, on the device that ran the fork; showing the line on the
  computer and the phone needs a look of its own (and her server holding
  its writer to the member's device). Each is written once per member and
  kind (her server refuses a second line with that id), so a turn run again
  after a restart or handed over again says nothing more. The member's chat
  is read without its messages (its metadata and newest messages).
- The copy is what she saw when she tapped Fork. The User, 2026-11-21, on
  her card "When should a fork copy the member?": "When you tap Fork — Like
  the CLI: the copy is exactly what you saw at that moment; beta.3 comes out
  a little later." So the copy ends with the turn of the member's last reply
  that ended a turn of its CLI, and whatever the member did after the tap is
  not in it:
  - Every reply that ends a turn records where its CLI session stood then
    (`ChatMessageMetadata.sessionCut` `{ sessionId, at }`, written by the
    device that ran the turn): Claude Code, the uuid of the turn's last
    assistant message on its stream (not a subagent's); Codex, the turn's
    id (a goal's last turn).
  - At the tap the device making the chat records that reply in
    `forkOrigin.seen` (`{ messageId, sessionCut?, finishedAt? }`,
    `forkSeenReplyOf`): the member's newest reply that ended a turn
    (`isMemberTurnEnd`: a finished reply with `workedMs` or `sessionCut`,
    which only a turn's end sets; never a post, a request or an Accord
    launch written during a turn, so a turn still running at the tap is
    left out with what it posted). The computer and her server read it by
    the same query (`StorageService.conversationLastTurnEnd`); the computer
    reads it first, before its checks. The phone takes her server's
    (`HubPhoneForkSource.seen`), read again when she taps (a reply that
    finished while the item was open counts; out of reach within 4 s, the
    read from when the item opened), and writes the same field through
    `forkedMainSessionFor`.
  - At the first turn the device that holds the session names the point
    (`forkCutFor`): the recorded one, in the session the reply was in (when
    the member's session changed after the reply, that earlier session is
    copied up to it, if it is still on that device); for a reply from
    before `sessionCut`, by time on the clock of
    the device that ran it (`finishedAt`, its turn's start plus `workedMs`):
    Claude Code, its last assistant message written by then; Codex, its last
    finished turn that started before then (Codex's turn ids are UUIDv7),
    or, for an id that does not say, completed by then to the second.
  - Claude Code forks with `--resume <member's session> --fork-session
    --resume-session-at <uuid> --session-id <new>`, after reading the
    transcript a line at a time (`claudeForkCut`; her longest, 113 MB,
    reads in about 0.4 s with no pause of the app over 12 ms); a compaction
    after the point, no point (the CLI does not load a message before a
    later compaction and refuses it), unless nothing but `/compact`s came
    after it (their boundaries, summaries and the command's own lines) and
    the last of them kept it as it was (`compactMetadata.preservedMessages`,
    which holds the last message before a `/compact`): the CLI loads that
    message after the compaction's summary, so the point is given and the
    copy is what she saw, compacted, with no line; refused after all, the
    whole session and the line, which names the compaction. A compaction the
    CLI made itself (`trigger` "auto", or one naming the turn it ran in)
    never counts: it ran during a later turn, whose prompt it may sum up. Codex forks with `thread/fork`
    `lastTurnId` (inclusive; a later compaction does not stop it), reading
    the thread's turns newest first (`thread/turns/list`, no items) for a
    reply from before. The point is given even when nothing follows it yet:
    the copy is then all of it, as before this rule, and a turn the member
    starts while the copy is made stays out. A point on a tool call whose
    result never came (a stopped turn) is fine: Claude Code fills it in as
    missing (checked). Antigravity has no fork.
  - When no point can be named (no reply that ended a turn, it is not in
    the session on that device, the earlier session it was in is gone,
    Claude Code compacted the session after it, Codex could not list the
    turns, the CLI refused the point or does not know the flag), the whole of the
    member's session is copied, as before this rule, and a line in the chat
    says so before the turn's reply (Codex once its copy is made, Claude Code
    once it has read the transcript; the turn may last hours, and the app may
    stop during it): "@main's copy of @x's session
    may include what @x did after you tapped Fork: <why>." (`postForkNotice`,
    above: a line in the chat and a warning on the device that ran it).
    Never a clean start: the copy keeps what she saw, the line says what may
    be more. A `/compact` after her last reply that kept it (above) gives
    no line; a compaction the CLI made itself during a later turn does. A
    source that is gone gets no copy and no such line, only the clean
    start's (a Claude Code session whose transcript is on no folder of
    this device is not said to be copied whole; Codex's "could not list the
    turns" waits for `thread/fork` to answer).
  - Checked 2026-11-21 on throwaway sessions: Claude Code 2.1.329 forked at
    the first of two turns ("remember APPLE", "remember BANANA") answers
    APPLE only, in one-shot and in stream-json (warm) mode, the source
    untouched; an unknown uuid and a uuid before a later `/compact` are
    refused ("No message found with message.uuid of: …"). Codex 0.155.1
    `thread/fork` with `lastTurnId` of the first turn answers APPLE, also
    after a later compaction; an unknown turn is refused ("turn not found").
    Through the app's own runner (`CliAgentRunner.run` with `forkCut`) on
    the same sessions: the recorded point and the reply's finish both give
    APPLE for Claude Code and Codex; an unknown point gives "APPLE and
    BANANA" and the reason. A Claude Code fork at a tool call with no
    result answers that the result is missing. Claude Code 2.1.329 forked
    at the last assistant message before a `/compact` (which that
    compaction kept) answers both words from the compacted session: its
    copy is the compaction's summary, that message and the new prompt, the
    `/compact` lines after it dropped.
- Claude Code 2.1.329 forks a session from another folder as well as from
  its own (checked 2026-11-21); the new chat keeps the member's project so
  the copy works in the folder it knew.
- A machine says it can do this in its hello (`forkToNewChatSupported`).
  The flag is new with this feature (no released runtime carries it), and
  the program that sends it also cuts the copy, so no machine forks without
  the cut.

## The CLIs' modes: evidence (2026-11-22)

Verified in the installed CLIs, the way the User sees them:

- Claude Code 2.1.330: `claude --help` lists `--permission-mode` choices
  acceptEdits, auto, bypassPermissions, manual, dontAsk, plan; the binary's
  mode table titles them Manual, Plan, Accept edits, Bypass Permissions,
  Don't Ask, Auto, maps `manual` to its internal `default`, and its
  Shift+Tab cycle goes Manual → Accept edits → Plan → (Bypass, only when
  started with `--allow-dangerously-skip-permissions`) → (Auto, where the
  account has it) → Manual; Don't Ask is not in the cycle. `claude -p
  --permission-mode default` and `… manual` both run (Sonnet). The Claude
  desktop app (6.28899.6) lists Code sessions' modes as Manual ("Always ask
  before making changes"), Accept edits ("Automatically accept all file
  edits"), Plan ("Create a plan before making changes"), Auto ("Claude
  handles permission decisions"), and Don't ask / Bypass permissions only
  when switched on; its chats (her screenshot) word Manual and Auto
  differently ("Claude asks before using new tools or opening new sites.",
  "Claude runs on its own and pauses to ask if anything looks unsafe."). Its
  model menu shows the newest of each family first and the rest under
  "More models".
- Codex 0.155.1, its TUI in a pseudo-terminal: `/permissions` ("Update Model
  Permissions") lists 1. Ask for approval, 2. Approve for me, 3. Full Access,
  with the descriptions above, with or without `-s read-only` (Read Only
  stays in its binary's presets). `/plan` "switch to Plan mode"; Shift+Tab
  toggles "Plan mode (shift+tab to cycle)" and back ("Model changed to …
  medium for Plan mode"). Through `codex app-server`: `turn/start`
  `collaborationMode` plan produced a plan and no file, kept the thread's
  developer instructions, and stayed on for the next turn until Default
  was sent; `sandbox: danger-full-access`, `approvalPolicy: never` wrote a
  file outside the workspace without asking. The User's own config
  (`approvals_reviewer = "guardian_subagent"`) marks Approve for me current
  in her terminal.
- Antigravity 1.5.14, its TUI: Shift+Tab cycles Auto mode ("Auto mode:
  edits & safe commands auto-approved") → Plan mode ("Plan mode: research &
  plan only") → Default (no line) → Accept-edits mode ("Accept-edits mode:
  file edits auto-approved") → Auto mode; `/config` → Agent Mode describes
  them ("'default': standard behavior. 'accept-edits': auto-approve file
  edits, prompt for commands. 'auto': auto-approve edits and safe commands,
  prompt on irreversible actions. 'plan': research and plan without making
  changes"). Her config starts it in auto.

## Start defaults, Full Access and Plan members: evidence (2026-11-22)

- Codex 0.155.1 `codex app-server`: `model/list` marks `gpt-6-luna`
  (GPT-6-Luna) `isDefault`; `config/read` on her config answers
  `model: gpt-5.6-luna`, `model_reasoning_effort: low`,
  `approvals_reviewer: auto_review`, no approval policy or sandbox; her
  terminal (`codex`, update check off) shows "gpt-5.6-luna low" and its
  `/permissions` marks "2. Approve for me (current)". `config/read` takes
  a `cwd` for project layers; a `profile = …` key in config.toml is
  refused ("legacy `profile` config is no longer supported; use
  `--profile`"), so a profile applies only with `--profile`, which neither
  her plain `codex` nor the app passes. A turn's `turn_context` (its
  rollout) shows `model: gpt-5.6-luna`, `approvals_reviewer: auto_review`
  and, with a collaboration mode that carries `reasoning_effort: null`, no
  effort at all; with her config's `low` sent, `low`, as her terminal's
  turns show.
- Codex's terminal, `/permissions` → Full Access, shows "Enable full
  access?", the body above, "1. Yes, continue anyway  Apply full access for
  this session", "2. Cancel  Go back without enabling full access", "Press
  enter to confirm or esc to go back"; with `-c
  notice.hide_full_access_warning=true` it asks the same.
- Claude Code 2.1.330 in stream-json: `initialize` answers
  `current_permission_mode` (`acceptEdits` with `permissions.defaultMode:
  acceptEdits` in the settings it reads); `get_settings` answers
  `applied: { model: "claude-sonnet-5-5", effort: … }` for `model:
  "sonnet"` or `ANTHROPIC_MODEL=sonnet`, while `initialize`'s "Default
  (recommended)" row still resolves to Opus 5.5.
- agy 1.5.14's changelog: "Changed the default `Agent Mode` from Default to
  Auto: sessions with no saved mode, including headless `-p` runs, now
  start in Auto wherever Auto mode is available and in Default elsewhere
  … choose Default for `Agent Mode` in `/config`, which saves
  `"agentMode": ""` to `settings.json`." Auto mode is available on Linux
  and macOS.
- Subagents of a session in Plan, both CLIs' own: Claude Code's docs
  (code.claude.com/docs/en/sub-agents): "When the main conversation is in
  `plan` mode, the subagent stays in plan mode whichever `permissionMode`
  you set, unless it runs as an agent team teammate." Seen with `claude -p
  --model sonnet --permission-mode plan`: the Agent tool is offered, its
  general-purpose subagent's Write is refused "Cannot write to …/sub.txt
  while in plan mode" (`decision_reason_type: "mode"`), and a custom agent
  with `permissionMode: acceptEdits` is refused the same. Codex 0.155.1:
  `multi_agent` is on by default and `spawn_agent` is offered in Plan
  mode; the spawned child's rollout runs `collaboration_mode.mode:
  "default"` with the parent's sandbox and approvals ("Subagents inherit
  the parent turn's current sandbox and approval settings", its docs) and
  wrote a file while the parent was in Plan. So a member the main session
  makes runs as its main session's CLI runs a subagent: under a Claude
  Code (or agy) main session in Plan it is held to Plan whatever it asks
  for (`memberAsItRunsNow`, Plan ranks lowest); under a Codex main session
  with Plan mode on it runs Codex's Default with the main session's preset,
  Plan mode not handed down. Both checked in `chatAccessModes.test.ts`.

## Claude Code's plan approval (2026-11-22)

A Claude Code member in its CLI's own Plan mode that finishes its plan calls
ExitPlanMode, which reaches the app's permission prompt tool. The User decided
(2026-11-22) that it is answered on the CLI's own dialog, on the desktop and
the phone alike, and that the member's mode then follows the CLI.

- The card (`src/shared/claudePlanApproval.ts`) is Claude Code 2.1.330's
  dialog, read from its binary: "Ready to code?", "Here is Claude's plan:",
  the plan, "Claude has written up a plan and is ready to execute. Would you
  like to proceed?", then its rows: "Yes, auto-accept edits"
  (`yes-accept-edits-keep-context`, mode `acceptEdits`), or "Yes, and use
  auto mode" (`yes-resume-auto-mode`, `auto`) in its place where the account
  has auto mode; "Yes, manually approve edits" (`yes-default-keep-context`,
  `default`); "No, keep planning" (`no`) with its field "Tell Claude what to
  change". A plan over 200,000 characters is not shown ("(the plan is too
  large to be shown in full, so it can only be declined)") and only "No, keep
  planning" is offered; an empty one shows "No plan found. Please write your
  plan to the plan file first.". The app knows auto mode is on the account
  only once the member's live CLI reported auto mode itself; until then it
  offers "Yes, auto-accept edits" (an open divergence,
  docs/parity-requirements.md).
- A Yes answers the permission prompt tool with `{ behavior: "allow",
  updatedInput, updatedPermissions: [{ type: "setMode", mode, destination:
  "session" }] }`, as the CLI's own dialog applies it. "No, keep planning"
  denies with her words in the CLI's rejection ("The user doesn't want to
  proceed with this tool use. … To tell you how to proceed, the user
  said:" and her words; with nothing typed, its rejection that stops and
  waits for her). An answer that is not one of the card's rows (an older
  phone's Allow) is refused and the card asks again. No rule answers it, not
  even one "for this chat".
- Verified in the app with Claude Code 2.1.330 (Sonnet, an isolated
  instance): ExitPlanMode's input carries `plan` and `planFilePath`; after
  "Yes, auto-accept edits" the CLI said `system/status` `permissionMode:
  acceptEdits` 22 ms after the answer, wrote the file without a card, and the
  next message ran in Accept edits; after "Yes, manually approve edits" it
  said `default` and the next Write asked on a card; "No, keep planning" with
  words brought a revised plan that followed them.
- The member's mode follows the CLI: a `system/status` mode the app did not
  ask for (not its start, not a `set_permission_mode` waiting for its answer)
  is saved as the member's mode through the member settings' save
  (`applyChatAccessOptionById`, its other rights kept), so every device shows
  it and its next message runs in it; the process is not switched back to
  Plan by the turn-start alignment, and a save from before the switch does
  not switch it back. A mode the User picked meanwhile wins. On a cloud
  machine her server lets the machine write that mode once for the plan she
  approved (`hubMachineScope.ts`, `planModeGrants`).
- An answered card keeps only what it offered and the row she picked: the
  plan stays in the CLI's session, so answered plans do not pile up in the
  chat.

## Contract (src/shared)

- `MAIN_SESSION_ROLE_ID = "main-session"`, handle base `main`.
- `ConversationMetadata.mainSessionParticipantId`: set when the chat is made,
  never changed. `isMainSessionChat()` reads it (and checks the member is
  still there).
- `ConversationMetadata.chatView?: ChatViewMode` (`"classic" | "sessions"`),
  read through `chatViewFor(metadata)` (unset: `sessions`).
- `AppSettings.newChatDefaults?: NewChatDefaults` (`src/shared/newChatDefaults.ts`),
  changed with `setNewChatDefaults(NewChatDefaultsUpdate)`
  (`settings:set-new-chat-defaults`).
- `SendChatMessageRequest.targetParticipantIds?: string[]`: exactly these
  members, no @-parsing for addressees, no fallback.
- `ChatParticipantSession.forkFrom?: { participantId, sessionId, kind }`: the
  member's first turn forks that session; cleared once it has its own id.
  Fork to new chat adds `cut` (`{ at? | finishedBy? | unknown? }`, where
  the copy ends); a delegated fork has none and copies the session as it
  is.
  `ChatParticipantSession.forkedFromParticipantId` stays: both CLIs keep the
  source's system/developer instructions in a fork (verified on Claude Code
  2.1.329 and Codex 0.155.1), so the member is told who it is on its first
  turn and reminded on later ones. When the source session is gone (only
  the CLIs' own words: Claude Code "No conversation found", Codex "no
  rollout found for thread id", `isForkSourceMissingError`), the member
  starts a clean session in that same turn, from a prompt that still
  carries its identity note and its role's instructions (Claude Code's
  one-shot start does it itself), so the message that asked it (the User's,
  or the main session's task) gets its reply and never fails for the copy.
  Any other failure of the copy (the CLI exited before it took the message,
  `thread/fork` failed: `ParticipantRunResult.forkCopyFailed`) is tried once
  more in that turn, then the turn starts clean. A failure that is not the
  copy's (a Stop, a project folder gone, a turn that failed after the copy
  was made, a second message whose process already made the copy) never
  does. Either way the member is a clean member from then on (fork dropped)
  and the chat says so, once ("@x could not start from a copy of @main's
  session, so this turn started a clean session."; `postForkNotice`, above;
  said before the clean turn runs when the CLI said the source is gone).
  When the clean start fails too, its chat-context pointer is dropped as
  well, the id its session was given is not kept when the CLI never took
  the message, and the failed reply the main session reads says it (a
  forked main session's own failed reply does not: the User asked it, and
  the notice is hers). When the clean session cannot start either after an
  unknown failure, the copy was not the cause: the member stays a fork, its
  next turn makes the copy, and nothing says it started clean.
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
