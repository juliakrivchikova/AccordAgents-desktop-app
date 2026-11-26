import type {
  SubagentProviderChange,
  SubagentProviderScope,
  ChatAppToolApprovalRequest,
  ChatClaudePlanDecision,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatParticipant,
  ChatParticipantConfig,
  ChatProviderKind,
  ChatSkillMention,
  Conversation,
  RepoFileMention
} from "../../shared/types";
import {
  chatAppToolApprovals,
  chatParticipants
} from "../components/chat/chat-conversation-data";
import { chatParticipantMentionHandle } from "../components/conversation/conversation-display";
import { applyConversationUpdate, messagePageAfterUpdate } from "../../shared/conversationUpdates";
import type { ChatParticipantDraft } from "../components/chat/chat-participant-drafts";
import {
  activeChatRoleConfigs,
  chatParticipantConfigToDraft,
  defaultChatParticipantDraft,
  normalizedChatDrafts,
  selectedOrMentionedChatParticipantDrafts,
  validateChatCliAgents,
  validateChatParticipantDrafts,
  validateChatStartupDrafts
} from "../components/chat/chat-participant-drafts";
import { NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID, newChatDesktopStartFor, newChatMainSessionParticipantDraft, newChatMainSessionPlace } from "../components/chat/chat-main-session-draft";
import { cliStartDefaultsFor, startAccessKey } from "../components/chat/use-cli-start-defaults";
import { newChatViewFor } from "../../shared/mainSession";
import { sessionsViewNamesOf, sessionsViewText } from "../../shared/sessionsViewText";
import {
  type MainSessionProviderChoice,
  type MainSessionProviderOption,
  mainSessionProviderKey,
  mainSessionProviderOptions,
  resolveMainSessionProvider
} from "../../shared/mainSessionProviders";
import {
  errorText,
  mergeProgressIntoConversation
} from "../components/review/review-conversation-data";
import type { AppState } from "./app-state";
import type { ConversationActions } from "./use-conversation-actions";
import { conversationTimeValue, upsertConversationSummary, withPinnedState } from "./conversation-summaries";
import { newChatTitle } from "../../shared/newChat";
import { persistLastViewedAt } from "./storage";
import { requestComposerFocus, takeComposerFocusRequest } from "./composer-focus-request";
import { laterLoadingNotice } from "./later-loading-notice";
import { toast } from "sonner";
import { cleanIpcError } from "../lib/ipc-error";
import { serializeComposerDraft } from "../components/chat/chat-composer-draft-utils";
import { revokePendingImageUrls } from "../components/chat/use-chat-composer-images";
import {
  cliProviderMetadata,
  isAgentSnapshotStale,
  NO_READY_CLI_MESSAGE,
  resolveAssistantProviderKind
} from "../../shared/cliReadiness";

export interface ForkToNewChatOptions {
  /** Opens a chat as the sidebar does, from the notice of a fork made after
   *  she went to another chat or screen. */
  openChat?: (conversationId: string) => void;
}

export interface ChatActions {
  startChat: (options?: StartChatOptions) => Promise<boolean>;
  renameChatConversation: (title: string) => Promise<boolean>;
  setChatArchived: (conversationId: string, archived: boolean) => Promise<void>;
  setChatPinned: (conversationId: string, pinned: boolean) => Promise<void>;
  deleteChatConversation: (conversationId: string) => Promise<void>;
  sendChatMessage: (options?: SendChatMessageOptions) => Promise<boolean>;
  respondToChatMentions: (sourceMessageId: string, targetParticipantIds: string[], approve: boolean, continueRequester?: boolean) => Promise<void>;
  toggleChatReaction: (messageId: string, emoji: string) => Promise<void>;
  dismissTurnFinishedNote: (messageId: string) => Promise<void>;
  respondToChatChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => Promise<void>;
  addChatParticipant: () => Promise<void>;
  addSavedChatParticipant: (config: ChatParticipantConfig) => Promise<void>;
  updateChatParticipantRuntime: (participantId: string, patch: ChatParticipantRuntimePatch) => Promise<boolean>;
  /** A change to the open chat's sub-agents (side panel), for it or its project. */
  updateChatSubagentProviders: (scope: SubagentProviderScope, change: SubagentProviderChange) => Promise<boolean>;
  removeChatParticipant: (participantId: string) => Promise<void>;
  compactChatParticipant: (participantId: string, options?: ChatRunScopeOptions) => Promise<boolean>;
  restartChatParticipant: (participantId: string, stopBackgroundTasks?: boolean) => Promise<boolean>;
  /** Fork to new chat: a new chat whose main session is a copy of this member. */
  forkChatParticipantToNewChat: (participantId: string, options?: ForkToNewChatOptions) => Promise<boolean>;
  startChatAccord: (options: StartChatAccordOptions) => Promise<boolean>;
  respondToChatAppToolApproval: (
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest,
    codexDecisionId?: string,
    planDecision?: ChatClaudePlanDecision
  ) => Promise<void>;
}

