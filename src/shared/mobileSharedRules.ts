// The rules the phone must apply exactly as the desktop does, bundled for the
// static PWA shell by scripts/build-mobile-shell.mjs (global
// `AccordMobileShared`). The phone runs no TypeScript of its own; before this
// bundle it re-implemented these rules by hand and drifted — avatars guessed
// from the handle, internal system messages shown as chat bubbles.
export {
  CHAT_ASSISTANT_AVATAR_ASSET_ID,
  chatAvatarAssetFileName,
  chatAvatarCatalogEntry,
  resolveChatAvatarByName,
  resolveChatParticipantAvatar
} from "./chatAvatarCatalog";
// The per-message half of the desktop's timeline rule. The other half — an
// inferred member-request carrier is hidden only while its trigger is in the
// conversation — needs the message list, which a machine's delta does not
// carry; the desktop applies the whole rule before it projects for the phone.
export { isChatMessageHiddenFromTimeline } from "./chatTimelineVisibility";
// What a member's message shows and what is control text: the `User choice:`
// block becomes a card, so the bubble must not print it as well. One rule for
// the desktop bubble and the phone's.
export { stripChatControlBlocks } from "./chatControlBlocks";
// Who a message is for, by the rules the desktop resolves a typed message
// with: the phone resolves its own message the same way, over what it showed
// the User, and the message carries the result to every member's home.
export { CHAT_DELIVERY_POLICY_OPTIONS, resolveChatDeliveryTargets } from "./chatDeliveryPolicy";
// `/goal` from the phone: the same parse and objective the desktop's composer
// makes, carried on the message.
export { nativeGoalObjective, parseNativeGoalCommand } from "./nativeGoalCommand";
// A new chat from the phone, made as the computer's New chat makes it: its
// members from what the computer prepared, its first system line and its
// title (the User, 2026-10-29).
// The sessions view's access, in each CLI's own terms: the same modes and
// words in the phone's New chat sheet as in the computer's picker.
export { applyChatAccessOptionById, chatAccessModeSet, chatAccessOptions, currentChatAccessId, defaultChatAccessOption, FULL_ACCESS_CONFIRMATION, selectedChatAccessOption, startChatAccessOption } from "./chatAccessModes";
export { newChatIntro, newChatMainSessionFor, newChatMemberFitsProject, newChatMetadata, newChatParticipants, newChatPickedMembers, newChatTitle } from "./newChat";
// The list row of a chat the phone started, as the server will list it.
export { mobileChatGroupLabel, mobileSnippet } from "./mobileChatRow";
// An artifact note becomes a card on the timeline: the same reading of the
// note's sentence and the same words on the desktop and the phone.
export { artifactNoteActorLabel, artifactNoteVerb, parseArtifactNoteCard } from "./artifactNoteCard";
// Each note's drafts and signatures as they stood, the same marks as the desktop's.
export { artifactNoteProgressById } from "./artifactNoteProgress";
// The message that starts an Accord becomes a card on the timeline: the same
// reading of the launch prompt on the desktop and the phone.
export { accordLaunchTitleAndBody, parseAccordLaunchCard } from "./accordLaunchCard";
// The pinned Accord card: the chat's newest Accord and its progress, and the
// notes of every Accord's document, which stay out of the chat; the same on
// the desktop and the phone.
// Her cross folds it into a line at the end of the chat, on every device;
// the line opens the same card (the User, 2026-11-16).
export {
  ACCORD_CLOSED_SOURCE, accordClosedLine, accordFoldedNoteKeys, accordLineOutcome, accordOfLaunch, accordProgressNoteHead, accordProgressStages,
  accordProgressStatus, dockedAccordFrom
} from "./accordProgress";
// An urgent alert's card: its status band, its folded line and whether it
// still waits for Got it, worded once for the desktop's card and the phone's.
export {
  HUB_ALERTS_PATH, urgentAlertAwaitsGotIt, urgentAlertCountdown, urgentAlertFailureText, urgentAlertOutcome, urgentAlertStatus
} from "./urgentAlerts";
// The main session and the chat's two views (docs/main-session.md): which
// view a chat opens in, where each message lives in the sessions view, the
// task cards, the members list and the "Waiting on" line, by the desktop's
// own rules.
export {
  MAIN_SESSION_ROLE_ID, buildSessionsViewIndex, canSwitchChatView, chatViewFor, isChatViewMode, isMainSessionTaskMessage, isSessionsHiddenTurnFinishedNote,
  mainSessionMemberOf, mainSessionParticipantId, mainTimelineMessages, memberSessionMessages, membersMainSessionWaitsOn, sessionsFormerMembers,
  sessionsTaskPlacement, sessionsViewLane, withoutLeadingMention
} from "./mainSession";
export {
  SESSIONS_REMOVED_MEMBER_DETAIL, SESSIONS_WORK_STATUS_LABELS, firstTextLine, isMainSessionDelegationRosterCard, isMemberWorking, latestTaskByMember, memberRunningSince,
  openMemberCardMessages, sessionsDelegationSummary, sessionsFormerMemberStatus, sessionsMemberActivity, sessionsMemberDetail, sessionsMemberRows,
  sessionsMemberStatus, sessionsMemberTitle, sessionsMembersWaitingForUser, sessionsRunningCount, sessionsTaskEntries, titleTaskByMember, sessionsTaskGroupLabel, sessionsTaskReplyLine, sessionsTaskRunningSince,
  sessionsTaskStatus, sessionsWaitingText
} from "./mainSessionView";
// A member's handle in a message, in code and outside it: which `@handle`
// is the member's chip and what stays as written, by the desktop's rule.
export { sessionsMentionPieces } from "./mainSessionView";
// Which message is an Accord launch card: the User's own launch, and the
// main session's (accordLaunchByMainSession), by the desktop's rule.
export { accordLaunchCardForMessage } from "./accordLaunchCard";
// Fork to new chat from the phone: the same reasons the computer refuses a
// member with, its rights as it runs now, and the new chat's main session
// and title as the computer makes them.
export {
  FORK_TO_NEW_CHAT_DETAIL, FORK_TO_NEW_CHAT_LABEL, forkToNewChatReasonFromOffer, forkedChatTitle, forkedMainSessionFor, memberAsItRunsNow
} from "./forkToNewChat";
// What the app wrote (cards, failures, statuses, Activity rows), as a
// sessions-view chat shows it: no handles, a member by its task, the main
// session by nothing; by the desktop's rule.
export { sessionsMentionText, sessionsViewLabel, sessionsViewNames, sessionsViewReplyText, sessionsViewSummaryText, sessionsViewText } from "./sessionsViewText";
