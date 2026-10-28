# Parity Requirements

This document is the governing statement of the two parity requirements every
product, architecture, implementation, and UI decision in AccordAgents must
satisfy, and the register of approved exceptions to them.

Both requirements are stated by the User. Neither may be weakened by an
engineering judgement call, a convenience trade-off, or an implementation
constraint discovered late. A difference that violates either requirement is a
**defect** until the User has personally approved it and it appears in the
Approved Exceptions register below.

## Requirement 1 — a cloud participant behaves exactly like a local one

For the user, there must be no difference between working with a participant that
runs locally and one that runs in the cloud. Same controls, same feedback, same
capabilities, same consequences for the same action.

Transport, setup, provisioning, and authentication may differ — those are
invisible plumbing. What the user does, sees, and gets must not.

This covers, without being limited to: available tools, output and streaming,
permissions and approvals, cancellation and its consequences, sessions and
resume, compaction, skills and rules, models, attachments, errors and warnings.

## Requirement 2 — a local participant behaves exactly like its dedicated CLI

Working with one participant in AccordAgents must feel like working with that
agent through its regular, dedicated CLI, to the extent the CLI itself allows.

The dedicated CLI is the source of truth. Where the CLI defines behavior,
AccordAgents mirrors it rather than inventing app-specific semantics. Where the
CLI cannot do something at all, AccordAgents is not required to invent it — the
requirement is parity, not superset.

CLI behavior evolves. Verify the current behavior when implementing or revisiting
a feature rather than relying on an earlier assumption.

## Standing decisions

These are not exceptions. They are decisions by the User about how parity is
achieved, and they hold identically for local and cloud participants.

### AccordAgents does not manage git worktrees

The app never creates, moves, or deletes a git worktree — not in the user's
project locally, not on a cloud worker, not per participant, not per run.

When a task needs isolation, the User asks the participant to work in its own
worktree, and the participant creates it itself with ordinary git commands,
exactly as it would in its dedicated CLI. Isolation is a task instruction, not an
app feature.

Consequences that follow from this and are not negotiable:

- No hidden per-run or per-participant copy of the project is created by the app.
- Whatever the app does to files on a worker must never destroy a
  participant-created worktree or its uncommitted changes.
- A proposal to "give each participant its own worktree" implemented *by the app*
  is a violation of this decision, however convenient it looks.

Stated repeatedly by the User; recorded 2026-08-20 after app-managed
per-participant worktrees were proposed again. `docs/cloud-runs-workspace-parity.md`
carries the operational detail.

### Independent laptop environments may share one AWS instance

The User's home and work laptops have unrelated projects and chats but share an
AWS account and one paid EC2 instance. Each laptop must retain its own environment
variables, global skills, native CLI profiles and sessions, machine enrollment,
and conversation data. Sharing an instance must not merge those environments or
overwrite the other laptop's setup. Existing projects and participant-created
worktrees must remain intact.

Both separately installed PWAs are on the same iPhone. Each installation belongs
to its own laptop environment: pairing, queued actions, messages and notifications
must stay with that environment. Shared availability when the EC2 instance stops
is expected; a second paid instance is not the solution. Stated by the User on
2026-09-11, including the same-iPhone clarification at 21:30 UTC. Verification
status and remaining real-device checks are in `docs/qa-cloud-environments.md`.

### Every device talks only to the User's own server

The User's own server (the hub: a small machine in the User's own AWS
account; when she has none, the same server run inside the app on her
computer, answering only there) owns every chat. A device writes what it
changes as operations; the server accepts each once, gives it its place in
one order and keeps the chat as it then stands; every device that keeps
chats (the computer, every cloud machine) reads what the server accepted from
its feed and keeps its copy from it, and the phone reads the server's chats
themselves. Members' turns are asked, taken and stopped on the server, and
the cards a member waits on are raised, answered and settled there. A
device's requests are signed with its own key, and the server answers only
devices on its roster, which the desktop that set it up keeps; nothing a
device writes into a chat carries a signature of its own. The desktop, the
phone and every cloud machine do not need to know or care about each other.