export interface SendChatMessageOptions extends ChatRunScopeOptions {
  content?: string;
  skillMentions?: ChatSkillMention[];
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageInput[];
  /** Exactly these members (a member's session panel, or the sessions
   *  view's main composer to the main session). */
  targetParticipantIds?: string[];
  /** Sent from the main composer: its draft is this message's. */
  fromMainComposer?: boolean;
}

export interface StartChatOptions {
  skillMentions?: ChatSkillMention[];
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageInput[];
}

export interface ChatRunScopeOptions {
  threadId?: string;
  parentMessageId?: string;
  chatThreadRootId?: string;
}

export interface StartChatAccordOptions {
  facilitatorParticipantId: string;
  targetParticipantIds: string[];
  /** Agents-list CLIs with no member yet, made members as the Accord starts. */
  targetProviderKinds?: ChatProviderKind[];
  subject: string;
}

type ChatChoiceResponse = { cancel?: boolean; selectedOptionId?: string; customAnswer?: string; note?: string };

/** A member's settings to save: the keys present are saved, the others
 *  stay as they are. */
export type ChatParticipantRuntimePatch = Partial<Pick<ChatParticipant,
  "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution" | "cloudRun" | "homeMachineId" | "skipToolchainPreflight" | "autoWatch">>;

const RUNTIME_PATCH_KEYS = ["model", "reasoningEffort", "agentMode", "permissions", "remoteExecution", "cloudRun", "homeMachineId", "skipToolchainPreflight", "autoWatch"] as const;

/** The patch's own keys, values as given (undefined included). */
export function runtimePatchFields(patch: ChatParticipantRuntimePatch): ChatParticipantRuntimePatch {
  const fields: Record<string, unknown> = {};
  for (const key of RUNTIME_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) fields[key] = patch[key];
  }
  return fields as ChatParticipantRuntimePatch;
}

/**
 * Why a sessions-view New chat refuses a send whose main session would not
 * run where the screen said: the provider chosen on the chip is no longer
 * ready, or the one shown (Settings → General's) gave way to another while
 * the readiness was checked again. Undefined when it runs where shown.
 */
export function newChatProviderChangedRefusal(
  chosen: MainSessionProviderChoice | undefined,
  shown: MainSessionProviderOption | undefined,
  resolved: MainSessionProviderOption,
  options: readonly MainSessionProviderOption[]
): string | undefined {
  if (chosen && !options.some((option) => mainSessionProviderKey(option) === mainSessionProviderKey(chosen))) {
    const name = (shown && mainSessionProviderKey(shown) === mainSessionProviderKey(chosen) ? shown.label : "") || chatProviderName(chosen.kind);
    return `${name} is not ready any more. The chat would start on ${resolved.label || chatProviderName(resolved.kind)}: check the model chip and send again.`;
  }
  if (shown && mainSessionProviderKey(shown) !== mainSessionProviderKey(resolved)) {
    return `${shown.label || chatProviderName(shown.kind)} is not ready any more. The chat would start on ${resolved.label || chatProviderName(resolved.kind)}: check the model chip and send again.`;
  }
  return undefined;
}

function chatProviderName(kind: ChatProviderKind): string {
  return cliProviderMetadata(kind).label;
}

