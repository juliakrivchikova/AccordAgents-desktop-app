import assert from "node:assert/strict";
import test from "node:test";
import { APP_CHAT_REQUEST_PARTICIPANTS_TOOL } from "./appMcp";
import { chatParts } from "./chat/test/chatParts";
import { parseAccordLaunchCard } from "../../shared/accordLaunchCard";
import { normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type {
  ChatAppToolApprovalPolicy, ChatMessage, ChatParticipant, ChatProviderKind, ChatSkillMention, ParticipantConfig
} from "../../shared/types";
import {
  ADMIN_ROLE, chatConversation, chatParticipant, liveTurn, NOW, participantRequestActor, runningReply, skillMention, testService,
  timelineMessage, turnActor, waitFor
} from "./chat/test/permissionFixtures";

test("posts that are messages of their own stay so: an Accord resolution, another thread or parent, no turn running, a turn already ended", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.messages.push(
    { id: "other-root", role: "user", content: "Another question.", createdAt: NOW, status: "done" },
    runningReply(participant)
  );
  const { service, storage } = testService({ conversation });
  liveTurn(service, participant);
  const actor = turnActor(participant, { snapshotMaxSequence: 1 });
  const separate = async (request: Record<string, unknown>, who = actor): Promise<ChatMessage> => {
    const sent = await service.sendChatMessageFromTool(who, request);
    assert.notEqual(sent.messageId, "reply-1", JSON.stringify(request));
    assert.equal(sent.postId, undefined);
    const message = storage.current.messages.find((item: ChatMessage) => item.id === sent.messageId) as ChatMessage;
    assert.equal(message.metadata?.appMessageSource, "app_chat_send_message");
    return message;
  };

  const resolution = await separate({ content: "Resolution v1.", accordResolution: { version: 1 } });
  assert.equal(resolution.metadata?.accordResolution?.version, 1);
  await separate({ content: "In the other thread.", threadId: "other-root" });
  await separate({ content: "Under the other message.", parentMessageId: "other-root" });
  await separate({ content: "Rooted elsewhere.", chatThreadRootId: "other-root" });
  await separate({ content: "From a run that is not this reply's." }, turnActor(participant, { runId: "finished-run", snapshotMaxSequence: 1 }));
  await separate({ content: "From no run at all." }, turnActor(participant, { runId: undefined, snapshotMaxSequence: 1 }));

  // The same place, named explicitly, is still the reply's.
  const same = await service.sendChatMessageFromTool(actor, { content: "Same place.", threadId: "user-message", parentMessageId: "user-message" });
  assert.equal(same.messageId, "reply-1");

  // The turn ended before the post arrived: a message of its own.
  const ended = storage.current.messages.find((item: ChatMessage) => item.id === "reply-1") as ChatMessage;
  ended.status = "done";
  ended.content = "All done.";
  await separate({ content: "Late post." });
  assert.deepEqual(ended.metadata?.interimPosts?.map((post) => post.content), ["Same place."]);
});

