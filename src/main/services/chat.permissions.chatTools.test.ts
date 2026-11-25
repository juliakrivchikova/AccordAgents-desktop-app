import assert from "node:assert/strict";
import test from "node:test";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { commitPromptContextPointerAdvance } from "./chat/turns/promptContextRecords";
import { CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT } from "../../shared/chatParticipantRequests";
import { CHAT_INTERIM_POSTS_MAX_CHARS } from "../../shared/interimPosts";
import type { ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import {
  chatConversation, chatParticipant, clone, completeParticipantRequest, inferredRequestMessages, liveTurn, NOW,
  participantReplyMessage, participantRequestActor, pendingParticipantMessage, runningReply, testService, turnActor
} from "./chat/test/permissionFixtures";

test("toggleReaction adds and removes a user reaction on a message", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const added = await service.toggleReaction({
    conversationId: conversation.id,
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(added?.messages[0].metadata?.reactions?.["✅"]?.length, 1);
  assert.deepEqual(added?.messages[0].metadata?.reactions?.["✅"]?.[0], {
    actorId: "user",
    actorLabel: "User",
    actorKind: "user",
    at: added?.messages[0].metadata?.reactions?.["✅"]?.[0].at
  });
  assert.equal(storage.current.messages[0].metadata.reactions["✅"][0].actorLabel, "User");

  const removed = await service.toggleReaction({
    conversationId: conversation.id,
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(removed?.messages[0].metadata?.reactions, undefined);
  assert.equal(storage.current.messages[0].metadata.reactions, undefined);
});

test("app_chat_react toggles a participant reaction and rejects unknown message ids", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: []
  };

  const added = await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(added.status, "added");
  assert.equal(added.messageId, "user-message");
  assert.equal(storage.current.messages[0].metadata.reactions["✅"][0].actorLabel, "@codex");

  const removed = await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(removed.status, "removed");
  assert.equal(storage.current.messages[0].metadata.reactions, undefined);

  await assert.rejects(
    () => service.reactToMessageFromTool(actor, {
      messageId: "missing-message",
      emoji: "✅"
    }),
    /MessageReactionDenied/
  );
});

test("app_chat_send_message publishes a participant message and lets the author read+react to it in the same run", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "accord-run-1",
    triggerThreadId: "user-message"
  };

  const sent = await service.sendChatMessageFromTool(actor, {
    content: "Canonical resolution.",
    parentMessageId: "user-message"
  });

  assert.equal(sent.ok, true);
  assert.equal(sent.sequence, 1);
  assert.equal(typeof sent.messageId, "string");
  assert.equal(storage.current.messages[1].role, "participant");
  assert.equal(storage.current.messages[1].status, "done");
  assert.equal(storage.current.messages[1].participantLabel, "@codex");
  assert.equal(storage.current.messages[1].metadata.appMessageSource, "app_chat_send_message");
  // P0-1: the author's snapshot is bumped so the new message is visible to the same run.
  assert.equal(actor.snapshotMaxSequence, 1);

  const read = await service.readChatMessagesForTool(actor, { messageId: sent.messageId });
  assert.equal((read.messages as unknown[]).length, 1);
  assert.equal((read.messages as Array<{ id: string }>)[0].id, sent.messageId);

  const reacted = await service.reactToMessageFromTool(actor, {
    messageId: sent.messageId as string,
    emoji: "✅"
  });
  assert.equal(reacted.status, "added");
  assert.equal(storage.current.messages[1].metadata.reactions["✅"][0].actorLabel, "@codex");
});

