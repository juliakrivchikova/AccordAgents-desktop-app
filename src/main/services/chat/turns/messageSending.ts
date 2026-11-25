import { mainSessionMemberOf } from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import { hubTurnRunId } from "../../../../shared/hubOps";
import type {
  ChatMessage, ChatMessageMetadata, ChatParticipant, ChatParticipantInput, ChatProviderKind, ChatSkillMention, Conversation,
  RepoFileMention, SendChatMessageRequest, StartReviewResult
} from "../../../../shared/types";
import { nativeGoalObjective, parseNativeGoalCommand } from "../../../../shared/nativeGoalCommand";
import type { UserSkillRunContext } from "../../userSkills";
import { advanceAutoWatchCursorForDirectTargets, resetAutoWatchDepthForUserMessage } from "../autoWatch/watchers";
import {
  chatSkillMentions, chatSkillMentionsFromRaw, explicitMessageTargets, hasStandaloneAccordSkillToken, replyContextFromMessage,
  resolveDispatchTargetsForContent, userSkillRunContext, validateRepoFileMentions
} from "../choices/mentions";
import { bareCompactCommand, parseCompactCommand } from "../compaction/compactionText";
import { assertParticipantProvidersEnabled, chatParticipants, splitMainSessionInput } from "../members/identity";
import { clearedChatRunMetadata } from "../runs/runOwnerRecords";
import { createChatMessage } from "../store/messages";
import { initialAutoTitleEligibility, shouldCreateInitialAutoTitleEligibility } from "../store/titles";
import { emitChatRunFailure, emitProgress } from "./replyMessages";
import { hasMobileEventMessage, isMobileOriginRun, normalizedMobileEventId } from "./turnOrder";
import type { ChatDispatchReplyContext, ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** The User's message: checked, saved and handed to the members it is for. */
export class MessageSending {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "accord" | "activeRuns" | "attachments" | "autoWatch" | "compaction" | "creation" | "machineSupport"
      | "participantBatch" | "promptSuggestions" | "remoteTurns" | "requestGrants" | "serverLink" | "serverTurns" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "settings" | "storage" | "userSkills">
  ) {}

  async prospectiveUserSkillRunContext(request: {
    repoPath?: string;
    participants?: ChatParticipantInput[];
    assistantProviderKind?: ChatProviderKind;
    content?: string;
  }): Promise<UserSkillRunContext> {
    // The chat the New chat screen would make: its members and its main
    // session (createConversation), which the first message goes to when it
    // names nobody.
    const { mainSession: mainSessionInput, members: memberInputs } = splitMainSessionInput(request.participants ?? []);
    const requestedParticipants = await this.chat.creation.validateParticipants(memberInputs, [], true);
    const settings = request.assistantProviderKind ? undefined : await this.deps.settings.getPublicSettings();
    const assistantProviderKind = request.assistantProviderKind
      ?? await this.chat.creation.defaultAdministratorProviderKind(settings?.providers ?? []).catch(() => undefined);
    const repoPath = request.repoPath?.trim() || undefined;
    // A prediction: without a main session it is made for the members alone.
    const participants = assistantProviderKind || mainSessionInput
      ? await this.chat.creation.ensureMainSessionParticipant(requestedParticipants, assistantProviderKind, { repoPath, requested: mainSessionInput })
        .catch(() => requestedParticipants)
      : requestedParticipants;
    const mainSession = mainSessionMemberOf(participants);
    const conversation: Conversation = {
      id: "prospective-chat",
      title: "",
      kind: "chat",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      repoPath,
      messages: [],
      findings: [],
      metadata: {
        participants,
        participantSessions: [],
        warnings: [],
        running: false,
        ...(mainSession ? { mainSessionParticipantId: mainSession.id } : {})
      }
    };
    return userSkillRunContext(conversation, request.content ?? "");
  }

  async hasAcceptedMobileEvent(conversationId: string, eventId: string): Promise<boolean> {
    const mobileEventId = normalizedMobileEventId(eventId);
    if (!mobileEventId) {
      return false;
    }
    const conversation = await this.deps.storage.getConversation(conversationId);
    return Boolean(conversation && hasMobileEventMessage(conversation, mobileEventId));
  }

  async sendMessage(request: SendChatMessageRequest, signal?: AbortSignal, progress?: ProgressCallback): Promise<StartReviewResult> {
    const runId = request.runId ?? randomUUID();
    // `/compact` with no handle: her text reaches the CLI as typed, and the
    // CLI would compact by itself with nothing in the chat to show it, so the
    // app compacts each member the message goes to, as `@handle /compact`
    // does (the server's turns do the same: startServerTurn).
    const bareCompact = bareCompactCommand(request.content);
    if (
      bareCompact &&
      (request.imageAttachments ?? []).length === 0 &&
      (request.skillMentions ?? []).length === 0 &&
      (request.repoFileMentions ?? []).length === 0
    ) {
      const conversation = await this.chat.store.requireChat(request.conversationId);
      const targets = request.targetParticipantIds?.length
        ? explicitMessageTargets(conversation, request.targetParticipantIds)
        : resolveDispatchTargetsForContent(conversation, request.content, {
            parentMessageId: request.parentMessageId,
            threadId: request.threadId?.trim() || undefined,
            chatThreadRootId: request.chatThreadRootId?.trim() || undefined
          }).targets;
      let compacted: StartReviewResult | undefined;
      for (const target of targets) {
        compacted = await this.chat.compaction.compactParticipant({
          conversationId: request.conversationId,
          participantId: target.id,
          instructions: bareCompact.instructions,
          triggeredBy: "user",
          runId: targets.length === 1 ? runId : randomUUID(),
          threadId: request.threadId,
          parentMessageId: request.parentMessageId,
          chatThreadRootId: request.chatThreadRootId
        }, signal, progress);
      }
      if (compacted) return compacted;
    }
    const compactCommand = parseCompactCommand(request.content);
    if (
      compactCommand &&
      (request.imageAttachments ?? []).length === 0 &&
      (request.skillMentions ?? []).length === 0 &&
      (request.repoFileMentions ?? []).length === 0
    ) {
      return this.chat.compaction.compactParticipant({
        conversationId: request.conversationId,
        handle: compactCommand.handle,
        instructions: compactCommand.instructions,
        triggeredBy: "user",
        runId,
        threadId: request.threadId,
        parentMessageId: request.parentMessageId,
        chatThreadRootId: request.chatThreadRootId
      }, signal, progress);
    }
    const warnings: string[] = [];
    const ingest = await this.chat.activeRuns.withChatRunLock(request.conversationId, async () => {
      const conversation = await this.chat.store.requireChat(request.conversationId);
      const mobileEventId = normalizedMobileEventId(request.mobileEventId);
      if (mobileEventId && hasMobileEventMessage(conversation, mobileEventId)) {
        return {
          conversation,
          duplicateMobileEvent: true as const,
          dispatch: { targets: [], unknownHandles: [] },
          userMessage: undefined,
          autoTitleTargetRunIds: undefined
        };
      }
      let content = request.content.trim();
      const requestedSkillMentions = chatSkillMentionsFromRaw(request.skillMentions);
      const preparedImages = await this.chat.attachments.prepareImageAttachments(conversation.id, request.imageAttachments);
      if (!content && preparedImages.attachments.length === 0 && requestedSkillMentions.length === 0) {
        throw new Error("Message is required.");
      }
      if (!content && requestedSkillMentions.length > 0) {
        content = "Use the selected skill(s).";
      }
      let repoFileMentions: RepoFileMention[];
      let dispatch: { targets: ChatParticipant[]; unknownHandles: string[] };
      let skillValidation: { skillMentions: ChatSkillMention[]; targets: ChatParticipant[]; blocks: string[] };
      let nativeGoal: ReturnType<typeof parseNativeGoalCommand> = { kind: "none" };
      const requestedThreadRootId = request.chatThreadRootId?.trim() || undefined;
      // A thread root this chat does not hold — the phone can name a row the
      // desktop never had, a machine's own note or a row since deleted —
      // would file the message under a thread nobody can open. It goes to
      // the chat itself instead, and the chat says so.
      const chatThreadRootId = requestedThreadRootId &&
        conversation.messages.some((message) => message.id === requestedThreadRootId)
        ? requestedThreadRootId
        : undefined;
      if (requestedThreadRootId && !chatThreadRootId) {
        warnings.push("The thread this message was written in is not in this chat, so it was posted to the chat itself.");
      }
      const replyContext: ChatDispatchReplyContext = {
        parentMessageId: request.parentMessageId,
        threadId: request.threadId?.trim() || undefined,
        chatThreadRootId
      };
      try {
        repoFileMentions = await validateRepoFileMentions(conversation, request.repoFileMentions, warnings, content);
        // Written to chosen members (a member's session panel): exactly
        // those, whatever @handles the text has, and nobody else.
        dispatch = request.targetParticipantIds !== undefined && request.targetParticipantIds.length > 0
          ? { targets: explicitMessageTargets(conversation, request.targetParticipantIds), unknownHandles: [] }
          : resolveDispatchTargetsForContent(conversation, content, replyContext);
        skillValidation = await this.validateChatSkillMentionsForTargets(
          conversation,
          content,
          requestedSkillMentions,
          dispatch.targets,
          replyContext
        );
        dispatch = { ...dispatch, targets: skillValidation.targets };
        nativeGoal = parseNativeGoalCommand(content);
        if (nativeGoal.kind === "invalid") {
          throw new Error(nativeGoal.error);
        }
        if (nativeGoal.kind === "valid" && dispatch.targets.length !== 1) {
          throw new Error("/goal requires exactly one resolved chat member.");
        }
        const settings = await this.deps.settings.getPublicSettings();
        assertParticipantProvidersEnabled(dispatch.targets, settings.providers ?? []);
      } catch (error) {
        await this.chat.attachments.rollbackPreparedImageAttachments(conversation.id, preparedImages, "MessageValidationFailed", error);
        throw error;
      }
      const initialAutoTitleCandidate = shouldCreateInitialAutoTitleEligibility(conversation, request, dispatch.targets);
      let autoTitleTargetRunIds: Map<string, string> | undefined;
      const threadId = replyContext.threadId ?? randomUUID();
      const userMessage = createChatMessage("user", content, undefined, {
        threadId,
        parentMessageId: request.parentMessageId,
        chatThreadRootId,
        ...(isMobileOriginRun(runId) ? { appMessageSource: "mobile-relay" } : {}),
        ...(mobileEventId ? { mobileEventId } : {}),
        ...(skillValidation.skillMentions.length > 0 ? { skillMentions: skillValidation.skillMentions } : {}),
        ...(repoFileMentions.length > 0 ? { repoFileMentions } : {}),
        ...(preparedImages.attachments.length > 0 ? { imageAttachments: preparedImages.attachments } : {})
      });
      if (nativeGoal.kind === "valid") {
        userMessage.metadata = {
          ...userMessage.metadata,
          nativeCommand: {
            name: "goal",
            objective: nativeGoalObjective(nativeGoal.contentWithoutCommand, dispatch.targets[0].handle)
          }
        };
      }
      if (!request.threadId?.trim()) {
        userMessage.metadata = { ...userMessage.metadata, threadId: userMessage.id };
      }
      conversation.messages.push(userMessage);
      this.chat.promptSuggestions.suggestions.userMessageSent(conversation.id);
      for (const unknown of dispatch.unknownHandles) {
        const warning = `No member named @${unknown}.`;
        warnings.push(warning);
        conversation.messages.push(createChatMessage("system", warning, undefined, {
          threadId: userMessage.metadata?.threadId ?? threadId,
          parentMessageId: userMessage.id,
          chatThreadRootId
        }));
      }
      for (const block of skillValidation.blocks) {
        conversation.messages.push(createChatMessage("system", block, undefined, {
          threadId: userMessage.metadata?.threadId ?? threadId,
          parentMessageId: userMessage.id,
          chatThreadRootId
        }));
      }
      try {
        await this.chat.store.withChatMutation(conversation, async () => {
          // On the watchers as saved now: each watcher's newest state wins
          // the refresh, which an earlier reset would lose to.
          resetAutoWatchDepthForUserMessage(conversation);
          // Targets were resolved on the copy read before this mutation: a
          // member removed meanwhile is told apart, as an unknown name is.
          // An accord's facilitator is decided on the members the User named.
          dispatch = {
            ...dispatch,
            targets: this.chat.requestGrants.allowParticipantRequestsForManualAccordIfSelected(conversation, skillValidation.skillMentions, dispatch.targets)
          };
          const present = new Set(chatParticipants(conversation).map((participant) => participant.id));
          for (const gone of dispatch.targets.filter((target) => !present.has(target.id))) {
            const warning = `No member named @${gone.handle}.`;
            warnings.push(warning);
            conversation.messages.push(createChatMessage("system", warning, undefined, {
              threadId: userMessage.metadata?.threadId ?? threadId,
              parentMessageId: userMessage.id,
              chatThreadRootId
            }));
          }
          dispatch = { ...dispatch, targets: dispatch.targets.filter((target) => present.has(target.id)) };
          if (dispatch.targets.length > 0) {
            // Every member it asks, including those asked later below: a
            // member watching the chat on another device must not wake for it.
            const askedParticipantIds = dispatch.targets.map((target) => target.id);
            for (const message of conversation.messages) {
              if (message.id === userMessage.id) message.metadata = { ...message.metadata, askedParticipantIds };
            }
            userMessage.metadata = { ...userMessage.metadata, askedParticipantIds };
          }
          if (this.chat.serverLink.current && dispatch.targets.length > 0) {
            // The members this message names, as this device resolved them:
            // the server asks each one's device for its turn (Д4), and this
            // process runs its own members' turns itself, under the same ids.
            // A member whose cloud machine is not chosen yet, or whose machine
            // has not got this chat's project yet, is asked by this device once
            // that is done (runParticipantTurnRemote), not by the server at once;
            // one whose machine's program cannot run its mode is refused there,
            // so the server never asks that machine for it.
            const askedLater = new Set<string>();
            for (const target of dispatch.targets) {
              if (target.cloudRun && !target.homeMachineId) askedLater.add(target.id);
              else if (this.chat.machineSupport.machineCliModesRefusal(conversation, target)) askedLater.add(target.id);
              else if (target.homeMachineId && conversation.repoPath && this.chat.remoteTurns.machineProjectReady &&
                  !await this.chat.remoteTurns.machineProjectReady(target.homeMachineId, conversation.repoPath).catch(() => false)) askedLater.add(target.id);
            }
            const deliveryTargets = dispatch.targets.filter((target) => !askedLater.has(target.id)).map((target) => target.id);
            for (const message of conversation.messages) {
              if (message.id === userMessage.id) message.metadata = { ...message.metadata, deliveryTargets } as ChatMessageMetadata;
            }
            userMessage.metadata = { ...userMessage.metadata, deliveryTargets } as ChatMessageMetadata;
            for (const target of dispatch.targets) this.chat.serverTurns.inProcessServerTurns.add(hubTurnRunId(userMessage.id, target.id));
          }
          if (initialAutoTitleCandidate && dispatch.targets.length > 0) {
            autoTitleTargetRunIds = new Map(dispatch.targets.map((target) => [target.id, this.chat.serverLink.current ? hubTurnRunId(userMessage.id, target.id) : randomUUID()]));
            conversation.metadata = {
              ...conversation.metadata,
              autoTitleEligibility: initialAutoTitleEligibility(userMessage, dispatch.targets, autoTitleTargetRunIds)
            };
          }
          advanceAutoWatchCursorForDirectTargets(conversation, dispatch.targets, userMessage);
          if (dispatch.targets.length === 0) {
            // Nothing starts for this message; other members' runs, here or
            // in another app instance, keep their run state.
            conversation.metadata = this.chat.activeRuns.metadataWithLiveRunState(conversation.id, conversation.metadata);
          }
          conversation.updatedAt = new Date().toISOString();
          await this.chat.store.saveConversation(conversation);
        });
      } catch (error) {
        await this.chat.attachments.rollbackPreparedImageAttachments(conversation.id, preparedImages, "ConversationSaveFailed", error);
        throw error;
      }
      return { conversation, dispatch, userMessage, autoTitleTargetRunIds };
    });

    if (ingest.duplicateMobileEvent) {
      return { conversation: ingest.conversation, warnings };
    }

    if (ingest.dispatch.targets.length === 0) {
      this.chat.autoWatch.scheduleAutoWatchEvaluation(ingest.conversation.id, "user-message");
      return { conversation: ingest.conversation, warnings };
    }

    emitProgress(runId, progress, "initial", `Running ${ingest.dispatch.targets.length} chat member${ingest.dispatch.targets.length === 1 ? "" : "s"}.`, {
      total: ingest.dispatch.targets.length,
      completed: 0
    });

    const dispatchWarnings: string[] = [];
    const serverTargetRunIds = this.chat.serverLink.current && ingest.userMessage
      ? new Map(ingest.dispatch.targets.map((target) => [target.id, hubTurnRunId(ingest.userMessage!.id, target.id)] as const))
      : undefined;
    const dispatchPromise = this.chat.participantBatch.runParticipantBatch(
      ingest.conversation,
      ingest.dispatch.targets,
      ingest.userMessage,
      runId,
      signal,
      progress,
      dispatchWarnings,
      ingest.autoTitleTargetRunIds ? { targetRunIds: ingest.autoTitleTargetRunIds } : serverTargetRunIds ? { targetRunIds: serverTargetRunIds } : {}
    );
    // Fire-and-track: ingest is already persisted, so return to the renderer now and let the
    // participant batch run in the background. Completion and per-participant failures surface
    // through progress and conversation snapshots — a single failed participant must not reject
    // the `chat:send` call or hold it open for the length of a multi-minute agent run.
    void dispatchPromise
      .then(() => {
        emitProgress(runId, progress, "done", "Chat turn finished.", {
          completed: ingest.dispatch.targets.length,
          total: ingest.dispatch.targets.length
        });
      })
      .catch(async (error) => {
        emitChatRunFailure(runId, progress, error);
        if (!this.chat.activeRuns.chatHasLiveWork(ingest.conversation.id)) {
          await this.chat.store.withChatMutation(ingest.conversation, async () => {
            ingest.conversation.metadata = clearedChatRunMetadata(ingest.conversation.metadata);
            ingest.conversation.updatedAt = new Date().toISOString();
            await this.chat.store.saveConversation(ingest.conversation);
          });
        }
      })
      .finally(async () => {
        if (dispatchWarnings.length > 0) {
          await this.chat.store.appendConversationWarnings(ingest.conversation, dispatchWarnings);
        }
      });
    return { conversation: ingest.conversation, warnings };
  }

  private async validateChatSkillMentionsForTargets(
    conversation: Conversation,
    content: string,
    rawMentions: ChatSkillMention[] | undefined,
    targets: ChatParticipant[],
    context?: ChatDispatchReplyContext
  ): Promise<{ skillMentions: ChatSkillMention[]; targets: ChatParticipant[]; blocks: string[] }> {
    let skillMentions = chatSkillMentionsFromRaw(rawMentions);
    if (skillMentions.length === 0) {
      skillMentions = await this.deriveAccordSkillMentionFromContent(conversation, content, targets, context);
    }
    if (skillMentions.length === 0) {
      return { skillMentions: [], targets, blocks: [] };
    }
    // A selected skill is applied to every mentioned participant, so multiple mentions would
    // run the skill on each of them at once. That is never the intent (e.g. /accord must run
    // only on the facilitator, which then contacts peers via app_chat_request_participants).
    // Require exactly one target when a skill is selected.
    if (targets.length > 1) {
      throw new Error(
        "A selected skill runs on a single member. Mention exactly one member in this message, or remove the skill. Other members can be brought in by the running skill itself (for example, /accord contacts them via a member request)."
      );
    }
    if (!this.deps.userSkills) {
      throw new Error("Skill selection is unavailable.");
    }
    if (targets.length === 0) {
      throw new Error("Mention a member before selecting a skill.");
    }
    const skillContext = userSkillRunContext(conversation, content, context);
    const validTargets: ChatParticipant[] = [];
    const blocks: string[] = [];
    for (const participant of targets) {
      const errors: string[] = [];
      for (const mention of skillMentions) {
        const result = await this.deps.userSkills.validateMentionForParticipant(mention, participant.kind, skillContext, participant.id);
        if (!result.ok) {
          errors.push(result.message);
        }
      }
      if (errors.length === 0) {
        validTargets.push(participant);
      } else {
        blocks.push(`@${participant.handle} was not run because ${errors.join(" ")}`);
      }
    }
    return { skillMentions, targets: validTargets, blocks };
  }

  private async deriveAccordSkillMentionFromContent(
    conversation: Conversation,
    content: string,
    targets: ChatParticipant[],
    context?: ChatDispatchReplyContext
  ): Promise<ChatSkillMention[]> {
    if (targets.length !== 1 || !hasStandaloneAccordSkillToken(content)) {
      return [];
    }
    const accordSkill = await this.chat.accord.findAccordSkillForParticipant(conversation, targets[0], content, context);
    return accordSkill ? [accordSkill] : [];
  }

  async skillRunBlockForParticipant(
    conversation: Conversation,
    participant: ChatParticipant,
    triggerMessage: ChatMessage
  ): Promise<string | undefined> {
    const skillMentions = chatSkillMentions(triggerMessage);
    if (skillMentions.length === 0) {
      return undefined;
    }
    if (!this.deps.userSkills) {
      return `@${participant.handle} was not run because skill selection is unavailable.`;
    }
    const context = userSkillRunContext(conversation, triggerMessage.content, replyContextFromMessage(triggerMessage));
    const errors: string[] = [];
    for (const mention of skillMentions) {
      const result = await this.deps.userSkills.validateMentionForParticipant(mention, participant.kind, context, participant.id);
      if (!result.ok) {
        errors.push(result.message);
      }
    }
    return errors.length > 0
      ? `@${participant.handle} was not run because ${errors.join(" ")}`
      : undefined;
  }
}
