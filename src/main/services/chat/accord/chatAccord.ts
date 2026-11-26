import { isMainSessionChat, isMainSessionParticipant } from "../../../../shared/mainSession";
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
import { accordFromAnySessionOn } from "../../../../shared/newChatDefaults";
import { advanceAutoWatchCursorForDirectTargets } from "../autoWatch/watchers";
import { accordStartMessageContent, participantForMentionHandle, userSkillRunContext } from "../choices/mentions";
import { CHAT_ADMINISTRATOR_ROLE_ID } from "../constants";
import { chatParticipants, participantForRun } from "../members/identity";
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
      | "activeRuns" | "delegation" | "host" | "participantBatch" | "promptSuggestions" | "requestGrants" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "onReviewProgress" | "settings" | "storage" | "userSkills">
  ) {}

  /** Settings → General → New chats → "Any agent can start an Accord", as it
   *  is now (a machine: as the computer that set it up published it): every
   *  member starts one, not only the main session (the User, 2026-11-26). */
  async accordFromAnySession(): Promise<boolean> {
    return accordFromAnySessionOn((await this.deps.settings.getPublicSettings()).newChatDefaults);
  }

  /** Whether this member starts an Accord with app_chat_start_accord now: the
   *  main session does; another member only while the User's switch is on
   *  (its tools were given at the start of its turn, the switch is read now). */
  private async startsAccord(conversation: Conversation, actor: ChatAppMcpActor): Promise<boolean> {
    if (!hasChatAppToolCapability(actor.capabilities, "accord.start")) return false;
    return isMainSessionParticipant(conversation.metadata, actor.participantId) || await this.accordFromAnySession();
  }

  /**
   * A member starts an Accord (app_chat_start_accord, docs/main-session.md):
   * the main session, or any member while the User's switch is on. The same
   * launch as the User's, written as that member's message. The facilitator
   * defaults to the member that starts it.
   */
  async startAccordFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    await this.chat.store.waitForQueuedSave(actor.conversationId);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    const caller = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
    if (!caller) {
      throw new Error("The requesting member is no longer in this chat.");
    }
    this.chat.host.assertOwnsParticipant(caller);
    if (!await this.startsAccord(conversation, actor)) {
      return delegationRefusal("not_main_session", isMainSessionChat(conversation.metadata)
        ? "Only the chat's main session starts an Accord now. Ask the main session for one."
        : "Starting an Accord is not open to you now. Ask User for one.");
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
        members: members.map((member) => `@${member.handle}`),
        // Leading it itself, the member runs it in the turn the launch starts,
        // after this one; begun here it would have no card.
        ...(facilitator.id === caller.id
          ? { next: "You lead it. Your Accord turn starts from the launch once this turn ends: end this turn now and do not run the Accord in it." }
          : {})
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
  async accordLaunchMessageIdForActor(actor: ChatAppMcpActor, loaded?: Conversation): Promise<string | undefined> {
    const conversation = loaded ?? await this.chat.store.requireChat(actor.conversationId);
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

  /**
   * Where a new draft collection is filed, so its Accord shows as one card
   * (the User, 2026-11-26: an Accord looks the same whether she starts it or
   * the main session does): under the launch the member's turn runs for
   * (accordLaunchMessageIdForActor), else under the chat's newest launch when
   * the member leads it, it is open and no document is filed under it yet --
   * the Accord the member is running though its turn's trigger is another
   * message (her message joined the running step and took the turn's tools
   * along, or the launch's turn ended before the document and she said to go
   * on). A member that starts Accords (the main session; any member while
   * the User's "Any agent can start an Accord" is on) is refused one outside
   * any launch: an Accord it ran by itself would have no card, and its every
   * step would stand in the chat as a note of its own. It starts one with
   * app_chat_start_accord, as her Accord button does.
   */
  async accordCollectionOrigin(actor: ChatAppMcpActor): Promise<AccordCollectionOrigin> {
    let conversation: Conversation;
    let originMessageId: string | undefined;
    try {
      // One read of the chat for every question: a long chat is costly to load.
      conversation = await this.chat.store.requireChat(actor.conversationId);
      originMessageId = await this.accordLaunchMessageIdForActor(actor, conversation);
    } catch (error) {
      // The chat could not be read: filed under nothing, as before, rather
      // than refused for a reason that is not the member's.
      void this.deps.debugLogs.write("chat.accord.collection-origin-unread", {
        conversationId: actor.conversationId,
        participantId: actor.participantId,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
      return {};
    }
    if (originMessageId) {
      return { originMessageId };
    }
    const participant = chatParticipants(conversation).find((candidate) => candidate.id === actor.participantId);
    const open = participant ? openLaunchLedBy(conversation, normalizeArtifactMember(participant.handle)) : undefined;
    if (open) {
      return { originMessageId: open };
    }
    // Refused only where the way it is pointed to is open to it.
    if (!await this.startsAccord(conversation, actor)) {
      return {};
    }
    return {
      refusal: {
        code: "accord_not_launched",
        message: "An Accord is started with app_chat_start_accord, not run ad hoc: call it with the members and the subject "
          + "and end this turn. The app posts the Accord's card and your Accord turn starts from it."
      }
    };
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
    /** The member starting it (app_chat_start_accord): the launch is its
     *  message, and the facilitator's leave to ask members is never more than
     *  that member's own. */
    options: { author?: ChatParticipant } = {}
  ): Promise<StartChatAccordResult> {
    const warnings: string[] = [];
    // Agents-list CLIs with no member yet (a chat with a main session) become
    // members as for a delegated task: probed before the chat's queue, added
    // inside it with the launch, so a refused launch adds nobody.
    const providerKinds = [...new Set(request.targetProviderKinds ?? [])];
    const newAgents = providerKinds.length > 0
      ? await this.chat.delegation.prepareAccordMembers(await this.chat.store.requireChat(request.conversationId), providerKinds)
      : undefined;
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
        if (targetIds.length === 0 && !newAgents) {
          throw new Error("Choose at least one Accord member.");
        }
        if (targetIds.includes(facilitator.id)) {
          throw new Error("The facilitator cannot also be a selected Accord member.");
        }
        const targets = targetIds.map((id) => participants.find((participant) => participant.id === id));
        if (targets.some((target) => !target)) {
          throw new Error("One or more selected Accord members are no longer in this chat.");
        }
        if ((targets as ChatParticipant[]).some((target) => target.roleConfigId === CHAT_ADMINISTRATOR_ROLE_ID)) {
          throw new Error("The Chat Assistant cannot be an Accord facilitator or member.");
        }
        const selectedTargets = [
          ...targets as ChatParticipant[],
          ...newAgents ? await this.chat.delegation.addAccordMembers(conversation, newAgents) : []
        ];
        // The member gives its facilitator leave to ask the members only as
        // far as it may ask them itself, as it runs now (a member another
        // member added: never above the main session's).
        const author = options.author
          ? participants.find((participant) => participant.id === options.author!.id)
          : undefined;
        if (options.author && !author) {
          throw new Error("The member starting the Accord is no longer in this chat.");
        }
        const leave: ChatParticipantRequestPermission = author
          ? normalizeChatParticipantRequestPermission(normalizeChatAgentPermissions(participantForRun(conversation, author).permissions).requestParticipants)
          : "allow";
        const facilitatorLeave = normalizeChatParticipantRequestPermission(normalizeChatAgentPermissions(facilitator.permissions).requestParticipants);
        // A right the facilitator already has is not taken away.
        const keepsOwn = Boolean(author) && chatParticipantRequestPermissionRank(facilitatorLeave) >= chatParticipantRequestPermissionRank(leave);
        const content = accordStartMessageContent(facilitator, selectedTargets, subject, keepsOwn ? facilitatorLeave : leave);
        const accordSkill = await this.resolveAccordSkillMention(conversation, facilitator, content);
        const updatedFacilitator = keepsOwn
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

/** Where a new draft collection is filed, or why it is refused (ChatAccord.accordCollectionOrigin). */
export interface AccordCollectionOrigin {
  originMessageId?: string;
  refusal?: { code: string; message: string };
}

/** The chat's newest Accord launch, when the member leads it, it is not
 *  folded away and no document is filed under it yet. Only the newest: an
 *  older launch is never reached back for. */
function openLaunchLedBy(conversation: Conversation, handle: string): string | undefined {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index]!;
    const card = accordLaunchCardForMessage(message);
    if (!card) continue;
    if (normalizeArtifactMember(card.facilitator) !== handle || accordClosedLaunchIds(conversation.messages).includes(message.id)) {
      return undefined;
    }
    return conversation.messages.some((other) => other.metadata?.accordLaunchMessageId === message.id) ? undefined : message.id;
  }
  return undefined;
}