test("a post during the member's own running turn goes into its running reply, in order, and the reply stays the last message", async () => {
  const participant = chatParticipant("codex-cli");
  const reader = chatParticipant("claude-code");
  const conversation = chatConversation([participant, reader]);
  conversation.messages.push(runningReply(participant));
  const { service, storage } = testService({ conversation });
  liveTurn(service, participant);
  const actor = turnActor(participant);

  const first = await service.sendChatMessageFromTool(actor, { content: "Found the cause." });
  const second = await service.sendChatMessageFromTool(actor, { content: "Fixing it now." });

  assert.equal(storage.current.messages.length, 2, "no message of its own: the reply is still the last one");
  assert.deepEqual([first.messageId, second.messageId], ["reply-1", "reply-1"], "the reply's id comes back");
  assert.equal(first.sequence, 1);
  assert.equal(first.postedInto, "running-reply");
  assert.equal(typeof first.postId, "string");
  assert.notEqual(first.postId, second.postId);
  const reply = storage.current.messages[1] as ChatMessage;
  assert.equal(reply.status, "pending", "the turn goes on");
  assert.deepEqual(reply.metadata?.interimPosts?.map((post) => [post.id, post.content]), [
    [first.postId, "Found the cause."],
    [second.postId, "Fixing it now."]
  ]);
  assert.equal(actor.snapshotMaxSequence, 1, "the same run can read its reply now, as it read a posted message");

  // Two posts at once both land, oldest first.
  await Promise.all([
    service.sendChatMessageFromTool(actor, { content: "Third." }),
    service.sendChatMessageFromTool(actor, { content: "Fourth." })
  ]);
  const posts = (storage.current.messages[1] as ChatMessage).metadata?.interimPosts ?? [];
  assert.equal(posts.length, 4);
  assert.deepEqual(posts.slice(2).map((post) => post.content).sort(), ["Fourth.", "Third."]);
  assert.deepEqual(posts.map((post) => post.createdAt), [...posts.map((post) => post.createdAt)].sort(), "in the order they were made");

  // Another member reads them as part of the running reply.
  const read = await service.readChatMessagesForTool({ ...turnActor(reader), runId: "reader-run", snapshotMaxSequence: undefined }, { limit: 10 });
  const seen = (read.messages as Array<{ id: string; content: string; interimPosts?: Array<{ content: string }>; metadata?: Record<string, unknown> }>)
    .find((message) => message.id === "reply-1");
  assert.deepEqual(seen?.interimPosts?.map((post) => post.content).slice(0, 2), ["Found the cause.", "Fixing it now."]);
  assert.equal(seen?.content, "", "its final words are not written yet");
  assert.equal(seen?.metadata?.interimPosts, undefined, "said once, not again inside the metadata");
});

test("a member whose turn starts while another is still running reads that member's posts, as finished words with its handle, without passing its running reply", async () => {
  const participant = chatParticipant("codex-cli");
  const reader = chatParticipant("claude-code");
  const conversation = chatConversation([participant, reader]);
  conversation.messages.push(runningReply(participant));
  const { service, storage } = testService({ conversation });
  liveTurn(service, participant);
  const posted = await service.sendChatMessageFromTool(turnActor(participant), { content: "Found the cause: the token expires early." });
  assert.equal(posted.postedInto, "running-reply");
  assert.equal(typeof posted.postId, "string", "the post keeps its own id");
  assert.match(String(posted.note), /app_chat_react with it reacts to your whole reply/);

  // The User asks the other member while the first one still runs.
  const ask: ChatMessage = { id: "ask-reader", role: "user", content: "@claude what do you think?", createdAt: new Date(Date.now() + 1000).toISOString(), status: "done" };
  storage.current.messages.push(ask);
  const current = clone(storage.current) as Conversation;
  const internals = service as any;
  const prepared = await chatParts(internals).promptContext.preparePromptContextForRun(current, current, reader, ask, { type: "timeline" }, false);
  assert.match(prepared.block, /Found the cause: the token expires early\./, "the post is in its context");
  assert.match(prepared.block, new RegExp(`\\[[0-9a-f]{8} @${participant.handle}\\]\\nFound the cause`), "under the poster's handle");
  assert.equal(prepared.pointerAdvance?.entry.messageId, "ask-reader", "the running reply is not passed by its posts");
});