This reverses the decision of 2026-09-05 (Rule 1 of the signed accord "Cloud
transport cutover — accord resolution", artifact a6f1e5ad v4) that the relay
is a dumb pipe and that there is no shared journal: the shared journal now
exists, on the User's own server, never on a shared relay. Approved by the
User on 2026-10-18 with the plan "Свой сервер на AWS вместо Cloudflare relay"
(one road, no relay left in the end), and on 2026-10-28 with the transition
"the server owns the chat" (agreements Д1–Д13, artifact 26182886).

How far it is built, so the two are not confused:

- Since the server owns the chats (`taylor/server-owns-chat`, built
  2026-10-28 and 2026-10-29), every device is a plain client of it: the
  computer and every machine write operations and read the feed, a machine's
  member takes the turns asked of it there and writes its replies there, and
  the phone writes the User's messages, card answers and Stops as operations.
  The first time the computer links to a server it moves its chats there
  (each chat once, in pages); a phone's messages the server already had keep
  their place. What came before is removed in the same release, with no
  switch and no way back (Д7): the order of signed events every device kept
  (per-device chains, their sequence numbers and hashes, logical clocks),
  the desktop's special right over a chat's shared fields on the server,
  folding the server's copy from events, gap repair, held changes, the copy
  of the chats a new machine or a new server was given over SSH, and the
  "given up" and "has not read" lines in Settings → Your server. What a
  device kept for that order is dropped once, in the background, without
  holding the database (no VACUUM: the space is reused, the file does not
  shrink): on the computer after its chats are on the server, on a machine
  after it has read the server, on the server at its first start of this
  version. Settings → Your server says whether this computer reaches the
  server and, while it does not (or its chats are still moving), how many of
  its changes wait to be sent and why the last attempt failed.
- Since phase 5 (`taylor/server-only-all`, the cutover) there is no relay
  in the app at all: no relay connection, sealed mailbox, phone link or
  machine move, on the desktop, the machine runtime, the server or the
  phone. Without a server of the User's there is no phone and no cloud
  machine: Device Pairing and Cloud run say "Set up your server first", and
  nothing else changes for local members. What was set up through the relay
  (a machine enrolled with it, a phone paired through it) is taken off the
  desktop once, at its first start without the relay, without a notice in
  Settings; a phone pairs again from Device Pairing, a machine is added
  again. The Cloudflare relay worker itself is still deployed until the
  User says to shut it down; no build of the app talks to it.
- The phone talks only to the server: it pairs with the server by a code the
  desktop shows, and its messages, card answers and Stops are operations
  there; the member's home (the desktop for its own members, the machine for
  the members it hosts) takes each turn once. Cards, live progress, the
  composer's catalog, pictures and notifications come from the server, with
  the desktop closed too.
- The Stop exception below holds unchanged: a Stop is the turn's stop on the
  server (`turn.stop`), and when the member's machine cannot be reached (the
  server down, the machine offline or frozen) it shows waiting until the
  machine confirms.
- The server's storage stays bounded: it forgets an accepted operation once
  every computer and machine on its roster has read past it and it is a week
  old; a device that read less than what was forgotten reads its chats again
  from the server. A device that stops reading holds everything after its
  place, is never dropped automatically, and is asked about after ten days
  inactive (Settings, "Is <machine> still in use?"; its last read of the
  server counts as activity); removing it lets go. A phone never holds the
  server back: it reads the server's chats, not the feed, and what it has
  not sent yet stays on the phone until the server has it. The pictures
  messages name and the avatars the composer shows are kept as long as they
  are named, and a picture the phone put up is kept a month for the message
  naming it to arrive. Desktop, phone and machine see the same chats either
  way; nothing here is a difference between a local and a cloud member.
- The server's chats are trusted as they are: it is the User's own, in her
  own AWS account (or inside her app), and only the desktop that set it up
  changes who may use it. The server takes a chat's own fields (title,
  members and their permissions, the project) from any device on its roster.
  The app still has a member on a machine hand the member-list changes it
  asks for to the desktop, which makes them (see the open divergence about
  additions below).

## Exceptions

An exception is a deliberate, user-visible divergence from Requirement 1 or 2.

Rules:

1. **Only the User approves an exception.** Not an engineer, not a review, not an
   accord between participants.
2. **Approval is per-exception and explicit.** Approval of one divergence never
   extends to another.
3. **Every approved exception is recorded here**, with its scope, the reason it
   exists, and what the user sees instead.
