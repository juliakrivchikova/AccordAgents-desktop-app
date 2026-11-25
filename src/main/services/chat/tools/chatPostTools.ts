import { randomUUID } from "node:crypto";
import type {
  ChatAccordResolutionMetadata, ChatInterimPost, ChatMessage, ChatMessageMetadata, ChatParticipantRequestBatch, Conversation,
  ToggleChatReactionRequest, DismissTurnFinishedNoteRequest
} from "../../../../shared/types";
import {
  CHAT_INTERIM_POSTS_MAX, CHAT_INTERIM_POSTS_MAX_CHARS, chatInterimPostsCharCount, chatInterimPostsOf
} from "../../../../shared/interimPosts";
import { turnFinishedNoteOf } from "../../../../shared/turnFinishedNoteSource";
import { normalizeChatReactionEmoji } from "../../../../shared/chatReactions";
import { APP_CHAT_SEND_MESSAGE_TOOL } from "../../appMcp";
import { formatBytes } from "../attachments/imageRecords";
import { CHAT_IMAGE_MAX_ATTACHMENTS, CHAT_IMAGE_MAX_BYTES } from "../constants";
import { chatParticipants } from "../members/identity";
import { recordLastMessageByParticipant } from "../store/lastMessages";
import { markChatMessageRemoved } from "../store/mergeStoredChat";
import { addConversationWarning, findMessageRecord } from "../store/messages";
import { normalizeChatReactionRequest, normalizeChatSendMessageRequest, toggleReactionOnMessage } from "./toolInputs";
import type { ChatReactionMutationResult } from "./types";
import type { ChatAppMcpActor } from "../types";
import type { ChatModules } from "../modules";
import type { ChatDependencies } from "../dependencies";

const CHAT_SEND_MESSAGE_MAX_PER_RUN = 12;
const CHAT_SEND_MESSAGE_MAX_IMAGE_BYTES_PER_RUN = CHAT_IMAGE_MAX_ATTACHMENTS * CHAT_IMAGE_MAX_BYTES;

/** Posts and reactions: members' app tools and the User's own. */
export class ChatPostTools {
  readonly appSendMessageCountsByRun = new Map<string, number>();
  readonly appSendMessageImageBytesByRun = new Map<string, number>();

  constructor(
    private readonly chat: Pick<
      ChatModules,
      | "activeRuns" | "attachments" | "inferredRequests" | "participantRequests" | "pendingReplies" | "store"
    >,
    private readonly deps: Pick<ChatDependencies, "debugLogs" | "storage">
  ) {}