test("posts a member read when its turn started are not read again by its next turn, though made after the question that turn answered", async () => {
  const participant = chatParticipant("codex-cli");
  const reader = chatParticipant("claude-code");
  const conversation = chatConversation([participant, reader]);
  conversation.messages.push(runningReply(participant));
  // The User asks the other member first; its turn starts later, after a post.
  const ask: ChatMessage = { id: "ask-reader", role: "user", content: "@claude what do you think?", createdAt: new Date(Date.now() - 10_000).toISOString(), status: "done" };
  conversation.messages.push(ask);
  const { service, storage } = testService({ conversation });
  liveTurn(service, participant);
  await service.sendChatMessageFromTool(turnActor(participant), { content: "First finding." });
  const internals = service as any;
  let current = clone(storage.current) as Conversation;
  const first = await chatParts(internals).promptContext.preparePromptContextForRun(current, current, reader, ask, { type: "timeline" }, false);
  assert.match(first.block, /First finding\./, "its turn reads the post made before it started");
  commitPromptContextPointerAdvance(storage.current, reader.id, first.pointerAdvance);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.sendChatMessageFromTool(turnActor(participant), { content: "Second finding." });
  const again: ChatMessage = { id: "ask-reader-2", role: "user", content: "@claude and now?", createdAt: new Date(Date.now() + 1000).toISOString(), status: "done" };
  storage.current.messages.push(again);
  current = clone(storage.current) as Conversation;
  const second = await chatParts(internals).promptContext.preparePromptContextForRun(current, current, reader, again, { type: "timeline" }, false);
  assert.match(second.block, /Second finding\./, "a later post is read");
  assert.doesNotMatch(second.block, /First finding\./, "a post already read is not read again");
});

test("a reply's posts stop at the cap: the post that would pass it is a message of its own", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.messages.push(runningReply(participant));
  const { service, storage } = testService({ conversation });
  liveTurn(service, participant);
  const actor = turnActor(participant);
  await service.sendChatMessageFromTool(actor, { content: "x".repeat(CHAT_INTERIM_POSTS_MAX_CHARS - 10) });
  const over = await service.sendChatMessageFromTool(actor, { content: "This one is twenty+." });
  assert.notEqual(over.messageId, "reply-1");
  assert.equal(storage.current.messages.at(-1).content, "This one is twenty+.");
  assert.equal((storage.current.messages.find((item: ChatMessage) => item.id === "reply-1") as ChatMessage).metadata?.interimPosts?.length, 1);
});

for (const ending of ["done", "error", "stopped"] as const) {
  test(`a reply whose turn ends ${ending} keeps the posts made during it, though the turn held a copy of the reply without them`, async () => {
    const participant = chatParticipant("codex-cli");
    const conversation = chatConversation([participant]);
    conversation.messages.push(runningReply(participant));
    const { service, storage } = testService({ conversation });
    liveTurn(service, participant);
    // The turn's own copy of the chat, read when the turn began.
    const turnCopy = clone(storage.current) as Conversation;
    const turnReply = turnCopy.messages[1];
    await service.sendChatMessageFromTool(turnActor(participant), { content: "Found the cause." });
    await service.sendChatMessageFromTool(turnActor(participant), { content: "Fixing it now." });
    if (ending === "done") {
      turnReply.status = "done";
      turnReply.content = "Fixed: the button fits.";
      await chatParts(service).pendingReplies.finalizePendingParticipantMessage(turnCopy, participant, turnReply);
    } else if (ending === "error") {
      turnReply.status = "error";
      turnReply.content = "@codex: the CLI exited.";
      await chatParts(service).pendingReplies.finalizePendingParticipantMessage(turnCopy, participant, turnReply);
    } else {
      turnReply.status = "error";
      turnReply.content = "Stopped.";
      turnReply.metadata = { ...turnReply.metadata, terminalReason: "user-stopped" };
      await chatParts(service).participantBatch.discardStoppedTargetRun(turnCopy, "turn-run-1", participant, "reply-1");
    }
    const reply = storage.current.messages.find((item: ChatMessage) => item.id === "reply-1") as ChatMessage;
    assert.equal(reply.status, ending === "done" ? "done" : "error");
    assert.deepEqual(reply.metadata?.interimPosts?.map((post) => post.content), ["Found the cause.", "Fixing it now."]);
    assert.equal(storage.current.messages.filter((item: ChatMessage) => item.metadata?.appMessageSource === "app_turn_finished_note").length, 0,
      "nothing came below the reply: no note");
    // A copy that saw neither the posts nor the end (another flow's) cannot take them back.
    const stale = clone(conversation) as Conversation;
    await chatParts(service).store.withChatMutation(stale, async () => {
      chatParts(service).store.queueSnapshot(stale);
    });
    await chatParts(service).store.waitForQueuedSave("conversation-1");
    assert.equal((storage.current.messages.find((item: ChatMessage) => item.id === "reply-1") as ChatMessage).metadata?.interimPosts?.length, 2);
  });
}

