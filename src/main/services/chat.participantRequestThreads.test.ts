import assert from "node:assert/strict";
import test from "node:test";
import {
  chatInferredParticipantRequestBatchesByTrigger,
  chatMessageHiddenFromTimeline,
  chatMessageVisualThreadRootId,
  chatParticipantRequestReplyRootMap,
  inferredParticipantRequestSourceRootId,
  participantRequestVisibleRootId
} from "../../shared/chatParticipantRequestThreads";
import type { ChatMessage, ChatParticipantRequestBatch, ChatParticipantRequestStatus, Conversation } from "../../shared/types";

const NOW = "2026-05-19T12:00:00.000Z";

test("explicit participant request remains visible and roots replies to its carrier", () => {
  const request = participantRequestMessage("explicit-request", "mcp", {
    requesterHandle: "drew",
    targets: ["taylor"],
    triggerMessageId: "source-message",
    replyIds: ["explicit-reply"]
  });
  const reply = participantMessage("explicit-reply", "participant-taylor", "Explicit reply.", {
    threadId: "explicit-request",
    parentMessageId: "explicit-request",
    chatThreadRootId: "explicit-request",
    sourceMessageId: "explicit-request"
  });
  const conversation = conversationWithMessages([request, reply]);
  const replyRoots = chatParticipantRequestReplyRootMap(conversation);

  assert.equal(inferredParticipantRequestSourceRootId(conversation.messages, request), undefined);
  assert.equal(participantRequestVisibleRootId(conversation.messages, request), "explicit-request");
  assert.equal(chatMessageHiddenFromTimeline(conversation, request), false);
  assert.equal(chatMessageVisualThreadRootId(conversation, request, replyRoots), undefined);
  assert.equal(chatMessageVisualThreadRootId(conversation, reply, replyRoots), "explicit-request");
});

test("top-level inferred participant request uses the source message as visual root", () => {
  const source = participantMessage("source-message", "participant-drew", "Taylor should check this.");
  const request = participantRequestMessage("inferred-request", "inferred", {
    requesterHandle: "drew",
    targets: ["taylor"],
    triggerMessageId: source.id,
    replyIds: ["target-reply"]
  });
  const reply = participantMessage("target-reply", "participant-taylor", "Reviewed.", {
    threadId: source.id,
    parentMessageId: request.id,
    chatThreadRootId: request.id,
    sourceMessageId: request.id
  });
  const conversation = conversationWithMessages([source, request, reply]);
  const replyRoots = chatParticipantRequestReplyRootMap(conversation);

  assert.equal(inferredParticipantRequestSourceRootId(conversation.messages, request), source.id);
  assert.equal(participantRequestVisibleRootId(conversation.messages, request), source.id);
  assert.equal(chatMessageHiddenFromTimeline(conversation, request), true);
  assert.equal(chatMessageVisualThreadRootId(conversation, request, replyRoots), source.id);
  assert.equal(chatMessageVisualThreadRootId(conversation, reply, replyRoots), source.id);
});

test("participant request root map overrides stale reply metadata for unmigrated inferred data", () => {
  const source = participantMessage("source-message", "participant-drew", "Taylor should check this.", {
    threadId: "outer-thread",
    parentMessageId: "outer-root",
    chatThreadRootId: "outer-root"
  });
  const request = participantRequestMessage("legacy-inferred-request", "inferred", {
    requesterHandle: "drew",
    targets: ["taylor"],
    triggerMessageId: source.id,
    replyIds: ["target-reply"]
  }, {
    threadId: "outer-thread",
    parentMessageId: source.id,
    sourceMessageId: source.id
  });
  const reply = participantMessage("target-reply", "participant-taylor", "Reviewed.", {
    threadId: "outer-thread",
    parentMessageId: request.id,
    chatThreadRootId: request.id,
    sourceMessageId: request.id
  });
  const conversation = conversationWithMessages([source, request, reply]);
  const replyRoots = chatParticipantRequestReplyRootMap(conversation);

  assert.equal(reply.metadata?.chatThreadRootId, request.id);
  assert.equal(replyRoots.get(reply.id), "outer-root");
  assert.equal(chatMessageVisualThreadRootId(conversation, reply, replyRoots), "outer-root");
});

test("multi-target inferred batches map replies and lifecycle status to the source message", () => {
  const source = participantMessage("source-message", "participant-drew", "Taylor and Casey should check this.");
  const request = participantRequestMessage("inferred-request", "inferred", {
    requesterHandle: "drew",
    targets: ["taylor", "casey"],
    triggerMessageId: source.id,
    status: "running",
    itemStatuses: ["answered", "running"],
    replyIds: ["taylor-reply", "casey-reply"]
  });
  const taylorReply = participantMessage("taylor-reply", "participant-taylor", "Taylor reviewed.", {
    threadId: source.id,
    parentMessageId: request.id,
    chatThreadRootId: request.id,
    sourceMessageId: request.id
  });
  const caseyReply = participantMessage("casey-reply", "participant-casey", "Casey is reviewing.", {
    threadId: source.id,
    parentMessageId: request.id,
    chatThreadRootId: request.id,
    sourceMessageId: request.id
  });
  const conversation = conversationWithMessages([source, request, taylorReply, caseyReply]);
  const replyRoots = chatParticipantRequestReplyRootMap(conversation);
  const batches = chatInferredParticipantRequestBatchesByTrigger(conversation).get(source.id) ?? [];

  assert.deepEqual([replyRoots.get(taylorReply.id), replyRoots.get(caseyReply.id)], [source.id, source.id]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].status, "running");
  assert.deepEqual(batches[0].items.map((item) => item.status), ["answered", "running"]);
});

function conversationWithMessages(messages: ChatMessage[]): Pick<Conversation, "messages"> {
  return { messages };
}

function participantMessage(id: string, participantId: string, content: string, metadata: ChatMessage["metadata"] = {}): ChatMessage {
  return {
    id,
    role: "participant",
    participantId,
    participantLabel: `@${participantId.replace(/^participant-/, "")}`,
    content,
    createdAt: NOW,
    status: "done",
    metadata
  };
}

function participantRequestMessage(
  id: string,
  source: ChatParticipantRequestBatch["source"],
  options: {
    requesterHandle: string;
    targets: string[];
    triggerMessageId?: string;
    status?: ChatParticipantRequestStatus;
    itemStatuses?: ChatParticipantRequestStatus[];
    replyIds?: string[];
  },
  metadata: Omit<NonNullable<ChatMessage["metadata"]>, "participantRequest"> = {}
): ChatMessage {
  return {
    id,
    role: "participant",
    participantId: `participant-${options.requesterHandle}`,
    participantLabel: `@${options.requesterHandle}`,
    content: options.targets.map((target) => `@${target}`).join(", "),
    createdAt: NOW,
    status: "done",
    metadata: {
      ...metadata,
      participantRequest: {
        id: `${id}-batch`,
        requesterParticipantId: `participant-${options.requesterHandle}`,
        requesterHandle: options.requesterHandle,
        source,
        resumeRequester: source === "inferred",
        status: options.status ?? "answered",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: options.triggerMessageId,
        items: options.targets.map((target, index) => ({
          targetParticipantId: `participant-${target}`,
          targetHandle: target,
          prompt: `Review as ${target}.`,
          status: options.itemStatuses?.[index] ?? "answered",
          replyMessageId: options.replyIds?.[index],
          createdAt: NOW,
          updatedAt: NOW
        }))
      }
    }
  };
}