test("pasted accord token derives a structured accord mention and enables facilitator requests", async () => {
  const facilitator = chatParticipant("codex-cli");
  const peer = chatParticipant("claude-code");
  const conversation = chatConversation([facilitator, peer]);
  const accordMention = skillMention("codex-cli") as ChatSkillMention;
  const runs: Array<{ participant: ParticipantConfig; prompt: string }> = [];
  const searches: any[] = [];
  const validations: any[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    userSkills: {
      async search(request: any, context: any): Promise<any> {
        searches.push({ request, context });
        return { target: context.target, skills: [accordMention] };
      },
      async validateMentionForParticipant(mention: any, providerKind: ChatProviderKind, context: any, participantId: string): Promise<any> {
        validations.push({ mention, providerKind, context, participantId });
        return { ok: true, mention };
      },
      async resolveInvocableSkillsForParticipant(): Promise<any[]> {
        return [{ name: "accord", dir: "/tmp/accord-skill" }];
      }
    },
    run: async (runParticipant, prompt) => {
      runs.push({ participant: runParticipant, prompt });
      return {
        participant: runParticipant,
        ok: true,
        content: "accord complete",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "pasted-accord-run",
    content: "@codex have an /accord with Drew regarding the final implementation"
  });

  await waitFor(() => runs.length === 1);
  const userMessage = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("/accord")
  ) as ChatMessage | undefined;
  assert.equal(searches.length, 1);
  assert.equal(searches[0].request.query, "accord");
  assert.equal(validations.length, 2);
  assert.equal(validations[0].participantId, facilitator.id);
  assert.equal(userMessage?.metadata?.skillMentions?.[0]?.frontmatterName, "accord");
  assert.equal(runs[0].participant.id, facilitator.id);
  assert.match(runs[0].prompt, /^Selected skill: .*\(skill name: accord; /m);
  assert.equal(
    storage.current.metadata.participants.find((participant: ChatParticipant) => participant.id === facilitator.id)
      ?.permissions.requestParticipants,
    "allow"
  );
  assert.equal(
    storage.current.metadata.participants.find((participant: ChatParticipant) => participant.id === peer.id)
      ?.permissions.requestParticipants,
    "ask"
  );
});

test("pasted accord token is a no-op when accord is not runnable by the target", async () => {
  const facilitator = chatParticipant("codex-cli");
  const conversation = chatConversation([facilitator]);
  const runs: Array<{ participant: ParticipantConfig; prompt: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    userSkills: {
      async search(): Promise<any> {
        return { skills: [] };
      },
      async validateMentionForParticipant(): Promise<any> {
        throw new Error("should not validate when no accord skill was found");
      },
      async resolveInvocableSkillsForParticipant(): Promise<any[]> {
        return [];
      }
    },
    run: async (runParticipant, prompt) => {
      runs.push({ participant: runParticipant, prompt });
      return {
        participant: runParticipant,
        ok: true,
        content: "normal reply",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "pasted-accord-no-skill-run",
    content: "@codex please consider /accord"
  });

  await waitFor(() => runs.length === 1);
  const userMessage = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("/accord")
  ) as ChatMessage | undefined;
  assert.equal(userMessage?.metadata?.skillMentions, undefined);
  assert.doesNotMatch(runs[0].prompt, /Selected skills:/);
});

test("pasted accord detection skips false-positive tokens and multi-target prose", async () => {
  const codex = chatParticipant("codex-cli");
  const drew = chatParticipant("claude-code");
  const conversation = chatConversation([codex, drew]);
  const { service } = testService({
    conversation,
    userSkills: {
      async search(): Promise<any> {
        throw new Error("accord search should not run for non-matching prose");
      },
      async validateMentionForParticipant(): Promise<any> {
        throw new Error("accord validation should not run for non-matching prose");
      }
    }
  });
  const contents = [
    "@codex discuss /accordion",
    "@codex discuss and/or alternatives",
    "@codex inspect src/accord",
    "@codex ```\n/accord\n```",
    "@codex `/accord`"
  ];

  for (const content of contents) {
    const validation = await chatParts(service).messageSending.validateChatSkillMentionsForTargets(
      conversation,
      content,
      undefined,
      [codex]
    );
    assert.deepEqual(validation.skillMentions, []);
    assert.deepEqual(validation.targets.map((participant: ChatParticipant) => participant.id), [codex.id]);
  }

  const multiTarget = await chatParts(service).messageSending.validateChatSkillMentionsForTargets(
    conversation,
    "@codex @drew /accord",
    undefined,
    [codex, drew]
  );
  assert.deepEqual(multiTarget.skillMentions, []);
  assert.deepEqual(multiTarget.targets.map((participant: ChatParticipant) => participant.id), [codex.id, drew.id]);
});

test("inferred accord assignment allows facilitator participant requests before nested request", async () => {
  const manager: ChatParticipant = {
    ...chatParticipant("codex-cli", { requestParticipants: "allow" }),
    id: "manager",
    handle: "nikita"
  };
  const drew: ChatParticipant = {
    ...chatParticipant("codex-cli", { repoRead: true, requestParticipants: "ask" }),
    id: "drew",
    handle: "drew-codex-engineer"
  };
  const taylor: ChatParticipant = {
    ...chatParticipant("claude-code", { repoRead: true }),
    id: "taylor",
    handle: "taylor-claude-engineer"
  };
  const conversation = chatConversation([manager, drew, taylor]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (participant) => ({
      participant,
      ok: true,
      content: "Reviewed.",
      durationMs: 1
    })
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const sourceMessage = timelineMessage("@nikita-accord", "@drew-codex-engineer have an /accord on exact implementation plan with Taylor.", {
    role: "participant",
    participantId: manager.id,
    participantLabel: `@${manager.handle}`,
    metadata: {
      threadId: "@nikita-accord"
    }
  });
  conversation.messages.push(sourceMessage);

  await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, manager, [sourceMessage]);
  await storage.saveConversation(conversation);

  const drewAfterInferredAccord = storage.current.metadata.participants.find((participant: ChatParticipant) => participant.id === drew.id);
  assert.equal(normalizeChatAgentPermissions(drewAfterInferredAccord?.permissions).requestParticipants, "allow");
  assert.equal(storage.current.metadata.pendingAppToolApprovals, undefined);

  const result = await service.requestParticipantsFromTool({
    ...participantRequestActor(drew),
    participantId: drew.id,
    roleConfigId: drew.roleConfigId,
    triggerMessageId: "@nikita-accord",
    triggerThreadId: "@nikita-accord"
  }, {
    requests: [{ target: taylor.handle, prompt: "Review the canonical accord resolution." }],
    timeoutMs: 5000,
    resumeRequester: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.approvalRequired, false);
  const nestedRequest = storage.current.messages
    .filter((message: ChatMessage) => message.metadata?.participantRequest)
    .at(-1);
  assert.equal(nestedRequest?.metadata?.participantRequest?.requesterParticipantId, drew.id);
  assert.equal(nestedRequest?.metadata?.participantRequest?.items[0]?.targetParticipantId, taylor.id);
  assert.notEqual(nestedRequest?.metadata?.participantRequest?.items[0]?.status, "pending_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals, undefined);
});

test("inferred accord keeps the single-facilitator guard before suppression and cap filtering", async () => {
  const manager: ChatParticipant = {
    ...chatParticipant("codex-cli", { requestParticipants: "allow" }),
    id: "accord-guard-manager",
    handle: "manager"
  };
  const drew: ChatParticipant = {
    ...chatParticipant("codex-cli", { requestParticipants: "ask" }),
    id: "accord-guard-drew",
    handle: "drew"
  };
  const taylor: ChatParticipant = {
    ...chatParticipant("claude-code", { requestParticipants: "ask" }),
    id: "accord-guard-taylor",
    handle: "taylor"
  };
  const suppressedConversation = chatConversation([manager, drew, taylor]);
  const suppressed = testService({ conversation: suppressedConversation });
  chatParts(suppressed.service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
  const suppressedActor = {
    ...participantRequestActor(manager),
    runId: "accord-guard-suppressed-run",
    turnSegmentId: "accord-guard-suppressed-segment"
  };

  await suppressed.service.sendChatMessageFromTool(suppressedActor, { content: "@drew inspect X." });
  await suppressed.service.sendChatMessageFromTool(suppressedActor, {
    content: "/accord @drew and @taylor should resolve this."
  });

  const suppressedParticipants = suppressed.storage.current.metadata.participants as ChatParticipant[];
  assert.equal(
    normalizeChatAgentPermissions(suppressedParticipants.find((participant) => participant.id === drew.id)?.permissions).requestParticipants,
    "ask"
  );
  assert.equal(
    normalizeChatAgentPermissions(suppressedParticipants.find((participant) => participant.id === taylor.id)?.permissions).requestParticipants,
    "ask"
  );

  const cappedTargets = ["one", "two", "three", "four", "five"].map((handle): ChatParticipant => ({
    ...chatParticipant("claude-code", { requestParticipants: "ask" }),
    id: `accord-guard-${handle}`,
    handle
  }));
  const cappedConversation = chatConversation([manager, ...cappedTargets]);
  const capped = testService({ conversation: cappedConversation });
  chatParts(capped.service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;
  const cappedActor = {
    ...participantRequestActor(manager),
    runId: "accord-guard-cap-run",
    turnSegmentId: "accord-guard-cap-segment"
  };

  await capped.service.sendChatMessageFromTool(cappedActor, { content: "@one @two @three inspect X." });
  await capped.service.sendChatMessageFromTool(cappedActor, { content: "/accord @four and @five resolve Y." });

  const cappedParticipants = capped.storage.current.metadata.participants as ChatParticipant[];
  for (const target of cappedTargets.slice(3)) {
    assert.equal(
      normalizeChatAgentPermissions(cappedParticipants.find((participant) => participant.id === target.id)?.permissions).requestParticipants,
      "ask"
    );
  }
});

test("legacy participant-request policies and accord metadata are cleared on chat load", async () => {
  const requester = chatParticipant("codex-cli");
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target], {
    accordLaunch: {
      id: "launch-1",
      facilitatorId: requester.id,
      targetIds: [target.id],
      requiredApproverIds: [requester.id, target.id],
      runId: "run-1",
      expiresAt: "2099-01-01T00:00:00.000Z"
    },
    accordRun: {
      facilitatorId: requester.id,
      expiresAt: "2099-01-01T00:00:00.000Z"
    },
    appToolApprovalPolicies: [
      {
        ...participantRequestPolicy(requester, target),
        accordLaunchId: "launch-1",
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    ]
  });
  const { service, storage } = testService({ conversation });

  const loaded = await chatParts(service).store.requireChat(conversation.id);

  assert.equal(loaded.metadata.accordLaunch, undefined);
  assert.equal(loaded.metadata.accordRun, undefined);
  assert.deepEqual(loaded.metadata.appToolApprovalPolicies, []);
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies, []);
});

test("startAccord creates structured accord skill mention and dispatches only the facilitator", async () => {
  const facilitator = chatParticipant("codex-cli");
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([facilitator, target]);
  const accordMention = skillMention("codex-cli");
  const searches: any[] = [];
  const validations: any[] = [];
  const runs: Array<{ participant: ParticipantConfig; prompt: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    userSkills: {
      async search(request: any, context: any): Promise<any> {
        searches.push({ request, context });
        return {
          target: context.target,
          skills: [accordMention]
        };
      },
      async validateMentionForParticipant(mention: any, providerKind: ChatProviderKind, context: any, participantId: string): Promise<any> {
        validations.push({ mention, providerKind, context, participantId });
        return { ok: true, mention };
      },
      async resolveInvocableSkillsForParticipant(): Promise<any[]> {
        return [{ name: "accord", dir: "/tmp/accord-skill" }];
      }
    },
    run: async (runParticipant, prompt) => {
      runs.push({ participant: runParticipant, prompt });
      return {
        participant: runParticipant,
        ok: true,
        content: "Accord started.",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const result = await service.startAccord({
    conversationId: conversation.id,
    facilitatorParticipantId: facilitator.id,
    targetParticipantIds: [target.id],
    subject: "Pick the launch shape."
  }, undefined, undefined, "accord-run");

  await waitFor(() => runs.length === 1);
  assert.equal(result.runId, "accord-run");
  assert.equal(runs[0].participant.id, facilitator.id);
  assert.equal(searches[0].context.target.participantIds.length, 1);
  assert.equal(searches[0].context.target.participantIds[0], facilitator.id);
  assert.equal(validations[0].participantId, facilitator.id);

  const userMessage = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("/accord")
  ) as ChatMessage | undefined;
  assert.ok(userMessage);
  assert.equal(userMessage.metadata?.skillMentions?.[0]?.frontmatterName, "accord");
  assert.deepEqual(userMessage.metadata?.askedParticipantIds, [facilitator.id], "it asks the facilitator, whose watch then does not wake it too");
  assert.match(userMessage.content, /@codex \/accord/);
  assert.match(userMessage.content, /Selected accord members: drew\./);
  assert.doesNotMatch(userMessage.content, /@drew/);
  // The facilitator's turn is this exact text; the timeline only reads it as
  // a card (accordLaunchCard.ts), it never changes what the member receives.
  assert.equal(userMessage.content, [
    "@codex /accord",
    "",
    "Subject:",
    "Pick the launch shape.",
    "",
    "Selected accord members: drew.",
    "Run the accord skill for exactly those selected members and this subject. Use app_chat_request_participants for those members only. The app has enabled request-members permission for you in this chat; the user can revoke it from your member controls."
  ].join("\n"));
  assert.deepEqual(parseAccordLaunchCard(userMessage.content), { facilitator: "codex", members: ["drew"], subject: "Pick the launch shape." });

  const facilitatorAfterStart = storage.current.metadata.participants.find((participant: ChatParticipant) => participant.id === facilitator.id);
  assert.equal(facilitatorAfterStart.permissions.requestParticipants, "allow");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies, undefined);
  assert.equal(result.sourceMessageId, userMessage.id);
});

test("startAccord rejects Chat Assistant as facilitator", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([assistant, target]);
  const { service } = testService({ conversation });

  await assert.rejects(
    () => service.startAccord({
      conversationId: conversation.id,
      facilitatorParticipantId: assistant.id,
      targetParticipantIds: [target.id],
      subject: "Pick the launch shape."
    }),
    /The Chat Assistant cannot be an Accord facilitator or member/
  );
});

test("startAccord rejects Chat Assistant as selected participant", async () => {
  const facilitator = chatParticipant("codex-cli");
  const assistant = {
    ...chatParticipant("claude-code"),
    id: "assistant-participant",
    handle: "assistant-2",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([facilitator, assistant]);
  const { service } = testService({ conversation });

  await assert.rejects(
    () => service.startAccord({
      conversationId: conversation.id,
      facilitatorParticipantId: facilitator.id,
      targetParticipantIds: [assistant.id],
      subject: "Pick the launch shape."
    }),
    /The Chat Assistant cannot be an Accord facilitator or member/
  );
});

test("manual accord structured skill mention flips only the dispatched facilitator", () => {
  const facilitator = chatParticipant("codex-cli");
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([facilitator, target]);
  const { service } = testService({ conversation });

  const nextTargets = chatParts(service).requestGrants.allowParticipantRequestsForManualAccordIfSelected(
    conversation,
    [skillMention("codex-cli")],
    [facilitator]
  ) as ChatParticipant[];

  assert.equal(nextTargets.length, 1);
  assert.equal(nextTargets[0].id, facilitator.id);
  assert.equal(nextTargets[0].permissions?.requestParticipants, "allow");
  const participants = conversation.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.id === facilitator.id)?.permissions?.requestParticipants, "allow");
  assert.equal(participants.find((participant) => participant.id === target.id)?.permissions?.requestParticipants, "ask");
});

function participantRequestPolicy(
  participant: ChatParticipant,
  target: ChatParticipant,
  patch: Partial<ChatAppToolApprovalPolicy> = {}
): ChatAppToolApprovalPolicy {
  return {
    id: patch.id ?? "participant-request-policy-1",
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
    capability: "participants.request",
    targetParticipantId: target.id,
    scope: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  };
}