test("app_chat_send_message infers one runnable request per mentioned target", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const { service, storage } = testService({ conversation });
  const started: Array<{ requestMessageId: string; depth: number; source: string }> = [];
  chatParts(service).participantRequests.startDeferredParticipantRequestRunners = (
    _conversationId: string,
    requests: Array<{ requestMessageId: string; depth: number; source: string }>
  ) => started.push(...requests);
  const actor = {
    ...participantRequestActor(requester),
    runId: "tool-inference-run",
    turnSegmentId: "tool-inference-segment"
  };

  const sent = await service.sendChatMessageFromTool(actor, {
    content: "@drew @drew please review this once."
  });

  const requestMessages = inferredRequestMessages(storage.current);
  assert.equal(sent.sequence, 1);
  assert.equal(storage.current.messages[1].id, sent.messageId);
  assert.equal(storage.current.messages[1].metadata.turnSegmentId, actor.turnSegmentId);
  assert.equal(requestMessages.length, 1);
  assert.deepEqual(requestMessages[0].metadata?.participantRequest?.items.map((item) => item.targetHandle), [target.handle]);
  assert.equal(requestMessages[0].metadata?.participantRequest?.status, "running");
  assert.equal(started.length, 1);
});

test("tool-post inference deduplicates completed requests within one turn segment", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const { service, storage } = testService({ conversation });
  const debugEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
  chatDependencies(service).debugLogs.write = async (event: string, payload: Record<string, unknown>) => {
    debugEntries.push({ event, payload });
  };
  const actor = {
    ...participantRequestActor(requester),
    runId: "tool-dedupe-run",
    turnSegmentId: "tool-dedupe-segment"
  };

  await service.sendChatMessageFromTool(actor, { content: "@drew please review X." });
  completeParticipantRequest(inferredRequestMessages(storage.current)[0]);
  await service.sendChatMessageFromTool(actor, { content: "@drew please review X again." });

  assert.equal(storage.current.messages.filter((message: ChatMessage) => message.metadata?.appMessageSource === "app_chat_send_message").length, 2);
  assert.equal(inferredRequestMessages(storage.current).length, 1);
  assert.equal(
    debugEntries.find((entry) => entry.event === "chat.participant-request.inferred-skipped-existing")?.payload.decidingScope,
    "tool-source-segment"
  );
});

test("single tool-post inference logs targets omitted by the four-target cap", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const targets = ["one", "two", "three", "four", "five"].map((handle, index): ChatParticipant => ({
    ...chatParticipant("claude-code"),
    id: `single-cap-target-${index}`,
    handle
  }));
  const conversation = chatConversation([requester, ...targets]);
  const { service, storage } = testService({ conversation });
  const debugEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
  chatDependencies(service).debugLogs.write = async (event: string, payload: Record<string, unknown>) => {
    debugEntries.push({ event, payload });
  };

  await service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId: "single-cap-run",
    turnSegmentId: "single-cap-segment"
  }, { content: "@one @two @three @four @five review." });

  const items = inferredRequestMessages(storage.current)
    .flatMap((message) => message.metadata?.participantRequest?.items ?? []);
  assert.deepEqual(items.map((item) => item.targetHandle), ["one", "two", "three", "four"]);
  assert.deepEqual(
    debugEntries.find((entry) => entry.event === "chat.participant-request.inferred-turn-cap")?.payload.targets,
    ["five"]
  );
});