4. **An unapproved divergence is a defect**, however reasonable its cause. It is
   fixed or brought to the User for approval; it is never left standing as an
   implicit design decision.
5. Keep an approved divergence as narrow as possible, make it visible to the
   user, and verify both the parity path and the divergence.

### Approved exceptions

| Exception | Requirement | Scope | Reason | What the user sees | Approved on |
| --- | --- | --- | --- | --- | --- |
| **A cloud participant delivers code changes through a GitHub pull request, not by writing into the user's working tree.** A local participant edits the project files directly; a cloud participant works in its own mirror, pushes a branch, and opens a PR. | 1 | Code changes only. Everything else a cloud participant does — messages, tools, artifacts, approvals — stays identical to a local participant. | This is how work with a remote human already goes. A PR is reviewable, revertable, and does not overwrite whatever the user is editing at that moment, which an automatic write-back into a live working tree would. | A branch and a pull request from the cloud participant, reviewed and merged the normal way. | 2026-08-19 |
| **Stop on a participant whose machine is unreachable is shown as waiting, not as done.** When the participant's machine is unreachable, Stop shows "stop requested, waiting for the machine"; the command is stored and delivered when connectivity returns; "stopped" appears only after the machine confirms the process is gone. A local participant never shows this state. | 1 | Stop only, and only while the participant's home machine cannot be reached (the User's server down, the machine offline or frozen). A reachable machine confirms within seconds and the user sees the same "stopped by user" a local participant shows. | The desktop cannot know that a process on an unreachable computer is gone; reporting "stopped" before the machine confirms would be a lie, and every device reaches the machine only through the User's server. | The pending bubble reads "Stop requested — waiting for machine <name>." while the stop is held; it becomes "@handle stopped by user." when the machine confirms. A Stop is the turn's stop on the User's server (`turn.stop`, from any device), so it survives a restart of the desktop and of the machine; the machine confirms by finishing the turn there as stopped. If the machine restarted meanwhile, the turn is closed as failed with "restarted before confirming the stop", never as stopped, because the restart proves nothing about the run's processes. Implemented in `ChatService` (the server's turns, `closeOrphanedServerTurn`) and `src/shared/machineWaitingText.ts`; first verified 2026-09-06 through the real desktop UI with a frozen machine process (`scripts/probes/machines/qa-machine-stop-unreachable.cjs`, written for the relay transport). | 2026-09-05 (Rule 2 of the signed accord "Cloud transport cutover — accord resolution", artifact a6f1e5ad v4, decided by the User in chat) |

### Known unapproved divergences (defects)

These are recorded so they are not mistaken for decisions. They await either a
fix or the User's approval as exceptions.

