import type {
  ChatAppToolApprovalRequest,
  ChatAppToolApprovalScope,
  ChatImageInput,
  ChatParticipant,
  ChatParticipantConfig,
  CloudRunRemoteExecutionMode,
  ChatSkillMention,
  RepoFileMention
} from "../../shared/types";
import {
  chatAppToolApprovals,
  chatParticipants
} from "../components/chat/chat-conversation-data";
import { chatParticipantMentionHandle } from "../components/conversation/conversation-display";
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
import {
  errorText,
  mergeProgressIntoConversation
} from "../components/review/review-conversation-data";
import type { AppState } from "./app-state";
import type { ConversationActions } from "./use-conversation-actions";
import { upsertConversationSummary } from "./conversation-summaries";
import { normalizeAutoChatTitle, normalizeManualChatTitle } from "../../shared/chatTitles";

export interface ChatActions {
  startChat: (options?: StartChatOptions) => Promise<boolean>;
  renameChatConversation: (title: string) => Promise<boolean>;
  setChatArchived: (conversationId: string, archived: boolean) => Promise<void>;
  sendChatMessage: (options?: SendChatMessageOptions) => Promise<boolean>;
  respondToChatMentions: (sourceMessageId: string, targetParticipantIds: string[], approve: boolean, continueRequester?: boolean) => Promise<void>;
  toggleChatReaction: (messageId: string, emoji: string) => Promise<void>;
  respondToChatChoice: (sourceMessageId: string, choiceId: string, response: ChatChoiceResponse) => Promise<void>;
  addChatParticipant: () => Promise<void>;
  addSavedChatParticipant: (config: ChatParticipantConfig, remoteExecution?: CloudRunRemoteExecutionMode) => Promise<void>;
  updateChatParticipantRuntime: (participantId: string, patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution">) => Promise<void>;
  removeChatParticipant: (participantId: string) => Promise<void>;
  compactChatParticipant: (participantId: string, options?: ChatRunScopeOptions) => Promise<boolean>;
  startChatAccord: (options: StartChatAccordOptions) => Promise<boolean>;
  respondToChatAppToolApproval: (
    approvalId: string,
    approve: boolean,
    scope?: ChatAppToolApprovalScope,
    draftOverride?: ChatAppToolApprovalRequest
  ) => Promise<void>;
}

export interface SendChatMessageOptions extends ChatRunScopeOptions {
  content?: string;
  skillMentions?: ChatSkillMention[];
  repoFileMentions?: RepoFileMention[];
  imageAttachments?: ChatImageInput[];
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
  subject: string;
}

type ChatChoiceResponse = { cancel?: boolean; selectedOptionId?: string; customAnswer?: string; note?: string };

export function useChatActions(state: AppState, conversationActions: ConversationActions): ChatActions {
  async function startChat(options: StartChatOptions = {}): Promise<boolean> {
    state.setError(undefined);
    state.setWarnings([]);
    const initialMessage = state.question.trim();
    const imageAttachments = options.imageAttachments ?? [];
    const repoFileMentions = options.repoFileMentions ?? [];
    const skillMentions = options.skillMentions ?? [];
    if (!initialMessage && imageAttachments.length === 0 && skillMentions.length === 0) {
      state.setError("Enter a message or attach an image to start a chat.");
      return false;
    }
    const participants = selectedOrMentionedChatParticipantDrafts(
      state.settings.chatParticipantConfigs,
      state.selectedChatParticipantConfigIds,
      initialMessage,
      state.selectedChatParticipantRunLocations
    );
    const validation = validateChatStartupDrafts(participants, state.settings.chatRoleConfigs, state.agents, state.settings.chatBehaviorRules);
    if (validation) {
      state.setError(validation);
      return false;
    }
    if (state.startingChatRef.current) {
      return false;
    }
    state.startingChatRef.current = true;
    const runId = crypto.randomUUID();
    state.setCurrentRunId(runId);
    state.setBusy(true);
    let createdConversationId: string | undefined;
    try {
      const result = await window.consensus.createChatConversation({
        title: initialChatTitle(initialMessage, imageAttachments),
        repoPath: state.repoPath.trim() || undefined,
        skipDefaultParticipants: participants.length === 0,
        participants
      });
      createdConversationId = result.conversation.id;
      state.setConversation(result.conversation);
      state.setWarnings(result.warnings);
      state.setChatMessageDraft("");
      state.setSelectedChatParticipantRunLocations({});
      const sendResult = await window.consensus.sendChatMessage({
        conversationId: result.conversation.id,
        runId,
        content: initialMessage,
        repoFileMentions,
        skillMentions,
        imageAttachments
      });
      state.setConversation(mergeProgressIntoConversation(sendResult.conversation, state.progressLogRef.current.filter((item) => item.runId === runId)));
      state.setWarnings([...result.warnings, ...sendResult.warnings]);
      state.setQuestion("");
      await conversationActions.refreshConversations();
      return true;
    } catch (caught) {
      const message = errorText(caught);
      if (createdConversationId) {
        // Ingest failed before the first message was persisted, so the created
        // conversation is empty. Soft-delete it and return to the new-chat screen
        // with the text restored instead of stranding an empty conversation.
        state.setConversation(undefined);
        state.setQuestion(initialMessage);
        try {
          await window.consensus.setChatArchived({ conversationId: createdConversationId, archived: true });
          await conversationActions.refreshConversations();
        } catch {
          // Best-effort cleanup; leave the empty conversation if archiving fails.
        }
      }
      if (message.toLowerCase().includes("cancel")) {
        state.setWarnings((current) => [...current, "Chat turn cancelled."]);
      } else {
        state.setError(message);
      }
      return false;
    } finally {
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

  async function sendChatMessage(options: SendChatMessageOptions = {}): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    const content = (options.content ?? state.chatMessageDraft).trim();
    const imageAttachments = options.imageAttachments ?? [];
    const skillMentions = options.skillMentions ?? [];
    if (!content && imageAttachments.length === 0 && skillMentions.length === 0) {
      state.setError("Enter a chat message or attach an image.");
      return false;
    }
    if (skillMentions.length > 0 && hasMultipleMentionedParticipants(content, state.conversation)) {
      state.setError("A selected skill runs on a single participant. Mention exactly one participant, or remove the skill. Other participants can be brought in by the running skill itself.");
      return false;
    }
    const runId = crypto.randomUUID();
    state.setError(undefined);
    state.setWarnings([]);
    if (!options.chatThreadRootId) {
      state.setChatMessageDraft("");
    }
    try {
      const result = await window.consensus.sendChatMessage({
        conversationId: state.conversation.id,
        runId,
        content,
        skillMentions,
        repoFileMentions: options.repoFileMentions,
        imageAttachments,
        threadId: options.threadId,
        parentMessageId: options.parentMessageId,
        chatThreadRootId: options.chatThreadRootId
      });
      state.setConversation((current) =>
        current && current.id === result.conversation.id
          ? mergeProgressIntoConversation(result.conversation, state.progressLogRef.current.filter((item) => item.runId === runId))
          : current
      );
      if (result.warnings.length > 0) {
        state.setWarnings(result.warnings);
      }
      return true;
    } catch (caught) {
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
      const result = await window.consensus.respondToChatMentions({
        conversationId: state.conversation!.id,
        sourceMessageId,
        targetParticipantIds,
        approve,
        continueRequester,
        runId
      });
      state.setConversation(mergeProgressIntoConversation(result.conversation, state.progressLogRef.current.filter((item) => item.runId === runId)));
      state.setWarnings(result.warnings);
      await conversationActions.refreshConversations();
    });
  }

  async function toggleChatReaction(messageId: string, emoji: string): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    state.setError(undefined);
    try {
      const saved = await window.consensus.toggleChatReaction({ conversationId: state.conversation.id, messageId, emoji });
      if (saved) {
        state.setConversation(saved);
        state.setSummaries((current) => upsertConversationSummary(current, saved));
      }
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function respondToChatChoice(sourceMessageId: string, choiceId: string, response: ChatChoiceResponse): Promise<void> {
    await runBusyChatAction("Choice response cancelled.", async (runId) => {
      const result = await window.consensus.respondToChatChoice({
        conversationId: state.conversation!.id,
        sourceMessageId,
        choiceId,
        ...response,
        runId
      });
      state.setConversation(mergeProgressIntoConversation(result.conversation, state.progressLogRef.current.filter((item) => item.runId === runId)));
      state.setWarnings(result.warnings);
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

  async function addSavedChatParticipant(config: ChatParticipantConfig, remoteExecution?: CloudRunRemoteExecutionMode): Promise<void> {
    const draft = chatParticipantConfigToDraft(config);
    const participant = normalizedChatDrafts([{
      ...draft,
      remoteExecution: remoteExecution ?? draft.remoteExecution
    }])[0];
    await commitChatParticipant(participant);
  }

  async function updateChatParticipantRuntime(participantId: string, patch: Pick<ChatParticipant, "model" | "reasoningEffort" | "agentMode" | "permissions" | "remoteExecution">): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    state.setError(undefined);
    try {
      const saved = await window.consensus.updateChatParticipantRuntime({
        conversationId: state.conversation.id,
        participantId,
        model: patch.model,
        reasoningEffort: patch.reasoningEffort,
        agentMode: patch.agentMode,
        permissions: patch.permissions,
        remoteExecution: patch.remoteExecution
      });
      if (saved) state.setConversation(saved);
      await conversationActions.refreshConversations();
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function removeChatParticipant(participantId: string): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    state.setError(undefined);
    try {
      const saved = await window.consensus.removeChatParticipant({ conversationId: state.conversation.id, participantId });
      if (saved) state.setConversation(saved);
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

  async function startChatAccord(options: StartChatAccordOptions): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    state.setError(undefined);
    state.setWarnings([]);
    try {
      const result = await window.consensus.startChatAccord({
        conversationId: state.conversation.id,
        facilitatorParticipantId: options.facilitatorParticipantId,
        targetParticipantIds: options.targetParticipantIds,
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

  async function respondToChatAppToolApproval(approvalId: string, approve: boolean, scope?: ChatAppToolApprovalScope, draftOverride?: ChatAppToolApprovalRequest): Promise<void> {
    if (!state.conversation || state.conversation.kind !== "chat") return;
    state.setError(undefined);
    try {
      const saved = await window.consensus.respondToChatAppToolApproval({ conversationId: state.conversation.id, approvalId, approve, scope, draftOverride });
      const [nextSettings, nextSummaries] = await Promise.all([window.consensus.getSettings(), window.consensus.listConversations()]);
      state.setSettings(nextSettings);
      if (saved) state.setConversation(saved);
      state.setSummaries(nextSummaries);
    } catch (caught) {
      state.setError(errorText(caught));
    }
  }

  async function commitChatParticipant(participant: ChatParticipantDraft): Promise<boolean> {
    if (!state.conversation || state.conversation.kind !== "chat") return false;
    const existingHandles = new Set(chatParticipants(state.conversation).map((item) => item.handle.toLowerCase()));
    const validation = validateChatParticipantDrafts([participant], activeChatRoleConfigs(state.settings), existingHandles, state.settings.chatBehaviorRules) ?? validateChatCliAgents([participant], state.agents);
    if (validation) {
      state.setError(validation);
      return false;
    }
    state.setError(undefined);
    try {
      const saved = await window.consensus.addChatParticipant({ conversationId: state.conversation.id, participant });
      if (saved) state.setConversation(saved);
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

  return {
    startChat, renameChatConversation, setChatArchived, sendChatMessage, respondToChatMentions,
    toggleChatReaction, respondToChatChoice, addChatParticipant, addSavedChatParticipant,
    updateChatParticipantRuntime, removeChatParticipant, compactChatParticipant, startChatAccord, respondToChatAppToolApproval
  };
}

function initialChatTitle(initialMessage: string, imageAttachments: ChatImageInput[]): string {
  if (initialMessage) {
    return normalizeAutoChatTitle(initialMessage);
  }
  const filename = imageAttachments[0]?.filename?.trim();
  return normalizeManualChatTitle(filename ? `Image: ${filename}` : "Image chat");
}

function hasMultipleMentionedParticipants(content: string, conversation: Parameters<typeof chatAppToolApprovals>[0]): boolean {
  const participants = chatParticipants(conversation);
  const mentioned = participants.filter((participant) =>
    new RegExp(`@${participant.handle}(?![A-Za-z0-9_-])`).test(content) ||
    new RegExp(`@${chatParticipantMentionHandle(participant, participants)}(?![A-Za-z0-9_-])`).test(content)
  );
  return mentioned.length > 1;
}
