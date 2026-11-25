import { isMainSessionParticipant } from "../../../../shared/mainSession";
import { randomUUID } from "node:crypto";
import type {
  ChatMessage, ChatMessageMetadata, ChatParticipant, ChatParticipantRequestPermission, ChatSkillMention, Conversation,
  StartChatAccordRequest, StartChatAccordResult, CloseAccordCardRequest
} from "../../../../shared/types";
import { accordLaunchCardForMessage } from "../../../../shared/accordLaunchCard";
import type { ArtifactNoteLinks } from "../../artifactClient";
import { accordClosedLaunchIds, accordClosedLine } from "../../../../shared/accordProgress";
import { ARTIFACT_NOTE_MESSAGE_SOURCE, normalizeArtifactMember } from "../../../../shared/artifacts";
import {
  chatParticipantRequestPermissionRank, normalizeChatParticipantRequestPermission, normalizeChatAgentPermissions
} from "../../../../shared/agentPermissions";
import { hasChatAppToolCapability } from "../../../../shared/appTools";
import { advanceAutoWatchCursorForDirectTargets } from "../autoWatch/watchers";
import { accordStartMessageContent, participantForMentionHandle, userSkillRunContext } from "../choices/mentions";
import { CHAT_ADMINISTRATOR_ROLE_ID } from "../constants";
import { chatParticipants } from "../members/identity";
import { delegationRefusal } from "../members/removalRules";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import { createChatMessage } from "../store/messages";
import { emitChatRunFailure, emitProgress } from "../turns/replyMessages";
import type { ChatAppMcpActor, ChatDispatchReplyContext, ProgressCallback } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