| Divergence | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| **A scheduled script on a machine can wake only members that run on that machine.** A script on the desktop can wake any member of its chats, wherever the member runs; a script on a cloud machine refuses, at proposal and at post time, to mention a member homed elsewhere ("@x does not run on the machine …; ask a member on the right host to set it up there"). A machine runtime older than the desktop also builds the woken member's prompt without the "untrusted script message" framing, and cannot host scripts until Settings → Machines → Upgrade runtime. | 2 | Slice 2 of the scheduled-scripts design (branch `taylor/scheduled-scripts`, 2026-10-18): `ScriptService` runs on the machine with `localMembersOnly`, because a machine starts only its own members and the desktop that would start the others may be closed. Verified end to end on 2026-10-18 with a local relay and machine runtime: a member on the machine proposed a script, the desktop card saved its key on the machine and showed the code from it, the script ran on the machine with the desktop closed, woke that member there, and both messages reached the desktop when it reopened. | Open — narrow and visible; awaits the User's approval as an exception or a design for waking other hosts' members. |
| **A scheduled script's keys are protected less on a cloud machine than on the desktop.** On the desktop the keys a User types into a script card are encrypted with the macOS Keychain (Electron `safeStorage`); on a cloud machine they are encrypted with a key file kept beside them, readable by the same OS user the machine's members run as, so a member there could read them. | 2 | `src/machine/main.ts` builds `ScriptSecretStore` with `platform.secrets` (file key, `src/main/platform.ts`), the same store the machine uses for its other secrets; raised by the slice-2 review on 2026-10-18. | Open — the machine has no keychain; a fix needs a separate OS user for scripts or members, or a hardware-backed store. |
| **With the desktop closed, the phone gets no notification for a cloud machine's work.** A local member's finished turn (or a card that needs an answer) rings the phone through the desktop's phone mailbox. A member or a scheduled script on a cloud machine finishing while the desktop is closed rings nothing: the machine holds no access to the phone's mailbox, and the phone does not subscribe to the machine's. The phone shows the result when opened. | 2 | Traced 2026-10-18: only `mobileTimelineSinkForPairing` / `postMailboxEvents` in `src/main/main.ts` send `runFinished` to the relay; `machineHost.ts` and `deviceEventMailbox.ts` never do, and the PWA service worker syncs only the desktop pairing mailbox. | Fixed by the User's server (phase 3, `taylor/server-only-phone`; the relay path is deleted in phase 5; since 2026-10-29 the server owns the chats): every device writes its members' replies to the server, which rings the phone for a finished reply or a card that needs an answer, whichever device wrote it, while the phone's app is not open. Verified 2026-10-26 in the phase 5 end-to-end run: desktop closed, the phone sent to a member on the machine and left the app, the machine replied and the server rang the phone 19 seconds later; with the app open it rang nothing. |
| **AWS setup can report ready while Claude is not signed in, and offers no browser sign-in for Claude.** The generic setup requires Codex authentication only; a Claude-specific setup emits instructions to run `claude auth login` manually on the worker instead of providing the login interaction. | 1 | Verified 2026-09-13 in this laptop's isolated cloud environment: native `claude auth status --json` returned `loggedIn: false`, `authMethod: none`, while Codex login status succeeded and the saved AWS setup result was `Worker ready (1 warning).` The path is `AwsWorkerSetupService` → `CloudRunDoctorService.requiredChecksForOptions` / `setup`. | Fixed and verified end to end on 2026-09-13: generic AWS setup and Diagnostics require enabled Codex/Claude providers; Claude uses native `claude auth login` with browser authorization and a scoped code input. In real Electron against the existing AWS instance, the User approved the new Claude authorization page; Copy code → the application form → Complete sign-in reached `Worker ready` with `Claude Code signed in` passing. A subsequent Diagnostics Check independently confirmed the saved sign-in without asking again. The isolated QA profile enabled only Claude, so its warning for unauthenticated, disabled Codex was expected. Earlier real checks cover cancellation, retry, wrong-request rejection and restoring the form after reopening Settings. Evidence: `docs/qa-cloud-provider-login.md`. |
| **Switching PWA chats can show the previous chat's messages under the new heading.** A render reads IndexedDB asynchronously and commits without checking whether navigation or a newer render replaced it. Old rows without a conversation also pass every chat's filter. | 1 | Reported 2026-09-11; reproduced in the built PWA with a delayed real IndexedDB read: heading `Chat B`, body `ONLY_CHAT_A`, while storage still separates A and B. The unscoped-row regression also fails on the unchanged source. | Fixed and deployed as PWA cache v68 on 2026-09-12: obsolete renders cannot commit, navigation clears old rows and stream controls before loading, and lookup/cleanup require the row's own conversation. Unscoped data is retained, never guessed or deleted. Browser and real-relay regressions pass; after deployment the User's physical-iPhone smoke check found no cross-chat messages. Automated iPhone evidence remains unavailable because iOS 27 cannot mount the available Xcode DDI and Safari control was denied. See `docs/qa-pwa-chat-isolation.md`. |
| **Cloud run selection is disabled when the local provider is not signed in.** The new-member row disables all runtime controls, including the machine selector, from local readiness. | 2 | Real Electron QA on 2026-09-11: an empty local Codex profile made Run on disabled despite the configured, running AWS instance; restoring the QA window's existing local profile re-enabled it. `chat-participant-roster-row.tsx` passes its local `disabledReason` into `ParticipantRuntimeControls`. | Open; pre-existing restriction observed during environment-isolation QA, not silently changed here. |
| **Machine setup's Do not check provider option still requires Codex login.** An omitted provider reaches the doctor's default required Codex/auth checks. | 2 | Real Settings installation after an interrupted sign-in on 2026-09-11 asked for Codex device authorization with Do not check selected; `requiredChecksForOptions` defaults to Codex. | Open; separate existing setup behavior, not a successful runtime-only verification path. |
| **Saving an environment variable does not immediately update an already connected machine.** The desktop restarts its warm agents after Save, but does not call the existing machine settings sync. | 1 | Real Electron/relay QA on 2026-09-11: the machine retained the old synthetic value after Save and received the new value when it reconnected. `settings:save-agent-environment-variable` and the delete handler in `src/main/main.ts` do not call `MachineLinkService.syncSettings`. | Fixed on `taylor/machine-chat-events` (2026-10-01): every settings write is followed, half a second later, by `MachineLinkService.syncSettings`, which sends only when what a machine uses changed; an offline machine gets it as a durable event. Verified in a real Electron instance against the local relay worker and a Linux machine installed over SSH: a saved value reached the connected machine two seconds after Save, and a value saved while the machine was stopped reached it right after it started. |
| **A member on a machine whose runtime predates the server owning the chats does not run until that machine is updated.** A local member never waits for this reason. | 1 | `taylor/machine-chat-events` (2026-10-01) refused such a turn on the desktop ("… still runs an older version of AccordAgents that cannot receive this chat …"). Since 2026-10-29 (`taylor/server-owns-chat`) a turn is asked on the User's server and taken by the member's machine from there; a runtime older than that does not read the server's chats, so the turn waits there, unrefused, until the machine runs the new runtime. | Open, transitional: it ends for each machine at its first update after this desktop version, which happens automatically when the machine is connected and idle. |
| **A member on a machine whose runtime predates machine compaction cannot be compacted until that machine is updated.** A local member is always compacted. | 1 | `taylor/machine-compact-quiet-hello` (2026-10-22): compaction of a machine member travels as the member's own turn command with a `compaction` field, which only a runtime announcing `compactionSupported` understands; an older one would read it as a turn for a message it does not have. `MachineLinkService.dispatchCommand` refuses it before anything is queued: "Could not compact @x context: @x is hosted on <machine>, which still runs an older version of AccordAgents that cannot compact members. This computer updates it the next time it is connected and idle; compact again after that." Verified 2026-10-22 against a real pre-change runtime (origin/beta build): refused, nothing queued, the member's next turn ran normally. | Open, transitional: ends for each machine at its first update after this desktop version. |
| **While a member's machine is unreachable, its compaction showed only "Compacting", with no "waiting for machine" and no "Stop requested — waiting for machine" text.** A turn shows both on its bubble; a compaction has no bubble. | 1 | Found 2026-10-22 on `taylor/machine-compact-quiet-hello`: the compaction is queued durably and runs when the machine is back, and a Stop is held and delivered then (Rule 2), but nothing said so. | Fixed 2026-10-22 as the User decided: the compaction's own status line reads "Compacting @x. Waiting for machine <name>" and "Compacting @x. Stop requested — waiting for machine <name>", the same words a turn's bubble shows, and returns to "Compacting @x." once the machine starts it. Verified in the isolated QA desktop with the machine runtime stopped. |
| **A payload the phone runs on carries a full conversation snapshot into a command-line argument.** `publishMobileRunnerPolicyForPairing` builds `mobileMailboxRunnerContextSnapshot` for every chat update and appends it as a chat event; chat-event writes reach SQLite through `queryJson`, which passes its SQL as an argv element. On a large chat the argument exceeds the operating system limit and the write fails, so the phone's runner policy is never published — and the failing work sits on the path that runs when the User sends a message. | 1 | Observed 2026-08-21: `spawn E2BIG` 1696 times between 08:40 and 12:00, zero on every previous day; introduced by `835d36a` (#17) and live from the 08:41 restart. Measured 4.0-4.6s between the User's send and the run starting. | Closed 2026-10-26 with the relay (phase 5, `taylor/server-only-all`): the phone's mailbox runner policy, its snapshot and the code that wrote it are deleted; the phone reads chats from the User's server and writes operations there. |
| **Stop destroys a cloud participant's session; locally it does not.** Stopping a local participant cancels the turn and the CLI session survives, so the next turn resumes with its context. Stopping a cloud participant leaves no resumable session on the worker: the next turn fails with a resume miss, the stored session id is cleared, and the participant restarts from nothing. | 1 | Observed 2026-08-19: a cloud member stopped after 16 minutes of work; the following turn returned `thread/resume failed: no rollout found`. Handling at `src/main/services/chat.ts:3020`. | Addressed on the machines transport (`feature/machines-transport`): a member on a machine is stopped by the same ChatService code a local member is, and its session survives. Verified 2026-09-06: Stop on a machine-hosted Claude member, then a new turn resumed the same session and replied. Closes when the cutover removes the worker path. |
| **A cloud participant has no artifact tools.** The desktop exposes 38 app tools, 17 of them `app_artifact_*`; the cloud worker relay exposes 7 and none of them touch artifacts, so a cloud member cannot read, create, revise or sign a document that a local member handles normally. | 1 | `grep -c app_artifact src/main/services/remoteRuns.ts` → 0. Declared by hand at `remoteRuns.ts:3371-3387`, `:4422-4496`, `:4504+`. | Closed in the source on `taylor/machine-installer` (2026-09-07): the worker path is deleted, and a member runs only on its home machine, which serves the same `AppMcpService` and tool wiring as the desktop — artifact tools included. Reopens only if a worker path returns. |
| **The mirror sync destroys a cloud participant's uncommitted work.** `syncUp` runs `rsync -az --delete --delete-excluded` into the worker's `repo/`, which forces it to be an exact copy of the user's local tree: any file the participant created that does not exist locally is deleted. A local participant's uncommitted work is never destroyed this way. | 1 | Observed 2026-08-20: a cloud member's new source file was gone from the worker after a sync at 06:46, twice. Git internals are protected by `REMOTE_MIRROR_UP_SYNC_PROTECT_FILTERS`, so committed work survives and only uncommitted work is lost. | Fixed 2026-08-20: whether the project is already on the worker is decided by the worker itself, not by a local state file, so an existing checkout is reused and never overwritten. Regression test: "a checkout already on the worker is never overwritten by an app instance that has no record of it" in `remoteRuns.test.ts`. |
| **The phone shows messages from a chat it is not looking at.** Live progress reaches the mobile relay control with no conversation on it (`ReviewProgress` has no `conversationId`), so the control falls back to the paired conversation for any run it does not already know — and then memoises that wrong mapping, so every later frame of that run is delivered as the paired chat's. The phone also files a batch that arrives with no conversation under whichever chat is currently open. Content from one chat is therefore shown, and stored, inside another. | 1 | Reported by the User 2026-08-20. Confirmed in the debug log: one mobile route (`route-5520c24f...`) carried frames for three different conversations. Fallback at `mobileRelayControl.ts:278` and `:648`, memoisation at `:282-283`, phone-side fallback to the open chat at `mobile-app.js:1900`. | Fixed 2026-08-21: the conversation is asked of the service that owns the runs (`ChatService.conversationIdForRun`) instead of guessed, an unidentified run is dropped rather than attributed, a route carries only the conversation it is paired to, and the phone no longer files an unlabelled batch under whichever chat is open. Regression test: "progress for a run in another chat is dropped, not delivered as this chat's" in `mobileRelayControl.test.ts`. |
| **The cloud worker keeps running when the app that owns it dies.** The idle-stop timer lives in the desktop process (`AwsWorkerLifecycle.scheduleIdleStop`, a `setTimeout` armed when the last run ends), so it only ever fires while the app is alive. If the machine the app runs on shuts down — a dead battery, a crash, a forced restart — the timer dies with it and the worker bills indefinitely. The one case the safeguard exists for is the one case it cannot cover. | 1 | Observed 2026-08-21: the User's laptop lost power overnight and the worker (`i-0943b28f7231ab93c`) was still running 23.5h after launch, ~8h of them with no desktop app at all. `awsWorkerLifecycle.ts:116` (`DEFAULT_IDLE_STOP_MS` = 3h), armed at `:237`. | Open |
| **Removing a device stops it commanding a machine, but not reading it.** A machine met every controller the owner trusts in its own room, sealed with one key that all of them held. Taking a device off the roster made the machine reject its commands and its acknowledgements immediately, and left it able to open traffic in that room and every retained event it already had. | 2 | `MachinePeerFabric.channelIdFor` met non-machine peers in `options.home.rendezvousId` and sealed with the room key; `machineTrustStore.accept` removed the peer's authority without changing it. Found 2026-09-07 on `taylor/machine-installer`. | Fixed 2026-09-07: each trusted device is given its own key for a machine's room when it is trusted, handed over by the same automatic path that already gives it access, and the machine seals each device's frames with that device's key. A revoked device never held the others', so nothing has to be rotated and no device that stayed has to do anything. Inbound still accepts the room key, because a device that has not yet picked up its own is one of the owner's and refusing it would lock out a working device rather than revoke a removed one — authority is decided by the roster and the signatures, not by which key opened the envelope. Regression: `scripts/machine-peer-sealing.test.mjs` (since phase 5 it covers the pair keys only; a removed device is also taken off the server's roster, which refuses its requests from then on). **Remaining limit, stated:** plaintext and copies a device already received cannot be taken back, and a revoked device can still read frames sealed to it before the revocation. |
| **A member removal on the phone differs from the desktop card in three small ways.** The phone asks in the desktop card's words ("Yes, remove @x" / "No, keep @x in this chat") and keeps an approved removal visible while it waits, titled as the desktop's ("Removal approved"), but its waiting line also names the Mac ("Waiting for running turns to finish and for your Mac to apply it, then @x leaves this chat.") because the phone cannot tell whether the Mac is on; once applied or declined the card leaves the phone, where the desktop keeps a "Member removed" / "Removal declined" card in the timeline; and the phone shows none of the chat's system messages ("Removed @x…", "User declined…"). | 1 | `controlCardFromApproval` in `src/shared/mobileControlCards.ts`, `buildCardIndex` / `storeControlCards` in `src/mobile/mobile-app.js`; checked in the real PWA against a hub on 2026-10-26 (`scripts/mobile-removal-card.test.mjs`). | Open; the outcome card and the system messages are an existing phone gap, not specific to removals. |
| **A member on a machine that adds a member does not have it in the chat at once.** A member on a machine hands the member-list changes it asks for to the desktop, which makes them, so an addition a machine member's policy allows is answered `approved_pending_apply` (a local member gets `auto_applied` with the added members) and takes effect when the desktop applies it: within seconds while the desktop is on, otherwise when it is back. Until then the new member cannot be mentioned or asked in that turn. An approved addition or removal waits the same way. | 2 | `queueMemberAdditionForDesktop` / `recordMemberAdditionForDesktop` (machine, `appliesRosterChanges()` is false there) and `applyQueuedMemberAdditions` / `applyQueuedMemberRemovals` (desktop) in `src/main/services/chat.ts`; found on `taylor/seam-removal` 2026-10-26. | Open. Since 2026-10-29 the User's server takes a chat's member list from any device on its roster (the desktop's special right there is removed with the old order, Д7); the app still routes these changes through the desktop. Whether a machine should make them itself is the User's decision. |
| **A role change a member on a machine asks for is applied only on that machine.** `app_roles_request_change` from a machine member writes the machine's own settings, which never reach the desktop (settings go from the desktop to machines). With an `allow` policy the role seems created, and a following addition that uses it fails when the desktop prepares it. Roster additions and removals from machine members are applied by the desktop (2026-10-26); role changes are not routed that way yet. | 1 | `requestRoleChangeFromTool` and the role branch of `respondToAppToolApproval` call `applyPreparedRoleChange` wherever the member runs. Found while fixing machine members' roster changes on `taylor/seam-removal`. | Open |
| **The mailbox runner exposes no app tools at all.** A participant run through the phone's mailbox path spawns its CLI with no MCP configuration, so it has none of the app surface a local participant has. | 1 | `src/main/services/mobileMailboxRunner.ts:589-596, 634-648`. | Closed 2026-10-26: the mailbox runner is deleted with the relay (phase 5). A member runs only on its home (the desktop or its machine), with the same App MCP tools as a local member. |

`docs/cloud-run-e2e-qa-scenarios.md` is the working catalogue of scenarios that
prove or disprove Requirement 1 in practice. This document states the rule; that
one tracks the evidence.

## Related

- `CLAUDE.md` — the non-negotiable invariant statement carried into every
  engineering session.
- `docs/cloud-runs-workspace-parity.md` — Requirement 1 applied specifically to
  project files and worktrees.