test("tool-post inference preserves deny, ignored-text, self-mention, and depth guards", async () => {
  const target = chatParticipant("claude-code");
  const deniedRequester = chatParticipant("codex-cli", { requestParticipants: "deny" });
  const deniedConversation = chatConversation([deniedRequester, target]);
  const denied = testService({ conversation: deniedConversation });
  await denied.service.sendChatMessageFromTool({
    ...participantRequestActor(deniedRequester),
    runId: "deny-run",
    turnSegmentId: "deny-segment"
  }, { content: "@drew review this." });
  assert.equal(inferredRequestMessages(denied.storage.current).length, 0);
  assert.match(
    denied.storage.current.metadata.warnings?.[0] ?? "",
    /participant requests are disabled/i
  );

  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const ignoredConversation = chatConversation([requester, target]);
  const ignored = testService({ conversation: ignoredConversation });
  await ignored.service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId: "ignored-run",
    turnSegmentId: "ignored-segment"
  }, {
    content: [
      "@codex self",
      "> @drew quoted",
      "`@drew inline`",
      "```text",
      "@drew fenced",
      "```",
      "Participant requests:",
      "- @drew legacy request",
      "Return to requester after replies:",
      "- @drew legacy return"
    ].join("\n")
  });
  assert.equal(inferredRequestMessages(ignored.storage.current).length, 0);

  const depthConversation = chatConversation([requester, target]);
  const depth = testService({ conversation: depthConversation });
  await depth.service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId: "depth-run",
    turnSegmentId: "depth-segment",
    participantRequestDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chainRootId: "depth-chain"
  }, { content: "@drew go deeper." });
  assert.equal(depth.storage.current.messages[1].metadata.participantRequestDepth, CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT);
  assert.equal(depth.storage.current.messages[1].metadata.participantRequestChainRootId, "depth-chain");
  assert.equal(inferredRequestMessages(depth.storage.current).length, 0);
  assert.match(
    depth.storage.current.metadata.warnings?.[0] ?? "",
    /participant-request depth limit was reached/i
  );

  const finalDepthConversation = chatConversation([requester, target]);
  const finalDepth = testService({ conversation: finalDepthConversation });
  for (const id of ["depth-final-one", "depth-final-two"]) {
    const finalMessage = participantReplyMessage(requester, id, "@drew go deeper.");
    finalMessage.metadata = {
      ...finalMessage.metadata,
      participantRequestDepth: CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
      participantRequestChainRootId: "final-depth-chain"
    };
    await chatParts(finalDepth.service).pendingReplies.appendParticipantTurnMessages(
      finalDepth.storage.current,
      requester,
      [finalMessage]
    );
  }
  assert.equal(inferredRequestMessages(finalDepth.storage.current).length, 0);
  assert.equal(finalDepth.storage.current.metadata.warnings?.length, 1);
  assert.match(
    finalDepth.storage.current.metadata.warnings?.[0] ?? "",
    /participant-request depth limit was reached/i
  );
});

test("app_chat_send_message preserves exact content and rejects (never truncates) over-limit content", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "accord-exact-1"
  };

  const exact = "\n  Leading and trailing whitespace and\n\nblank lines are preserved.  \n";
  const sent = await service.sendChatMessageFromTool(actor, { content: exact });
  assert.equal(storage.current.messages[1].content, exact);

  const huge = "x".repeat(200_001);
  await assert.rejects(
    () => service.sendChatMessageFromTool({ ...actor, runId: "accord-exact-2" }, { content: huge }),
    /rejected, not truncated/
  );
  // The rejected send left no partial/shortened message behind.
  assert.equal(storage.current.messages.length, 2);
});

test("app_chat_send_message enforces a per-run send limit", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "accord-limit-1"
  };

  for (let i = 0; i < 12; i += 1) {
    await service.sendChatMessageFromTool(actor, { content: `msg ${i}` });
  }
  await assert.rejects(
    () => service.sendChatMessageFromTool(actor, { content: "one too many" }),
    /ChatSendMessageDenied/
  );
});

test("app_chat_send_message rejects a threadId that is not a visible thread", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "accord-thread-1"
  };

  await assert.rejects(
    () => service.sendChatMessageFromTool(actor, { content: "hi", threadId: "ghost-thread" }),
    /ChatSendMessageDenied/
  );
  // The existing user message's id is a valid visible thread root.
  const ok = await service.sendChatMessageFromTool(actor, { content: "hi", threadId: "user-message" });
  assert.equal(ok.threadId, "user-message");
});