export function useChatActions(state: AppState, conversationActions: ConversationActions): ChatActions {
  async function startChat(options: StartChatOptions = {}): Promise<boolean> {
    state.setError(undefined);
    state.setWarnings([]);
    const draftMessage = state.question.trim();
    const initialMessage = serializeComposerDraft(draftMessage).trim();
    const imageAttachments = options.imageAttachments ?? [];
    const repoFileMentions = options.repoFileMentions ?? [];
    const skillMentions = options.skillMentions ?? [];
    if (!initialMessage && imageAttachments.length === 0 && skillMentions.length === 0) {
      state.setError("Enter a message or attach an image to start a chat.");
      return false;
    }
    if (state.startingChatRef.current) {
      return false;
    }
    // The send shows from the press on: the CLI check below can take seconds,
    // and a press that changes nothing on screen reads as a send that did not
    // happen. New chat stays on screen with its send button busy until the
    // chat is being made (the run id below), so its choices survive a Stop or
    // a failed check; Stop works from here on too.
    state.startingChatRef.current = true;
    const runId = crypto.randomUUID();
    const creation = new AbortController();
    state.chatCreationRef.current = creation;
    state.setBusy(true);
    let createdConversationId: string | undefined;
    // A chat opened from the sidebar or search while this one was being
    // created is the User's later choice: once it is on screen, the new chat
    // does not take its place. An empty screen (still on New chat) shows the
    // new chat. A chat still opening counts as on screen: the new one does not
    // flash in before it.
    const openRequestAtStart = state.openConversationRequestRef.current;
    const showCreated = (created: Conversation): void => {
      state.setConversation((current) => {
        if (state.openConversationRequestRef.current === openRequestAtStart) return created;
        if (current && current.id !== created.id) return current;
        const opening = state.openConversationTargetRef.current;
        return opening && opening !== created.id ? current : created;
      });
    };
    try {
      // The main session runs on what the New chat chip chose for this chat
      // (else Settings → General → New chats' CLI), and the chat is made with
      // it alone (every new chat opens in the sessions view).
      const sessionsView = newChatViewFor() === "sessions";
      const resolveProvider = (agents: typeof state.agents): MainSessionProviderOption | undefined => {
        const kind = resolveAssistantProviderKind({
          agents,
          providers: state.settings.providers,
          explicitKind: state.settings.assistantProviderKind
        });
        if (!sessionsView) return kind ? { kind, label: "" } : undefined;
        const options = mainSessionProviderOptions(agents, state.settings.providers, state.settings.cliProviderHosts);
        return resolveMainSessionProvider(state.newChatMainSessionProvider, options, kind);
      };
      // The main session's provider the screen showed: settings made for it
      // there do not carry over to another one.
      const shownProvider = resolveProvider(state.agents);
      let agents = state.agents;
      if (isAgentSnapshotStale(agents)) {
        try {
          agents = await conversationActions.refreshAgents({ trigger: "submit" });
        } catch {
          creation.signal.throwIfAborted();
          state.setError("Could not verify CLI readiness. Check again and retry.");
          return false;
        }
      }
      const mainProvider = resolveProvider(agents);
      if (!mainProvider) {
        // The saved CLI gives way to any ready one: none is ready.
        state.setError(NO_READY_CLI_MESSAGE);
        return false;
      }
      // The provider the chip showed (or chose) stopped being ready before the
      // send: the chat is not silently made on another one; the screen now
      // shows the one it would take, and the next send takes it.
      const refusal = sessionsView
        ? newChatProviderChangedRefusal(state.newChatMainSessionProvider, shownProvider, mainProvider, mainSessionProviderOptions(agents, state.settings.providers, state.settings.cliProviderHosts))
        : undefined;
      if (refusal) {
        state.setError(refusal);
        if (state.newChatMainSessionProvider) state.setNewChatMainSessionProvider?.(undefined);
        return false;
      }
      const overrideMadeFor = state.newChatMainSessionOverrideFor;
      const mainSessionRuntimeOverride = shownProvider && mainSessionProviderKey(mainProvider) === mainSessionProviderKey(shownProvider) &&
        !(overrideMadeFor && overrideMadeFor !== mainSessionProviderKey(mainProvider))
        ? state.selectedChatParticipantRuntimeOverrides[NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID]
        : undefined;
      // Every new chat has its main session first, instead of the Chat
      // Assistant (docs/main-session.md). In the sessions view nobody else:
      // the main session makes members itself, and an @handle in the first
      // message picks none.
      // The mode the User's own config starts its CLI in where it will run
      // (this computer, or the machine chosen for it on New chat): the one the
      // screen showed for this provider and place, else read now.
      // How Settings → General → New chats starts it on this provider (a
      // machine no longer set up: this computer), under what was chosen on
      // the screen.
      // The machines read now, as the screen reads them (none known: this computer).
      const machines = sessionsView
        ? await Promise.resolve(window.consensus.listMachines?.()).then((list) => list, () => undefined)
        : undefined;
      creation.signal.throwIfAborted();
      const newChatStart = sessionsView
        ? newChatDesktopStartFor(state.settings.newChatDefaults, mainProvider, { machines: machines?.machines ?? [], status: machines?.status ?? [] })
        : undefined;
      const place = { kind: mainProvider.kind, ...newChatMainSessionPlace(mainSessionRuntimeOverride, newChatStart) };
      const shownStart = state.newChatMainSessionStartAccess;
      const startAccess = !sessionsView
        ? undefined
        : shownStart && shownStart.key === startAccessKey(mainSessionProviderKey(mainProvider), place)
          ? shownStart.access
          : (await cliStartDefaultsFor(place))?.access;
      const participants = [
        newChatMainSessionParticipantDraft(mainProvider.kind, mainSessionRuntimeOverride, Boolean(state.repoPath.trim()), mainProvider.hostId, sessionsView, startAccess, newChatStart),
        ...(sessionsView ? [] : selectedOrMentionedChatParticipantDrafts(
          state.settings.chatParticipantConfigs,
          state.selectedChatParticipantConfigIds,
          initialMessage,
          state.selectedChatParticipantRuntimeOverrides
        ))
      ];
      const validation = validateChatStartupDrafts(
        participants,
        state.settings.chatRoleConfigs,
        agents,
        state.settings.chatBehaviorRules,
        state.settings.providers,
        state.settings.cliProviderHosts
      );
      if (validation) {
        state.setError(validation);
        return false;
      }
      // Stopped while the CLIs were being checked: no chat is made.
      creation.signal.throwIfAborted();
      state.setCurrentRunId(runId);
      const result = await window.consensus.createChatConversation({
        runId,
        title: initialChatTitle(initialMessage, imageAttachments),
        repoPath: state.repoPath.trim() || undefined,
        skipDefaultParticipants: participants.length === 0,
        participants
      });
      createdConversationId = result.conversation.id;
      markOwnChatSeen(result.conversation);
      creation.signal.throwIfAborted();
      state.chatCreationRef.current = undefined;
      showCreated(result.conversation);
      state.setWarnings(result.warnings);
      const sendResult = await window.consensus.sendChatMessage({
        conversationId: result.conversation.id,
        runId,
        content: initialMessage,
        repoFileMentions,
        skillMentions,
        imageAttachments
      });
      markOwnChatSeen(sendResult.conversation);
      showCreated(mergeProgressIntoConversation(sendResult.conversation, state.progressLogRef.current.filter((item) => item.runId === runId)));
      state.setWarnings([...result.warnings, ...sendResult.warnings]);
      await refreshPersistedProviderPreference();
      state.setQuestion("");
      state.setNewChatPendingImages((current) => {
        revokePendingImageUrls(current);
        return [];
      });
      state.setNewChatRepoFileMentions([]);
      state.setNewChatSkillMentions([]);
      state.setNewChatPluginMentions([]);
      state.setSelectedChatParticipantRuntimeOverrides({});
      // The chip's provider was for that chat only.
      state.setNewChatMainSessionProvider?.(undefined);
      await conversationActions.refreshConversations().catch(() => undefined);
      return true;
    } catch (caught) {
      const message = errorText(caught);
      if (createdConversationId) {
        const conversationId = createdConversationId;
        // A failed send can already have persisted. Check under the service's
        // mutation lock so a concurrent message is never archived as empty.
        const saved = await window.consensus.setChatArchived({
          conversationId, archived: true, onlyIfEmpty: true
        }).catch(() => window.consensus.getConversation(conversationId).catch(() => undefined));
        if (saved?.metadata.archived === true) {
          state.setConversation((current) => current?.id === conversationId ? undefined : current);
          state.setQuestion(draftMessage);
        } else if (saved) {
          showCreated(saved);
        }
        await conversationActions.refreshConversations().catch(() => undefined);
      }
      if (message.toLowerCase().includes("cancel")) {
        state.setWarnings((current) => [...current, creation.signal.aborted ? "Chat creation cancelled." : "Chat turn cancelled."]);
      } else {
        state.setError(message);
      }
      return false;
    } finally {
      state.chatCreationRef.current = undefined;
      state.setBusy(false);
      state.setCurrentRunId(undefined);
      state.startingChatRef.current = false;
    }
  }

  async function renameChatConversation(title: string): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    const conversationId = state.conversation.id;
    state.setError(undefined);
    try {
      const saved = await window.consensus.renameChatConversation({ conversationId, title });
      if (!saved) {
        state.setError("Chat was not found.");
        return false;
      }
      state.setConversation((current) => (current?.id === conversationId ? saved : current));
      state.setSummaries((current) => upsertConversationSummary(current, saved));
      return true;
    } catch (caught) {
      state.setError(errorText(caught));
      return false;
    }
  }

  async function setChatArchived(conversationId: string, archived: boolean): Promise<void> {
    state.setError(undefined);
    try {
      const saved = await window.consensus.setChatArchived({ conversationId, archived });
      if (!saved) {
        state.setError("Chat was not found.");
        return;
      }
      state.setConversation((current) => (current?.id === conversationId ? saved : current));
      state.setSummaries((current) => upsertConversationSummary(current, saved));
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  /** Pins or unpins a chat. The list shows it at once; only the chat's pin
   *  state is taken from the answer, never its messages (an open chat keeps
   *  what it shows, its runs included). A failure puts the row back. */
  async function setChatPinned(conversationId: string, pinned: boolean): Promise<void> {
    state.setError(undefined);
    const previous = state.summaries.find((summary) => summary.id === conversationId);
    const at = new Date().toISOString();
    state.setSummaries((current) => current.map((summary) => summary.id === conversationId ? withPinnedState(summary, pinned, at) : summary));
    try {
      const saved = await window.consensus.setChatPinned({ conversationId, pinned });
      if (!saved) {
        throw new Error("Chat was not found.");
      }
      const savedPinned = saved.pinned;
      const savedAt = saved.pinnedAt ?? at;
      state.setSummaries((current) => current.map((summary) => summary.id === conversationId ? withPinnedState(summary, savedPinned, savedAt) : summary));
      state.setConversation((current) => {
        if (current?.id !== conversationId) return current;
        const metadata = { ...current.metadata };
        if (savedPinned) {
          metadata.pinned = true;
          metadata.pinnedAt = savedAt;
        } else {
          delete metadata.pinned;
          delete metadata.pinnedAt;
        }
        return { ...current, metadata };
      });
    } catch (caught) {
      if (previous) {
        const wasPinned = previous.pinned === true;
        const wasAt = previous.pinnedAt ?? at;
        state.setSummaries((current) => current.map((summary) => summary.id === conversationId ? withPinnedState(summary, wasPinned, wasAt) : summary));
      }
      state.setError(errorText(caught));
    }
  }

  async function deleteChatConversation(conversationId: string): Promise<void> {
    state.setError(undefined);
    try {
      const deleted = await window.consensus.deleteChatConversation({ conversationId });
      if (!deleted) {
        throw new Error("Chat was not found.");
      }
      const wasActive = state.conversation?.id === conversationId;
      state.clearChatMessageDraft(conversationId);
      state.setUnreadConversationIds((current) => {
        const next = new Set(current);
        next.delete(conversationId);
        return next;
      });
      // Keep a revision tombstone until outstanding list reads finish, so an
      // older refresh cannot put the deleted chat back into the sidebar.
      state.activityRevisionByConversationRef.current = {
        ...state.activityRevisionByConversationRef.current,
        [conversationId]: (state.activityRevisionByConversationRef.current[conversationId] ?? 0) + 1
      };
      const { [conversationId]: _removedLastViewed, ...remainingLastViewed } = state.lastViewedAtRef.current;
      state.lastViewedAtRef.current = remainingLastViewed;
      persistLastViewedAt(remainingLastViewed);
      state.setSummaries((current) => current.filter((summary) => summary.id !== conversationId));
      if (wasActive) {
        await conversationActions.newChatSession();
      }
    } catch (caught) {
      state.setError(errorText(caught));
      throw caught;
    }
  }

  async function sendChatMessage(options: SendChatMessageOptions = {}): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    // The draft belongs to the chat it was typed in; by the time the send
    // settles the User may have opened another chat.
    const conversationId = state.conversation.id;
    const draftBeforeSend = state.chatMessageDraft;
    const content = (options.content ?? state.chatMessageDraft).trim();
    const imageAttachments = options.imageAttachments ?? [];
    const skillMentions = options.skillMentions ?? [];
    if (!content && imageAttachments.length === 0 && skillMentions.length === 0) {
      state.setError("Enter a chat message or attach an image.");
      return false;
    }
    const targetParticipantIds = options.targetParticipantIds?.length ? options.targetParticipantIds : undefined;
    // A thread or a member's panel keeps its own draft; the sessions view's
    // main composer writes to the main session from the main draft.
    const ownsMainDraft = !options.chatThreadRootId && (!targetParticipantIds || options.fromMainComposer === true);
    if (skillMentions.length > 0 && !targetParticipantIds && hasMultipleMentionedParticipants(content, state.conversation)) {
      state.setError("A selected skill runs on a single member. Mention exactly one member, or remove the skill. Other members can be brought in by the running skill itself.");
      return false;
    }
    const runId = crypto.randomUUID();
    state.setError(undefined);
    state.setWarnings([]);
    if (ownsMainDraft) {
      state.setChatMessageDraftForConversation(conversationId, "");
    }
    try {
      const result = await window.consensus.sendChatMessage({
        conversationId,
        runId,
        content,
        skillMentions,
        repoFileMentions: options.repoFileMentions,
        imageAttachments,
        threadId: options.threadId,
        parentMessageId: options.parentMessageId,
        chatThreadRootId: options.chatThreadRootId,
        ...(targetParticipantIds ? { targetParticipantIds } : {})
      });
      state.setConversation((current) => {
        if (!current || current.id !== result.conversation.id) {
          return current;
        }
        // The reply carries the whole history; keep the window the user had
        // loaded instead of turning it into every message of the chat.
        const applied = applyConversationUpdate(current, result.conversation);
        state.setMessagePage((previous) => messagePageAfterUpdate(previous, applied));
        return mergeProgressIntoConversation(applied.conversation, state.progressLogRef.current.filter((item) => item.runId === runId));
      });
      if (result.warnings.length > 0) {
        state.setWarnings(result.warnings);
      }
      await refreshPersistedProviderPreference();
      return true;
    } catch (caught) {
      if (ownsMainDraft) {
        state.setChatMessageDraftForConversation(conversationId, (current) => current || draftBeforeSend);
      }
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        state.setWarnings((current) => [...current, "Chat turn cancelled."]);
      } else {
        state.setError(message);
      }
      return false;
    }
  }

  async function respondToChatMentions(sourceMessageId: string, targetParticipantIds: string[], approve: boolean, continueRequester = false): Promise<void> {
    await runBusyChatAction("Mention approval run cancelled.", async (runId) => {
      const openRequest = state.openConversationRequestRef.current;
      const result = await window.consensus.respondToChatMentions({
        conversationId: state.conversation!.id,
        sourceMessageId,
        targetParticipantIds,
        approve,
        continueRequester,
        runId
      });
      updateIfStillOpen(result.conversation, runId);
      if (state.openConversationRequestRef.current === openRequest) state.setWarnings(result.warnings);
      await conversationActions.refreshConversations();
    });
  }

  async function toggleChatReaction(messageId: string, emoji: string): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    state.setError(undefined);
    try {
      const saved = await window.consensus.toggleChatReaction({ conversationId: state.conversation.id, messageId, emoji });
      if (saved) {
        updateIfStillOpen(saved);
        state.setSummaries((current) => upsertConversationSummary(current, saved));
      }
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  // The note goes from the chat on every device: the main process removes it
  // and the chat's next update shows it gone.
  async function dismissTurnFinishedNote(messageId: string): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    state.setError(undefined);
    try {
      await window.consensus.dismissTurnFinishedNote({ conversationId: state.conversation.id, messageId });
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function respondToChatChoice(sourceMessageId: string, choiceId: string, response: ChatChoiceResponse): Promise<void> {
    await runBusyChatAction("Choice response cancelled.", async (runId) => {
      const openRequest = state.openConversationRequestRef.current;
      const result = await window.consensus.respondToChatChoice({
        conversationId: state.conversation!.id,
        sourceMessageId,
        choiceId,
        ...response,
        runId
      });
      updateIfStillOpen(result.conversation, runId);
      if (state.openConversationRequestRef.current === openRequest) state.setWarnings(result.warnings);
      await conversationActions.refreshConversations();
    });
  }

  async function addChatParticipant(): Promise<void> {
    const draft = state.chatAddParticipantDraft ?? defaultChatParticipantDraft(state.settings);
    const participant = normalizedChatDrafts([draft])[0];
    const saved = await commitChatParticipant(participant);
    if (saved) {
      state.setChatAddParticipantDraft(defaultChatParticipantDraft(state.settings));
    }
  }

  async function addSavedChatParticipant(config: ChatParticipantConfig): Promise<void> {
    const participant = normalizedChatDrafts([chatParticipantConfigToDraft(config)])[0];
    await commitChatParticipant(participant);
  }

  async function updateChatParticipantRuntime(participantId: string, patch: ChatParticipantRuntimePatch): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    state.setError(undefined);
    try {
      // Only what the patch names is sent (a key with no value is a reset):
      // a setting changed meanwhile by another click is never sent back as
      // it stood when this one was made.
      const saved = await window.consensus.updateChatParticipantRuntime({
        conversationId: state.conversation.id,
        participantId,
        ...runtimePatchFields(patch)
      });
      if (saved) updateIfStillOpen(saved);
      await conversationActions.refreshConversations();
      return true;
    } catch (caught) {
      state.setError(errorText(caught));
      return false;
    }
  }

  async function updateChatSubagentProviders(scope: SubagentProviderScope, change: SubagentProviderChange): Promise<boolean> {
    const conversation = state.conversation;
    if (!conversation || conversation.kind !== "chat") return false;
    state.setError(undefined);
    try {
      const result = await window.consensus.updateChatSubagentProviders({ conversationId: conversation.id, scope, change });
      // Only the chat's own layer and the projects' lists: its messages and runs
      // here, and every other setting, stay as they are.
      state.setConversation((current) => current?.id === result.conversationId
        ? { ...current, metadata: { ...current.metadata, subagentProviders: result.subagentProviders } }
        : current);
      if (result.subagentProvidersByProject) {
        const byProject = result.subagentProvidersByProject;
        state.setSettings((current) => ({ ...current, subagentProvidersByProject: byProject }));
      }
      return true;
    } catch (caught) {
      state.setError(errorText(caught));
      return false;
    }
  }

  async function removeChatParticipant(participantId: string): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    state.setError(undefined);
    try {
      const saved = await window.consensus.removeChatParticipant({ conversationId: state.conversation.id, participantId });
      if (saved) updateIfStillOpen(saved);
      await conversationActions.refreshConversations();
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function compactChatParticipant(participantId: string, options: ChatRunScopeOptions = {}): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    const runId = crypto.randomUUID();
    state.setError(undefined);
    state.setWarnings([]);
    try {
      const result = await window.consensus.compactChatParticipant({
        conversationId: state.conversation.id,
        participantId,
        runId,
        threadId: options.threadId,
        parentMessageId: options.parentMessageId,
        chatThreadRootId: options.chatThreadRootId
      });
      state.setConversation((current) =>
        current?.id === result.conversation.id
          ? mergeProgressIntoConversation(result.conversation, state.progressLogRef.current.filter((item) => item.runId === runId))
          : current
      );
      state.setWarnings(result.warnings);
      await conversationActions.refreshConversations();
      return true;
    } catch (caught) {
      state.setError(errorText(caught));
      return false;
    }
  }

  /** Restarts a member's CLI process. The line its restart wrote arrives as
   *  a chat update; an error stays in the chat's error banner. */
  async function restartChatParticipant(participantId: string, stopBackgroundTasks = false): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    const conversationId = state.conversation.id;
    state.setError(undefined);
    try {
      await window.consensus.restartChatParticipant({ conversationId, participantId, runId: crypto.randomUUID(), stopBackgroundTasks });
      return true;
    } catch (caught) {
      state.setError(cleanIpcError(caught));
      return false;
    }
  }

  /**
   * Fork to new chat (src/shared/forkToNewChat.ts): makes a new chat whose
   * main session is a copy of this member of the open chat, opens it, and
   * hands its empty composer the keyboard; the first message sent there
   * makes the fork. Made through the same path as every new chat. Making it
   * can take a moment: when she has gone to another chat or screen by then,
   * that stays on screen with the keyboard; the new chat is listed and a
   * notice says it is ready, with a way to open it.
   */
  async function forkChatParticipantToNewChat(participantId: string, options: ForkToNewChatOptions = {}): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    const conversationId = state.conversation.id;
    if (state.startingChatRef.current) return false;
    state.startingChatRef.current = true;
    state.setError(undefined);
    // Still on the chat she forked from, on the same screen: no other chat
    // opened since (from the sidebar, search or a notice), not New chat or
    // Settings. A click on the open chat counts as an open request too, so the
    // latest request is told by what it was for, never by the count alone.
    const railViewAtClick = state.railViewRef.current;
    const openRequestAtClick = state.openConversationRequestRef.current;
    // A refusal said by a notice once she has gone elsewhere is worded by the
    // chat she forked from (its sessions view names nobody by handle).
    const source = state.conversation?.id === conversationId ? state.conversation : undefined;
    const stillHere = (): boolean =>
      state.railViewRef.current === railViewAtClick &&
      (state.openConversationRequestRef.current === openRequestAtClick || state.openConversationTargetRef.current === conversationId);
    // Checking its CLI can take a moment: said at once, gone once it is made.
    const notice = laterLoadingNotice("Forking to a new chat…");
    let created: Conversation;
    try {
      const result = await window.consensus.createChatConversation({
        runId: crypto.randomUUID(),
        participants: [],
        skipDefaultParticipants: true,
        forkOf: { conversationId, participantId }
      });
      created = result.conversation;
    } catch (caught) {
      // Said where she is: in the chat she forked from, or by a notice once
      // she has gone elsewhere (an error banner there would be about a chat
      // she is not looking at).
      if (stillHere()) state.setError(cleanIpcError(caught));
      else toast.error(sessionsViewText(cleanIpcError(caught), source ? sessionsViewNamesOf(source) : undefined));
      return false;
    } finally {
      notice.end();
      // Made or refused: a new chat she starts meanwhile (she may have gone
      // to New chat) is not held up while this one opens or is listed.
      state.startingChatRef.current = false;
    }
    state.setSummaries((current) => upsertConversationSummary(current, created));
    markOwnChatSeen(created);
    if (stillHere()) {
      requestComposerFocus(created.id);
      state.setRailView("chats");
      const openRequest = state.openConversationRequestRef.current + 1;
      await conversationActions.openConversation(created.id);
      // She opened another chat meanwhile: the request must not take the
      // keyboard whenever she opens this one later.
      if (state.openConversationRequestRef.current !== openRequest) takeComposerFocusRequest(created.id);
    } else {
      const openChat = options.openChat;
      toast.success(`Forked to a new chat: ${created.title}`, openChat ? {
        action: {
          label: "Open",
          onClick: () => {
            // A notice hands the keyboard back to what had it before, when
            // focus leaves it or the last notice goes (sonner): let it do so
            // now, so it does not take the keyboard from the fork's composer.
            const focused = document.activeElement;
            if (focused instanceof HTMLElement && focused.closest("[data-sonner-toaster]")) focused.blur();
            openChat(created.id);
            // Asked once its open began (an open drops a request for any
            // other chat): taken when its composer appears, or at once when
            // the chat is already on screen.
            requestComposerFocus(created.id);
          }
        }
      } : undefined);
    }
    await conversationActions.refreshConversations().catch(() => undefined);
    return true;
  }

  /** A chat she made herself (New chat, a fork) is no news to her, wherever
   *  she is by the time it is made: what it holds then counts as seen, so
   *  the list shows no unread dot for it (the app announces the chat while
   *  it is made, before it is on screen). What comes after (a member's
   *  reply) still is news. */
  function markOwnChatSeen(conversation: Conversation): void {
    const seen = state.lastViewedAtRef.current[conversation.id];
    if (!seen || conversationTimeValue(conversation.updatedAt) > conversationTimeValue(seen)) {
      state.lastViewedAtRef.current = { ...state.lastViewedAtRef.current, [conversation.id]: conversation.updatedAt };
      persistLastViewedAt(state.lastViewedAtRef.current);
    }
    state.setUnreadConversationIds((current) => {
      if (!current.has(conversation.id)) return current;
      const next = new Set(current);
      next.delete(conversation.id);
      return next;
    });
  }

  async function startChatAccord(options: StartChatAccordOptions): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    state.setError(undefined);
    state.setWarnings([]);
    try {
      const result = await window.consensus.startChatAccord({
        conversationId: state.conversation.id,
        facilitatorParticipantId: options.facilitatorParticipantId,
        targetParticipantIds: options.targetParticipantIds,
        ...(options.targetProviderKinds?.length ? { targetProviderKinds: options.targetProviderKinds } : {}),
        subject: options.subject
      });
      const saved = await window.consensus.getConversation(state.conversation.id);
      if (saved) {
        state.setConversation((current) =>
          current?.id === saved.id
            ? mergeProgressIntoConversation(saved, state.progressLogRef.current.filter((item) => item.runId === result.runId))
            : current
        );
        state.setSummaries((current) => upsertConversationSummary(current, saved));
      }
      await conversationActions.refreshConversations();
      return true;
    } catch (caught) {
      state.setError(errorText(caught));
      return false;
    }
  }

  async function respondToChatAppToolApproval(approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope, draftOverride?: ChatAppToolApprovalRequest, codexDecisionId?: string, planDecision?: ChatClaudePlanDecision): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    state.setError(undefined);
    try {
      const saved = await window.consensus.respondToChatAppToolApproval({ conversationId: state.conversation.id, approvalId, approve, scope, draftOverride, codexDecisionId, planDecision });
      const [nextSettings] = await Promise.all([window.consensus.getSettings(), conversationActions.refreshConversations()]);
      state.setSettings(nextSettings);
      if (saved) updateIfStillOpen(saved);
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function commitChatParticipant(participant: ChatParticipantDraft): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    const existingHandles = new Set(chatParticipants(state.conversation).map((item) => item.handle.toLowerCase()));
    const validation = validateChatParticipantDrafts([participant], activeChatRoleConfigs(state.settings), existingHandles, state.settings.chatBehaviorRules) ?? validateChatCliAgents([participant], state.agents, state.settings.providers, state.settings.cliProviderHosts);
    if (validation) {
      state.setError(validation);
      return false;
    }
    state.setError(undefined);
    try {
      const saved = await window.consensus.addChatParticipant({ conversationId: state.conversation.id, participant });
      if (saved) updateIfStillOpen(saved);
      await conversationActions.refreshConversations();
      return true;
    } catch (caught) {
      state.setError(errorText(caught));
      return false;
    }
  }

  async function runBusyChatAction(cancelWarning: string, action: (runId: string) => Promise<void>): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    const runId = crypto.randomUUID();
    state.setError(undefined);
    state.setWarnings([]);
    state.setCurrentRunId(runId);
    state.progressLogRef.current = [];
    state.setProgressLog([]);
    state.setBusy(true);
    try {
      await action(runId);
    } catch (caught) {
      const message = errorText(caught);
      if (message.toLowerCase().includes("cancel")) {
        state.setWarnings((current) => [...current, cancelWarning]);
      } else {
        state.setError(message);
      }
    } finally {
      state.setBusy(false);
      state.setCurrentRunId(undefined);
    }
  }

  // An answer can take seconds to come back, and by then the User may be in
  // another chat. It updates its own chat only
  // while that chat is still the one loaded, and never brings it back on
  // screen: answering a card and moving on used to throw the User back to the
  // card's chat once the answer landed.
  function updateIfStillOpen(conversation: Conversation, runId?: string): void {
    state.setConversation((current) => {
      if (current?.id !== conversation.id) return current;
      return runId
        ? mergeProgressIntoConversation(conversation, state.progressLogRef.current.filter((item) => item.runId === runId))
        : conversation;
    });
  }

  async function refreshPersistedProviderPreference(): Promise<void> {
    try {
      state.setSettings(await window.consensus.getSettings());
    } catch {
      // A successful chat turn remains successful if the preference refresh fails.
    }
  }

  return {
    startChat, renameChatConversation, setChatArchived, setChatPinned, deleteChatConversation, sendChatMessage, respondToChatMentions,
    toggleChatReaction, dismissTurnFinishedNote, respondToChatChoice, addChatParticipant, addSavedChatParticipant,
    updateChatParticipantRuntime, updateChatSubagentProviders, removeChatParticipant, compactChatParticipant, restartChatParticipant, forkChatParticipantToNewChat, startChatAccord,
    respondToChatAppToolApproval
  };
}

function initialChatTitle(initialMessage: string, imageAttachments: ChatImageInput[]): string {
  return newChatTitle(initialMessage, imageAttachments[0]?.filename);
}

function hasMultipleMentionedParticipants(content: string, conversation: Parameters<typeof chatAppToolApprovals>[0]): boolean {
  const participants = chatParticipants(conversation);
  const mentioned = participants.filter((participant) =>
    new RegExp(`@${participant.handle}(?![A-Za-z0-9_-])`).test(content) ||
    new RegExp(`@${chatParticipantMentionHandle(participant, participants)}(?![A-Za-z0-9_-])`).test(content)
  );
  return mentioned.length > 1;
}