/** Starts Accords and posts their notes to the chat. */
export class ChatAccord {
  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "host" | "participantBatch" | "promptSuggestions" | "requestGrants" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "onReviewProgress" | "storage" | "userSkills">
  ) {}

  /**
   * The main session starts an Accord (app_chat_start_accord,
   * docs/main-session.md): the same launch as the User's, written as the
   * main session's message. The facilitator defaults to the main session.
   */
  async startAccordFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const caller = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!caller) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    this.chat.host.assertOwnsParticipant(caller);
    if (!hasChatAppToolCapability(actor.capabilities, "accord.start") || !isMainSessionParticipant(conversation.metadata, caller.id)) {
      return delegationRefusal("not_main_session", "Only the chat's main session starts an Accord. Ask the main session for one.");
    }
    const record = rawRequest && typeof rawRequest === "object" && !Array.isArray(rawRequest) ? rawRequest as Record<string, unknown> : {};
    const subject = typeof record.subject === "string" ? record.subject.trim() : "";
    const targets = Array.isArray(record.targets) ? record.targets.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
    if (!subject || targets.length === 0) {
      return delegationRefusal("invalid_request", "An Accord needs a subject and at least one member in targets.");
    }
    const participants = chatParticipants(conversation);
    const resolve = (handle: string): ChatParticipant | undefined => participantForMentionHandle(participants, handle.trim().replace(/^@/, ""));
    const facilitator = typeof record.facilitator === "string" && record.facilitator.trim() ? resolve(record.facilitator) : caller;
    if (!facilitator) {
      return delegationRefusal("invalid_request", `No member named ${String(record.facilitator)}.`);
    }
    const members: ChatParticipant[] = [];
    for (const handle of targets) {
      const member = resolve(handle);
      if (!member) {
        return delegationRefusal("invalid_request", `No member named @${handle.trim().replace(/^@/, "")}.`);
      }
      if (!members.some((item) => item.id === member.id)) {
        members.push(member);
      }
    }
    try {
      const started = await this.startAccord({
        conversationId: conversation.id,
        facilitatorParticipantId: facilitator.id,
        targetParticipantIds: members.map((member) => member.id),
        subject
      }, undefined, this.deps.onReviewProgress, randomUUID(), { author: caller });
      return {
        ok: true,
        status: "started",
        launchMessageId: started.sourceMessageId,
        facilitator: `@${facilitator.handle}`,
        members: members.map((member) => `@${member.handle}`)
      };
    } catch (error) {
      return delegationRefusal("not_started", error instanceof Error ? error.message : String(error));
    }
  }

  /** The User's cross on the pinned Accord card: the card folds into a line
   *  at the end of the chat as it stands now (accordProgress.ts). The line
   *  goes to her server like any message, so every device shows it in the
   *  same place; one line per Accord. It is her view of the chat, not news:
   *  the chat keeps its place in her list. */
  async closeAccordCard(request: CloseAccordCardRequest): Promise<void> {
    const launchMessageId = typeof request.launchMessageId === "string" ? request.launchMessageId.trim() : "";
    if (!launchMessageId) {
      return;
    }
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      throw new Error("This chat is not here.");
    }
    await this.chat.store.withChatMutation(conversation, async () => {
      // Its line is here already; one her server refused does not count.
      if (accordClosedLaunchIds(conversation.messages).includes(launchMessageId)) {
        return;
      }
      conversation.messages.push(accordClosedLine({
        id: randomUUID(),
        launchMessageId,
        title: typeof request.title === "string" ? request.title : undefined,
        createdAt: new Date().toISOString()
      }));
      // Saved before the cross is answered (the save records the folded
      // Accords): a save that fails gives the card back instead of leaving
      // neither card nor line.
      await this.chat.store.saveConversation(conversation);
    });
  }

  // Resolve the artifact-system member identity ("user" | participant handle)
  // for an app MCP actor. Rejects actors that are no longer chat participants.
  async artifactActorMember(actor: ChatAppMcpActor): Promise<string> {
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const participant = chatParticipants(conversation).find((candidate) => candidate.id === actor.participantId);
    if (!participant) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    return normalizeArtifactMember(participant.handle);
  }

  // The Accord launch a member's turn runs for, when that member is its
  // facilitator: the User's launch message at the root of the turn's thread
  // (or the turn's own trigger). Worked out by the app from its own records,
  // so a member cannot tie a document to an Accord it does not lead.
  async accordLaunchMessageIdForActor(actor: ChatAppMcpActor): Promise<string | undefined> {
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const participant = chatParticipants(conversation).find((candidate) => candidate.id === actor.participantId);
    if (!participant) {
      return undefined;
    }
    const handle = normalizeArtifactMember(participant.handle);
    // Nearest first: a second Accord started inside another's thread is its own.
    const candidates = [actor.triggerMessageId, actor.triggerThreadId, actor.triggerChatThreadRootId]
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    for (const messageId of Array.from(new Set(candidates))) {
      const message = conversation.messages.find((candidate) => candidate.id === messageId)
        ?? await this.deps.storage.conversationMessageById(actor.conversationId, messageId);
      // Read as the chat reads a launch, so a document is filed only under a
      // message the chat draws as an Accord card.
      const card = message ? accordLaunchCardForMessage(message) : undefined;
      if (card && normalizeArtifactMember(card.facilitator) === handle) {
        return messageId;
      }
    }
    return undefined;
  }

  // Append a brief artifact note ("@gera revised [Plan](#artifact:id) · v3") to
  // the chat timeline. Notes are system messages flagged with
  // ARTIFACT_NOTE_MESSAGE_SOURCE so the timeline keeps them visible; they carry
  // a link token, never artifact bodies.
  async postArtifactChatNote(
    conversationId: string,
    eventId: string,
    content: string,
    links?: ArtifactNoteLinks
  ): Promise<void> {
    const conversation = await this.chat.store.requireChat(conversationId);
    const launchId = links?.originMessageId;
    const launch = launchId
      ? accordLaunchCardForMessage(conversation.messages.find((message) => message.id === launchId)
        ?? await this.deps.storage.conversationMessageById(conversationId, launchId).catch(() => undefined)
        ?? { role: "", content: "" })
      : undefined;
    await this.chat.store.withChatMutation(conversation, async () => {
      if (conversation.messages.some((message) => message.metadata?.artifactEventId === eventId)) {
        return;
      }
      const note = {
        id: randomUUID(),
        role: "system",
        content,
        createdAt: new Date().toISOString(),
        status: "done",
        metadata: {
          appMessageSource: ARTIFACT_NOTE_MESSAGE_SOURCE,
          artifactEventId: eventId,
          // Only an Accord's launch is recorded as a document's origin (see
          // accordLaunchMessageIdForActor), so the note is filed under it.
          ...(launchId ? { accordLaunchMessageId: launchId } : {}),
          ...(launch ? { accordLaunch: { facilitator: launch.facilitator, members: launch.members } } : {})
        }
      } satisfies ChatMessage;
      const previousUpdatedAt = conversation.updatedAt;
      conversation.messages.push(note);
      conversation.updatedAt = new Date().toISOString();
      try {
        // The artifact outbox is acknowledged only after this promise resolves,
        // so the note must be durable rather than merely queued in memory.
        await this.chat.store.saveConversation(conversation);
      } catch (error) {
        const index = conversation.messages.findIndex((message) => message.id === note.id);
        if (index >= 0) {
          conversation.messages.splice(index, 1);
        }
        conversation.updatedAt = previousUpdatedAt;
        throw error;
      }
    });
  }

  async startAccord(
    request: StartChatAccordRequest,
    signal?: AbortSignal,
    progress?: ProgressCallback,
    runId: string = randomUUID(),
    /** The chat's main session starting it (app_chat_start_accord): the
     *  launch is its message, and the facilitator's leave to ask members is
     *  never more than the main session's own. */
    options: { author?: ChatParticipant } = {}
  ): Promise<StartChatAccordResult> {
    const warnings: string[] = [];
    const ingest = await this.chat.activeRuns.withChatRunLock(request.conversationId, async () => {
      const conversation = await this.chat.store.requireChat(request.conversationId);
      let prepared!: {
        conversation: Conversation;
        facilitator: ChatParticipant;
        userMessage: ChatMessage;
      };
      await this.chat.store.withChatMutation(conversation, async () => {
        const nowIso = new Date().toISOString();
        if (conversation.metadata.archived === true) {
          throw new Error("Archived chats cannot start an accord.");
        }
        const participants = chatParticipants(conversation);
        const facilitator = participants.find((participant) => participant.id === request.facilitatorParticipantId);
        if (!facilitator) {
          throw new Error("Accord facilitator is no longer in this chat.");
        }
        if (facilitator.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID) {
          throw new Error("The Chat Assistant cannot be an Accord facilitator or member.");
        }
        const subject = request.subject.trim();
        if (!subject) {
          throw new Error("Accord subject is required.");
        }
        const targetIds = Array.from(new Set(request.targetParticipantIds.map((id) => id.trim()).filter(Boolean)));
        if (targetIds.length === 0) {
          throw new Error("Choose at least one Accord member.");
        }
        if (targetIds.includes(facilitator.id)) {
          throw new Error("The facilitator cannot also be a selected Accord member.");
        }
        const targets = targetIds.map((id) => participants.find((participant) => participant.id === id));
        if (targets.some((target) => !target)) {
          throw new Error("One or more selected Accord members are no longer in this chat.");
        }
        const selectedTargets = targets as ChatParticipant[];
        if (selectedTargets.some((target) => target.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID)) {
          throw new Error("The Chat Assistant cannot be an Accord facilitator or member.");
        }
        const content = accordStartMessageContent(facilitator, selectedTargets, subject);
        const accordSkill = await this.resolveAccordSkillMention(conversation, facilitator, content);
        // The main session gives its facilitator leave to ask the members
        // only as far as it may ask them itself.
        const author = options.author
          ? participants.find((participant) => participant.id === options.author!.id)
          : undefined;
        if (options.author && !author) {
          throw new Error("The member starting the Accord is no longer in this chat.");
        }
        const leave: ChatParticipantRequestPermission = author
          ? normalizeChatParticipantRequestPermission(normalizeChatAgentPermissions(author.permissions).requestParticipants)
          : "allow";
        const facilitatorLeave = normalizeChatParticipantRequestPermission(normalizeChatAgentPermissions(facilitator.permissions).requestParticipants);
        // A right the facilitator already has is not taken away.
        const updatedFacilitator = author && chatParticipantRequestPermissionRank(facilitatorLeave) >= chatParticipantRequestPermissionRank(leave)
          ? facilitator
          : this.chat.requestGrants.setParticipantRequestPermission(conversation, facilitator.id, leave) ?? facilitator;
        const metadata: ChatMessageMetadata = {
          threadId: randomUUID(),
          skillMentions: [accordSkill],
          // The facilitator is asked by this device, not by the server.
          askedParticipantIds: [facilitator.id],
          ...(author ? { accordLaunchByMainSession: true } : {})
        };
        const userMessage = author
          ? createChatMessage("participant", content, { id: author.id, kind: author.kind, label: `@${author.handle}`, model: author.model }, metadata)
          : createChatMessage("user", content, undefined, metadata);
        userMessage.metadata = { ...userMessage.metadata, threadId: userMessage.id };
        conversation.messages.push(userMessage);
        if (author) {
          recordLastMessageByParticipant(conversation, userMessage);
        } else {
          this.chat.promptSuggestions.suggestions.userMessageSent(conversation.id);
        }
        advanceAutoWatchCursorForDirectTargets(conversation, [updatedFacilitator], userMessage);
        conversation.updatedAt = nowIso;
        await this.chat.store.saveConversation(conversation);
        prepared = { conversation, facilitator: updatedFacilitator, userMessage };
      });
      return prepared;
    });

    emitProgress(runId, progress, "initial", `Starting accord with @${ingest.facilitator.handle}.`, {
      total: 1,
      completed: 0
    });
    const dispatchPromise = this.chat.participantBatch.runParticipantBatch(
      ingest.conversation,
      [ingest.facilitator],
      ingest.userMessage,
      runId,
      signal,
      progress,
      warnings,
      { targetRunIds: new Map([[ingest.facilitator.id, runId]]) }
    );
    void dispatchPromise
      .then(() => {
        emitProgress(runId, progress, "done", "Accord facilitator finished.", {
          completed: 1,
          total: 1
        });
      })
      .catch(async (error) => {
        emitChatRunFailure(runId, progress, error);
      });
    return {
      runId,
      sourceMessageId: ingest.userMessage.id
    };
  }

  private async resolveAccordSkillMention(
    conversation: Conversation,
    facilitator: ChatParticipant,
    content: string
  ): Promise<ChatSkillMention> {
    if (!this.deps.userSkills) {
      throw new Error("Accord skill selection is unavailable.");
    }
    const searchContent = `@${facilitator.handle} /accord`;
    const accordSkill = await this.findAccordSkillForParticipant(conversation, facilitator, searchContent);
    if (!accordSkill) {
      throw new Error(`The /accord skill is not runnable by @${facilitator.handle}.`);
    }
    const validation = await this.deps.userSkills.validateMentionForParticipant(
      accordSkill,
      facilitator.kind,
      userSkillRunContext(conversation, content),
      facilitator.id
    );
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    return validation.mention;
  }

  async findAccordSkillForParticipant(
    conversation: Conversation,
    participant: ChatParticipant,
    content: string,
    context?: ChatDispatchReplyContext
  ): Promise<ChatSkillMention | undefined> {
    if (!this.deps.userSkills) {
      return undefined;
    }
    const searchContent = `@${participant.handle} /accord`;
    const searchContext = userSkillRunContext(conversation, content || searchContent, context);
    const result = await this.deps.userSkills.search({
      conversationId: conversation.id,
      repoPath: conversation.repoPath,
      query: "accord",
      content: searchContent,
      limit: 20
    }, searchContext);
    return result.skills.find((skill) =>
      skill.frontmatterName === "accord" &&
      skill.capabilityState === "invocable" &&
      skill.variants.some((variant) => variant.providerKind === participant.kind && variant.capabilityState === "invocable")
    );
  }
}