test("a new canonical message does not inherit reactions from the prior version", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "accord-version-1"
  };

  const first = await service.sendChatMessageFromTool(actor, { content: "Candidate v1." });
  await service.reactToMessageFromTool(actor, { messageId: first.messageId as string, emoji: "✅" });
  const second = await service.sendChatMessageFromTool(actor, { content: "Candidate v2." });

  assert.equal(storage.current.messages[1].metadata.reactions["✅"].length, 1);
  assert.equal(storage.current.messages[2].id, second.messageId);
  assert.equal(storage.current.messages[2].metadata.reactions, undefined);
});

test("app_chat_send_message rejects empty content and invisible parent ids", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "accord-run-2"
  };

  await assert.rejects(
    () => service.sendChatMessageFromTool(actor, { content: "   " }),
    /non-empty content/
  );
  await assert.rejects(
    () => service.sendChatMessageFromTool(actor, { content: "hi", parentMessageId: "missing-message" }),
    /ChatSendMessageDenied/
  );
});

test("app_chat_read_messages by messageId hides messages newer than the turn snapshot", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  // Publisher sees the whole conversation; a second reader is pinned to the original snapshot.
  const publisher = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "accord-run-3"
  };
  const sent = await service.sendChatMessageFromTool(publisher, { content: "Canonical." });

  const staleReader = { ...publisher, snapshotMaxSequence: 0, runId: "accord-run-4" };
  const hidden = await service.readChatMessagesForTool(staleReader, { messageId: sent.messageId });
  assert.equal((hidden.messages as unknown[]).length, 0);

  const visible = await service.readChatMessagesForTool(publisher, { messageId: sent.messageId });
  assert.equal((visible.messages as unknown[]).length, 1);
});

test("app_chat_react reaction survives stale chat state refresh", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const staleConversation = clone(conversation);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: []
  };

  await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(storage.current.messages[0].metadata.reactions["✅"][0].actorLabel, "@codex");

  await chatParts(service).store.refreshStoredChatState(staleConversation);

  assert.equal(staleConversation.messages[0].metadata?.reactions?.["✅"]?.[0]?.actorLabel, "@codex");

  const staleConversationWithReaction = clone(staleConversation);

  await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(storage.current.messages[0].metadata.reactions, undefined);

  await chatParts(service).store.refreshStoredChatState(staleConversationWithReaction);

  assert.equal(staleConversationWithReaction.messages[0].metadata?.reactions, undefined);
});

test("a swept placeholder is marked, and a late result repairs it preserving reactions", async () => {
  const participant = chatParticipant("codex-cli");
  const runId = "dead-run";
  const conversation = chatConversation([participant], {
    activeRunIds: [runId],
    runId,
    running: true,
    activeRunOwnersByRunId: {
      [runId]: {
        processId: process.pid,
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-dead", runId));
  const { service } = testService({ conversation });

  const swept = chatParts(service).runOwners.recoverStaleChatRun(conversation);
  assert.equal(swept, true);
  const placeholder = conversation.messages.find((message: any) => message.id === "pending-dead")!;
  assert.equal(placeholder.status, "error");
  assert.equal(placeholder.content, "Interrupted before completion.");
  assert.equal(placeholder.metadata?.staleRunRecovery?.runId, runId);

  // A ✅ lands on the placeholder while it still shows "Interrupted".
  placeholder.metadata.reactions = {
    "✅": [{ actorId: "user", actorLabel: "User", actorKind: "user", at: NOW }]
  };

  // The real answer finishes late and is appended under the same id.
  const completed = pendingParticipantMessage(participant, "pending-dead", runId, {
    status: "done",
    content: "Here is the real answer.",
    metadata: { runId }
  });
  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, participant, [completed]);

  const repaired = conversation.messages.find((message: any) => message.id === "pending-dead")!;
  assert.equal(repaired.status, "done");
  assert.equal(repaired.content, "Here is the real answer.");
  assert.equal(repaired.metadata?.staleRunRecovery, undefined);
  assert.equal(repaired.metadata?.reactions?.["✅"]?.[0]?.actorLabel, "User");
});