  async toggleReaction(request: ToggleChatReactionRequest): Promise<Conversation | undefined> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return conversation;
    }
    const emoji = normalizeChatReactionEmoji(request.emoji);
    await this.chat.store.withChatMutation(conversation, async () => {
      const messageRecord = findMessageRecord(conversation, request.messageId);
      if (!messageRecord) {
        throw new Error("Message was not found in this conversation.");
      }
      const result = toggleReactionOnMessage(conversation, messageRecord.message, messageRecord.sequence, emoji, {
        actorId: "user",
        actorLabel: "User",
        actorKind: "user"
      });
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
      return result;
    });
    return conversation;
  }

  /** The User takes a turn-finished note away. Its removal goes to her
   *  server like any message's, so the note leaves every device; nothing but
   *  a note can be removed this way. */
  async dismissTurnFinishedNote(request: DismissTurnFinishedNoteRequest): Promise<void> {
    const conversation = await this.deps.storage.getConversation(request.conversationId);
    if (!conversation || conversation.kind !== "chat") {
      return;
    }
    await this.chat.store.withChatMutation(conversation, async () => {
      const index = conversation.messages.findIndex((message) => message.id === request.messageId);
      if (index < 0 || !turnFinishedNoteOf(conversation.messages[index])) {
        return;
      }
      conversation.messages.splice(index, 1);
      markChatMessageRemoved(conversation, request.messageId);
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
    });
  }

  async reactToMessageFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    const request = normalizeChatReactionRequest(rawRequest);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    let result: ChatReactionMutationResult | undefined;
    await this.chat.store.withChatMutation(conversation, async () => {
      const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
      if (!requester) {
        throw new Error("The requesting member is no longer in this chat.");
      }
      const messageRecord = findMessageRecord(conversation, request.messageId);
      if (!messageRecord || (typeof actor.snapshotMaxSequence === "number" && messageRecord.sequence > actor.snapshotMaxSequence)) {
        throw new Error(
          "MessageReactionDenied. Problem: messageId was not found in the visible chat snapshot. Cause: the id is wrong, belongs to another conversation, or is newer than this turn. Fix: call app_chat_read_messages and retry with a returned message id."
        );
      }
      result = toggleReactionOnMessage(conversation, messageRecord.message, messageRecord.sequence, request.emoji, {
        actorId: requester.id,
        actorLabel: `@${requester.handle}`,
        actorKind: "participant"
      });
      conversation.updatedAt = new Date().toISOString();
      this.chat.store.queueSnapshot(conversation);
    });
    if (!result) {
      throw new Error("Reaction was not applied.");
    }
    return {
      ok: true,
      status: result.status,
      messageId: result.messageId,
      sequence: result.sequence,
      emoji: result.emoji,
      author: result.author,
      contentPreview: result.contentPreview,
      reactions: result.reactions
    };
  }

  // Post a normal participant message authored by the requester. The created message is a
  // `done` message (unlike a run's pending final bubble), so other participants can react to
  // it immediately. Critically, the requester's snapshot is bumped to include the new message
  // so the facilitator can re-read and self-react to it in the same run (publish -> self-✅).
  async sendChatMessageFromTool(actor: ChatAppMcpActor, rawRequest: unknown): Promise<Record<string, unknown>> {
    const request = normalizeChatSendMessageRequest(rawRequest);
    const conversation = await this.chat.store.requireChat(actor.conversationId);
    if (actor.runId) {
      const sent = this.appSendMessageCountsByRun.get(actor.runId) ?? 0;
      if (sent >= CHAT_SEND_MESSAGE_MAX_PER_RUN) {
        throw new Error(
          `ChatSendMessageDenied. Problem: this turn already sent the maximum of ${CHAT_SEND_MESSAGE_MAX_PER_RUN} messages. Cause: a loop or repeated publish. Fix: stop publishing and report status.`
        );
      }
    }
    const preparedImages = await this.chat.attachments.prepareToolImageAttachments(conversation, actor, request.attachments);
    if (actor.runId && preparedImages.totalBytes > 0) {
      const currentBytes = this.appSendMessageImageBytesByRun.get(actor.runId) ?? 0;
      if (currentBytes + preparedImages.totalBytes > CHAT_SEND_MESSAGE_MAX_IMAGE_BYTES_PER_RUN) {
        await this.chat.attachments.rollbackPreparedImageAttachments(conversation.id, preparedImages, "AttachmentImportDenied", "per-run image byte limit exceeded");
        throw new Error(
          `AttachmentImportDenied. Problem: this turn already imported too many image bytes. Cause: app_chat_send_message accepts at most ${formatBytes(CHAT_SEND_MESSAGE_MAX_IMAGE_BYTES_PER_RUN)} of images per run. Fix: send fewer or smaller images.`
        );
      }
    }
    let created: { id: string; sequence: number; threadId?: string; postId?: string } | undefined;
    let participantRequestsToRun: Array<{
      requestMessageId: string;
      depth: number;
      source: ChatParticipantRequestBatch["source"];
    }> = [];
    try {
      await this.chat.store.withChatMutation(conversation, async () => {
        const requester = chatParticipants(conversation).find((participant) => participant.id === actor.participantId);
        if (!requester) {
          throw new Error("The requesting member is no longer in this chat.");
        }
        // Resolve and validate the visible scope. parent/root, when provided, must be a message
        // visible to this turn; an invisible/wrong-conversation id is rejected.
        const resolveVisible = (id: string | undefined, label: string): string | undefined => {
          if (!id) {
            return undefined;
          }
          const record = findMessageRecord(conversation, id);
          if (!record || (typeof actor.snapshotMaxSequence === "number" && record.sequence > actor.snapshotMaxSequence)) {
            throw new Error(
              `ChatSendMessageDenied. Problem: ${label} is not visible to this turn. Cause: the id is wrong, belongs to another conversation, or is newer than this turn. Fix: use an id returned by app_chat_read_messages.`
            );
          }
          return id;
        };
        const parentMessageId = resolveVisible(request.parentMessageId, "parentMessageId");
        const chatThreadRootId = resolveVisible(request.chatThreadRootId, "chatThreadRootId");
        // An explicit threadId must also be a visible scope: it has to match a visible message's
        // id (a thread root) or the threadId of some visible message. Otherwise a participant could
        // post into an arbitrary thread id string. When omitted, derive it from visible context.
        const resolveVisibleThreadId = (threadId: string | undefined): string | undefined => {
          if (!threadId) {
            return undefined;
          }
          const visible = conversation.messages.some((message, sequence) => {
            if (typeof actor.snapshotMaxSequence === "number" && sequence > actor.snapshotMaxSequence) {
              return false;
            }
            return message.id === threadId || message.metadata?.threadId === threadId;
          });
          if (!visible) {
            throw new Error(
              "ChatSendMessageDenied. Problem: threadId is not a visible thread in this turn. Cause: the id is wrong, belongs to another conversation, or is newer than this turn. Fix: use a threadId/messageId returned by app_chat_read_messages, or omit it."
            );
          }
          return threadId;
        };
        const threadId = resolveVisibleThreadId(request.threadId)
          ?? actor.triggerThreadId ?? parentMessageId ?? chatThreadRootId;
        // During the member's own turn, in the turn's own place, the post is
        // part of its running reply (interimPosts.ts), as text a CLI writes
        // between its tool calls is part of its answer.
        const reply = this.runningReplyForPost(conversation, actor, request);
        if (reply) {
          const position = actor.runId ? this.chat.pendingReplies.liveRunPositions.get(actor.runId)?.() : undefined;
          const post: ChatInterimPost = {
            id: randomUUID(),
            content: request.content,
            createdAt: new Date().toISOString(),
            ...(position ? { afterContentLength: position.contentLength, afterActivitySequence: position.activitySequence } : {}),
            ...(preparedImages.attachments.length > 0 ? { attachmentIds: preparedImages.attachments.map((attachment) => attachment.id) } : {})
          };
          const replyMetadata: ChatMessageMetadata = reply.message.metadata ?? {};
          reply.message.metadata = {
            ...replyMetadata,
            interimPosts: [...chatInterimPostsOf(reply.message), post],
            ...(preparedImages.attachments.length > 0
              ? { imageAttachments: [...(replyMetadata.imageAttachments ?? []), ...preparedImages.attachments] }
              : {})
          };
          // The reply is the post's message now: readable (and reactable) by
          // the same run, as a posted message was.
          if (typeof actor.snapshotMaxSequence === "number" && reply.sequence > actor.snapshotMaxSequence) {
            actor.snapshotMaxSequence = reply.sequence;
          }
          participantRequestsToRun = await this.chat.inferredRequests.inferParticipantRequestsFromInterimPost(conversation, requester, reply.message, post, actor);
          conversation.updatedAt = new Date().toISOString();
          this.chat.store.queueSnapshot(conversation);
          created = { id: reply.message.id, sequence: reply.sequence, threadId: reply.message.metadata?.threadId, postId: post.id };
          return;
        }
        const message: ChatMessage = {
          id: randomUUID(),
          role: "participant",
          participantId: requester.id,
          participantLabel: `@${requester.handle}`,
          content: request.content,
          createdAt: new Date().toISOString(),
          status: "done",
          metadata: {
            threadId,
            parentMessageId,
            chatThreadRootId,
            appMessageSource: APP_CHAT_SEND_MESSAGE_TOOL,
            accordResolution: request.accordResolution,
            runId: actor.runId,
            turnSegmentId: actor.turnSegmentId,
            participantRequestDepth: actor.participantRequestDepth ?? 0,
            participantRequestBatchId: actor.participantRequestBatchId,
            participantRequestChainRootId: actor.chainRootId,
            ...(preparedImages.attachments.length > 0 ? { imageAttachments: preparedImages.attachments } : {})
          }
        };
        conversation.messages.push(message);
        recordLastMessageByParticipant(conversation, message);
        const sequence = conversation.messages.length - 1;
        // P0-1: make the new message visible to this same run so publish -> self-read /
        // self-react works. The actor object is the stored token grant reference, so this
        // bump persists for the rest of the turn.
        if (typeof actor.snapshotMaxSequence === "number" && sequence > actor.snapshotMaxSequence) {
          actor.snapshotMaxSequence = sequence;
        }
        try {
          participantRequestsToRun = await this.chat.inferredRequests.createImplicitParticipantRequestApproval(
            conversation,
            requester,
            [message]
          );
        } catch (error) {
          participantRequestsToRun = [];
          addConversationWarning(
            conversation,
            `Participant mentions in @${requester.handle}'s message were not triggered because inferred-request processing failed.`
          );
          void this.deps.debugLogs.write("chat.participant-request.inferred-tool-error", {
            conversationId: conversation.id,
            messageId: message.id,
            requesterParticipantId: requester.id,
            requesterHandle: requester.handle,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        conversation.updatedAt = new Date().toISOString();
        this.chat.store.queueSnapshot(conversation);
        created = { id: message.id, sequence, threadId };
      });
    } catch (error) {
      await this.chat.attachments.rollbackPreparedImageAttachments(conversation.id, preparedImages, "ChatSendMessageFailed", error);
      throw error;
    }
    if (!created) {
      throw new Error("Message was not created.");
    }
    if (actor.runId) {
      this.appSendMessageCountsByRun.set(actor.runId, (this.appSendMessageCountsByRun.get(actor.runId) ?? 0) + 1);
      if (preparedImages.totalBytes > 0) {
        this.appSendMessageImageBytesByRun.set(
          actor.runId,
          (this.appSendMessageImageBytesByRun.get(actor.runId) ?? 0) + preparedImages.totalBytes
        );
      }
    }
    this.chat.participantRequests.startDeferredParticipantRequestRunners(conversation.id, participantRequestsToRun);
    return {
      ok: true,
      messageId: created.id,
      sequence: created.sequence,
      threadId: created.threadId,
      // In the running reply: messageId is that reply's, postId this post's.
      ...(created.postId
        ? {
            postId: created.postId,
            postedInto: "running-reply",
            note: "Posted inside your running reply: messageId is that reply's, so app_chat_react with it reacts to your whole reply, not to this post alone."
          }
        : {}),
      ...(preparedImages.summaries.length > 0 ? { imageAttachments: preparedImages.summaries } : {})
    };
  }

  /**
   * The actor's running reply a post goes into: its turn's pending reply in
   * this chat, when the post is for the turn's own place (no other thread,
   * parent or thread root asked for) and is not an Accord's resolution, which
   * others react to as a message of its own. None when the turn has ended
   * (a post that arrives after it is a message, as before), and none when
   * the reply's posts are full (interimPosts.ts caps): the post is a message
   * then.
   */
  private runningReplyForPost(
    conversation: Conversation,
    actor: ChatAppMcpActor,
    request: { content: string; threadId?: string; parentMessageId?: string; chatThreadRootId?: string; accordResolution?: ChatAccordResolutionMetadata }
  ): { message: ChatMessage; sequence: number } | undefined {
    const runId = actor.runId;
    if (!runId || request.accordResolution) {
      return undefined;
    }
    const pendingMessageId = this.chat.activeRuns.chatRunMeta.get(runId)?.pendingMessageId;
    let sequence = -1;
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index];
      if (message.role !== "participant" || message.status !== "pending" || message.participantId !== actor.participantId ||
        message.metadata?.runId !== runId || message.metadata?.serverPlaceholder) {
        continue;
      }
      if (sequence < 0) sequence = index;
      if (!pendingMessageId || message.id === pendingMessageId) {
        sequence = index;
        break;
      }
    }
    if (sequence < 0) {
      return undefined;
    }
    const message = conversation.messages[sequence];
    const samePlace = (requested: string | undefined, own: string | undefined) => !requested || requested === own;
    if (!samePlace(request.threadId, message.metadata?.threadId) ||
      !samePlace(request.parentMessageId, message.metadata?.parentMessageId) ||
      !samePlace(request.chatThreadRootId, message.metadata?.chatThreadRootId)) {
      return undefined;
    }
    const posts = chatInterimPostsOf(message);
    if (posts.length >= CHAT_INTERIM_POSTS_MAX || chatInterimPostsCharCount(posts) + request.content.length > CHAT_INTERIM_POSTS_MAX_CHARS) {
      return undefined;
    }
    return { message, sequence };
  }
}
