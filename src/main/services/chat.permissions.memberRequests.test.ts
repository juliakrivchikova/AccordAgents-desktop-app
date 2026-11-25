import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APP_ARTIFACT_CREATE_TOOL, APP_CHAT_EXPORT_ATTACHMENT_TOOL, APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_TOOL_PERMISSION_TOOL,
  AppMcpService
} from "./appMcp";
import { appMcpParts } from "./appMcp/test/appMcpParts";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { updateParticipantRequestBatch } from "./chat/requests/requestRecords";
import type { HubOp } from "../../shared/hubOps";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";
import { CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES } from "../../shared/chatParticipantRequests";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation, ParticipantConfig } from "../../shared/types";
import {
  chatConversation, chatParticipant, completeParticipantRequest, fakeServerLink, inferredRequestMessages, memberDeviceAnswers,
  NOW, participantReplyMessage, participantRequestActor, pendingParticipantMessage, ROLE, testService, waitFor
} from "./chat/test/permissionFixtures";

test("inferred participant request persists hidden request before running target", async () => {
  const manager = { ...chatParticipant("codex-cli", { requestParticipants: "allow" }), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target]);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    run: async (participant) => {
      runs.push(participant);
      return {
        participant,
        ok: true,
        content: participant.id === manager.id && runs.filter((run) => run.id === manager.id).length === 1
          ? "@drew Please reply."
          : "Reply complete.",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, content: "@codex coordinate this." });
  await waitFor(() => runs.some((participant) => participant.id === target.id), 1500);

  const requestMessage = storage.current.messages.find((message: ChatMessage) =>
    message.metadata?.participantRequest?.source === "inferred"
  );
  assert.ok(requestMessage);
  assert.equal(requestMessage.metadata?.hiddenFromTimeline, true);
  assert.equal(requestMessage.metadata?.participantRequest?.items[0]?.targetParticipantId, target.id);
  assert.equal(
    storage.current.messages.some((message: ChatMessage) => /Participant request message was not found/i.test(message.content)),
    false
  );
});

test("a member's request to a member whose machine cannot run its Full Access fails with the line, leaving no bubble waiting", async () => {
  const own = { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const };
  const manager = { ...chatParticipant("codex-cli", { requestParticipants: "allow" }), id: "manager", handle: "manager" };
  const target = { ...chatParticipant("codex-cli"), id: "fa-target", handle: "fa", homeMachineId: "box", agentMode: "full-access" as const, permissions: own };
  let managerRuns = 0;
  const h = testService({
    conversation: chatConversation([manager, target]),
    run: async (participant) => {
      if (participant.id === manager.id) managerRuns += 1;
      return { participant, ok: true, content: participant.id === manager.id && managerRuns === 1 ? "@fa Please reply." : "Done.", durationMs: 1 };
    }
  });
  chatParts(h.service).chatHistory.ensureHistoryFiles = async () => h.tempRoot;
  h.service.setMachineCliModesSupport(() => "outdated");
  const link = fakeServerLink("desktop-device", { box: "Cloud box" });
  h.service.setServerLink(link);
  await h.service.sendMessage({ conversationId: h.storage.current.id, content: "@manager coordinate this." });
  const item = () => h.storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest)?.metadata?.participantRequest?.items?.[0];
  await waitFor(() => item()?.status === "failed", 3000);
  assert.match(item().error, /Cloud box runs an older program that cannot run Full Access/);
  assert.equal(h.storage.current.messages.some((message: ChatMessage) => message.participantId === target.id && message.status === "pending"), false, "no bubble left waiting for it");
  assert.equal(link.ops.some((op) => op.kind === "turn.request" && op.participantId === target.id), false, "never asked of its machine");
});

test("a member's request to a Cloud run member whose machine turns out older fails with the line, leaving no bubble waiting", async () => {
  const own = { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const };
  const manager = { ...chatParticipant("codex-cli", { requestParticipants: "allow" }), id: "manager", handle: "manager" };
  const target = { ...chatParticipant("codex-cli"), id: "cloud-target", handle: "cloudy", cloudRun: {}, agentMode: "full-access" as const, permissions: own };
  let managerRuns = 0;
  const h = testService({
    conversation: chatConversation([manager, target]),
    run: async (participant) => {
      if (participant.id === manager.id) managerRuns += 1;
      return { participant, ok: true, content: participant.id === manager.id && managerRuns === 1 ? "@cloudy Please reply." : "Done.", durationMs: 1 };
    }
  });
  chatParts(h.service).chatHistory.ensureHistoryFiles = async () => h.tempRoot;
  h.service.setMachineCliModesSupport((machineId) => machineId === "old-box" ? "outdated" : "unknown");
  h.service.setCloudRunPreparation(async () => "old-box");
  const link = fakeServerLink("desktop-device", { "old-box": "Old box" });
  h.service.setServerLink(link);
  await h.service.sendMessage({ conversationId: h.storage.current.id, content: "@manager coordinate this." });
  const item = () => h.storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest)?.metadata?.participantRequest?.items?.[0];
  await waitFor(() => item()?.status === "failed", 3000);
  assert.match(item().error, /Old box runs an older program that cannot run Full Access/);
  assert.equal(h.storage.current.messages.some((message: ChatMessage) => message.participantId === target.id && message.status === "pending"), false, "no bubble left waiting for it");
  assert.equal(link.ops.some((op) => op.kind === "turn.request"), false, "never asked of that machine");
});

test("static chat instructions include structured participant request and reply guidance", () => {
  const { service } = testService();
  const instructions = chatParts(service).memberSessions.staticChatInstructions({
    roleAppToolCapabilities: ["participants.request", "permissions.request"]
  });

  assert.match(instructions, /use `app_chat_request_participants` rather than plain `@mentions`/);
  assert.match(instructions, /Reaction MCP tool: `app_chat_react` adds or toggles an emoji reaction on a specific message/);
  assert.match(instructions, /When replying to a participant request addressed to you, answer in the active thread/);
  assert.match(instructions, /if request matching is ambiguous, ask for clarification rather than guessing/);
  assert.match(instructions, /end your turn unless User explicitly asked you to continue without that answer or an active skill gives you work that does not need it/,
    "a skill such as Accord may finish independent work after a member request starts running");
  assert.doesNotMatch(instructions, /app_chat_reply_to_participant_request/);
});

test("tool provenance suppresses sibling restatements after nested participant-request auto-resume", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const target = chatParticipant("claude-code");
  const siblingTarget: ChatParticipant = {
    ...chatParticipant("claude-code"),
    id: "sibling-participant",
    handle: "taylor"
  };
  const conversation = chatConversation([requester, target, siblingTarget]);
  const { service, storage } = testService({ conversation });
  const debugEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
  chatDependencies(service).debugLogs.write = async (event: string, payload: Record<string, unknown>) => {
    debugEntries.push({ event, payload });
  };

  await service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId: "tool-origin-run",
    turnSegmentId: "tool-origin-segment"
  }, { content: "@drew do X." });
  await service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId: "tool-origin-run",
    turnSegmentId: "tool-origin-segment"
  }, { content: "@taylor do Y." });
  const [inferredRequest, siblingRequest] = inferredRequestMessages(storage.current);
  const inferredBatchId = inferredRequest.metadata?.participantRequest?.id;
  assert.equal(typeof inferredBatchId, "string");
  completeParticipantRequest(inferredRequest);
  completeParticipantRequest(siblingRequest);

  const resumedFinal = participantReplyMessage(
    requester,
    "auto-resumed-final",
    "@drew completed X; @taylor still owes Y."
  );
  resumedFinal.metadata = {
    ...resumedFinal.metadata,
    runId: "fresh-auto-resume-run",
    turnSegmentId: "fresh-auto-resume-segment",
    participantRequestDepth: 1,
    participantRequestBatchId: inferredBatchId,
    participantRequestChainRootId: "enclosing-request-chain"
  };
  await chatParts(service).pendingReplies.appendParticipantTurnMessages(storage.current, requester, [resumedFinal]);

  assert.equal(inferredRequestMessages(storage.current).length, 2);
  assert.equal(
    debugEntries.find((entry) => entry.event === "chat.participant-request.inferred-skipped-existing")?.payload.decidingScope,
    "final-source-tool-origin-segment"
  );

  await service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId: "fresh-auto-resume-run",
    turnSegmentId: "fresh-auto-resume-segment",
    participantRequestDepth: 1,
    participantRequestBatchId: inferredBatchId,
    chainRootId: "enclosing-request-chain"
  }, { content: "@taylor now do Z." });
  assert.equal(inferredRequestMessages(storage.current).length, 3);
});

test("inferred participant requests enforce a four-target cap across one turn segment", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const targets = ["one", "two", "three", "four", "five"].map((handle, index): ChatParticipant => ({
    ...chatParticipant("claude-code"),
    id: `target-${index}`,
    handle
  }));
  const conversation = chatConversation([requester, ...targets]);
  const { service } = testService({ conversation });
  const debugEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
  chatDependencies(service).debugLogs.write = async (event: string, payload: Record<string, unknown>) => {
    debugEntries.push({ event, payload });
  };
  const metadata = {
    threadId: "user-message",
    runId: "cap-run",
    turnSegmentId: "cap-segment",
    appMessageSource: "app_chat_send_message"
  };
  const first = participantReplyMessage(requester, "cap-one", "@one @two review.");
  first.metadata = { ...metadata };
  conversation.messages.push(first);
  await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, requester, [first]);
  const second = participantReplyMessage(requester, "cap-two", "@three @four @five review.");
  second.metadata = { ...metadata };
  conversation.messages.push(second);
  await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, requester, [second]);

  const items = inferredRequestMessages(conversation)
    .flatMap((message) => message.metadata?.participantRequest?.items ?? []);
  assert.deepEqual(items.map((item) => item.targetHandle), ["one", "two", "three", "four"]);
  assert.deepEqual(
    debugEntries.find((entry) => entry.event === "chat.participant-request.inferred-turn-cap")?.payload.targets,
    ["five"]
  );
  assert.equal(conversation.metadata.warnings, undefined);
});

test("legacy protocol filtering ends at a blank line before later real mention lists", async () => {
  const cases = [
    {
      content: [
        "Participant requests:",
        "- @drew run legacy QA",
        "",
        "- @taylor please review",
        "- @alex sign off"
      ].join("\n"),
      expected: ["taylor", "alex"]
    },
    {
      content: [
        "Return to requester after replies: yes",
        "",
        "1. @taylor review",
        "2. @drew run QA"
      ].join("\n"),
      expected: ["drew", "taylor"]
    },
    {
      content: [
        "Participant requests:",
        "",
        "- @taylor please review"
      ].join("\n"),
      expected: ["taylor"]
    }
  ];

  for (const [index, item] of cases.entries()) {
    const requester: ChatParticipant = {
      ...chatParticipant("codex-cli", { requestParticipants: "allow" }),
      id: `protocol-requester-${index}`,
      handle: `requester-${index}`
    };
    const targets = ["drew", "taylor", "alex"].map((handle): ChatParticipant => ({
      ...chatParticipant("claude-code"),
      id: `protocol-${index}-${handle}`,
      handle
    }));
    const conversation = chatConversation([requester, ...targets]);
    const { service, storage } = testService({ conversation });
    chatParts(service).participantRequests.startDeferredParticipantRequestRunners = () => undefined;

    await service.sendChatMessageFromTool({
      ...participantRequestActor(requester),
      runId: `protocol-run-${index}`,
      turnSegmentId: `protocol-segment-${index}`
    }, { content: item.content });

    const actual = inferredRequestMessages(storage.current)
      .flatMap((message) => message.metadata?.participantRequest?.items ?? [])
      .map((request) => request.targetHandle);
    assert.deepEqual(actual, item.expected);
  }
});

test("a declined late result does not spawn an implicit participant request", async () => {
  const participant = chatParticipant("codex-cli");
  const other = chatParticipant("claude-code"); // handle "drew"
  const conversation = chatConversation([participant, other]);
  conversation.messages.push(pendingParticipantMessage(participant, "stopped", "stopped-run", {
    status: "error",
    content: "Stopped by user.",
    metadata: { runId: "stopped-run" }
  }));
  const { service } = testService({ conversation });

  // The stopped run finishes late with content that @-mentions another participant.
  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, participant, [
    pendingParticipantMessage(participant, "stopped", "stopped-run", {
      status: "done",
      content: "@drew please take over.",
      metadata: { runId: "stopped-run" }
    })
  ]);

  const after = conversation.messages.find((message: any) => message.id === "stopped")!;
  assert.equal(after.content, "Stopped by user.");
  // No inferred participant-request message should have been appended.
  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.messages.some((message: any) => message.metadata?.participantRequest), false);
});

test("ChatService constructs classified Auto app MCP launch options for cold, resumed, and participant-request runs", async () => {
  const appMcp = new AppMcpService();
  // Exercise the real grant/token and ChatService option construction without opening
  // a listener in the unit-test sandbox.
  appMcpParts(appMcp).mcpServer.url = "http://127.0.0.1:1/mcp";
  try {
    const requester: ChatParticipant = {
      ...chatParticipant("codex-cli", { requestParticipants: "allow" }),
      id: "requester-participant",
      handle: "requester"
    };
    const target: ChatParticipant = {
      ...chatParticipant("claude-code", { repoRead: true, workspaceWrite: true }),
      id: "auto-claude-participant",
      handle: "auto-claude",
      agentMode: "auto"
    };
    const selectedRepoPath = path.join(tmpdir(), "accordagents-launch-matrix-repo");
    const conversation: Conversation = {
      ...chatConversation([requester, target]),
      repoPath: selectedRepoPath
    };
    const runs: Array<{
      participantId: string;
      repoPath: string | undefined;
      options: any;
      tokenAgentMode: string | undefined;
    }> = [];
    const { service, tempRoot } = testService({
      conversation,
      appMcp,
      run: async (participant, _prompt, repoPath, _diffMode, _kind, _signal, options) => {
        runs.push({
          participantId: participant.id,
          repoPath,
          options,
          tokenAgentMode: appMcpParts(appMcp).accessTokens.tokens.get(options.appMcp.token)?.agentMode
        });
        return {
          participant,
          ok: true,
          content: "Completed.",
          durationMs: 1,
          sessionId: `provider-session-${participant.id}`
        };
      }
    });
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

    await service.sendMessage({
      conversationId: conversation.id,
      runId: "auto-cold-run",
      content: "@auto-claude Run the cold path."
    });
    await waitFor(() => runs.length === 1);
    await service.sendMessage({
      conversationId: conversation.id,
      runId: "auto-resumed-run",
      content: "@auto-claude Run the resumed path."
    });
    await waitFor(() => runs.length === 2);
    await service.requestParticipantsFromTool(participantRequestActor(requester), {
      requests: [{ target: target.handle, prompt: "Run the participant-request path." }],
      timeoutMs: 5_000,
      resumeRequester: false
    });
    await waitFor(() => runs.length === 3);

    assert.equal(Boolean(runs[0].options.sessionId), false);
    assert.equal(runs[1].options.sessionId, `provider-session-${target.id}`);
    for (const [index, run] of runs.entries()) {
      assert.equal(run.participantId, target.id, `run ${index}`);
      assert.equal(run.repoPath, selectedRepoPath, `run ${index}`);
      assert.ok(run.options.appMcp, `run ${index}`);
      assert.ok(run.options.appMcp.toolNames.includes(APP_ARTIFACT_CREATE_TOOL), `run ${index}`);
      assert.ok(run.options.appMcp.autoPreauthorizedToolNames.includes(APP_ARTIFACT_CREATE_TOOL), `run ${index}`);
      assert.equal(run.options.appMcp.autoPreauthorizedToolNames.includes(APP_CHAT_EXPORT_ATTACHMENT_TOOL), false, `run ${index}`);
      assert.equal(run.options.appMcp.autoPreauthorizedToolNames.includes(APP_TOOL_PERMISSION_TOOL), false, `run ${index}`);
      assert.equal(run.tokenAgentMode, "auto", `run ${index}`);
    }
  } finally {
    appMcpParts(appMcp).mcpServer.url = undefined;
  }
});

test("participant request permission ask creates approval card", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "Please review." }],
    timeoutMs: 1000
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "pending_approval");
  assert.equal(result.approvalRequired, true);
  const requestMessage = storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest);
  assert.equal(requestMessage?.metadata?.participantRequest?.items[0]?.status, "pending_approval");
  const approval = storage.current.metadata.pendingAppToolApprovals?.find((item: ChatAppToolApproval) =>
    item.toolName === APP_CHAT_REQUEST_PARTICIPANTS_TOOL
  );
  assert.equal(approval?.status, "pending");
});

test("participant request permission allow runs without approval", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (participant) => {
      runs.push(participant);
      return {
        participant,
        ok: true,
        content: "Reviewed.",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "Please review." }],
    timeoutMs: 5000,
    resumeRequester: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.approvalRequired, false);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, target.id);
  assert.equal(storage.current.metadata.pendingAppToolApprovals, undefined);
});

test("participant request stores prompt exactly up to configured max", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const longPrompt = `Please review.\n${"x".repeat(2_500)}`;
  const { service, storage } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ROLE],
      chatParticipantRequestPromptMaxChars: 3_000
    }
  });

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: longPrompt }],
    timeoutMs: 1000
  });

  assert.equal(result.ok, true);
  const requestMessage = storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest);
  assert.equal(requestMessage?.metadata?.participantRequest?.items[0]?.prompt, longPrompt);
  assert.match(requestMessage?.content ?? "", /Please review\./);
  assert.equal(requestMessage?.content.includes("x".repeat(2_500)), true);
});

test("participant request rejects prompts over configured max instead of truncating", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const { service, storage } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ROLE],
      chatParticipantRequestPromptMaxChars: 1_000
    }
  });

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "x".repeat(1_001) }],
    timeoutMs: 1000
  });

  assert.equal(result.ok, false);
  assert.match(String(result.error), /exceeds 1000 characters; it is rejected, not truncated/);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.participantRequest), false);
});

test("participant request with fast replies auto-resumes requester instead of completing inline", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (participant) => {
      runs.push(participant.id);
      return {
        participant,
        ok: true,
        content: participant.id === target.id ? "Reviewed." : "Continued.",
        durationMs: 1
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "Please review." }],
    timeoutMs: 5000,
    resumeRequester: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "running");
  assert.equal((result.batch as any).items[0].reply, undefined);
  await waitFor(() => runs.includes(requester.id));
  const requestMessage = storage.current.messages.find((message: ChatMessage) => message.metadata?.participantRequest);
  const batch = requestMessage?.metadata?.participantRequest;
  assert.deepEqual(runs, [target.id, requester.id]);
  assert.equal(batch?.completedInToolCall, undefined, "the call returned before any reply, not through the inline path");
  assert.equal(batch?.autoResumeMessageId !== undefined, true);
});

test("a request whose runner fails after its members answered still resumes the requester", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const runs: string[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (participant: any) => {
      runs.push(participant.id);
      return { participant, ok: true, content: "done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  // The answers are in, then the runner's final write fails.
  chatParts(service).participantRequests.runParticipantRequest = async (conversationId: string, requestMessageId: string) => {
    const stored = await chatParts(service).store.requireChat(conversationId);
    await chatParts(service).store.withChatMutation(stored, async () => {
      updateParticipantRequestBatch(stored, requestMessageId, (batch: any) => ({
        ...batch,
        items: batch.items.map((item: any) => ({ ...item, status: "answered" }))
      }));
      chatParts(service).store.queueSnapshot(stored);
    });
    throw new Error("history write failed");
  };

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "Review." }]
  });
  assert.equal(result.status, "running");
  const batchOf = () => storage.current.messages
    .find((message: ChatMessage) => message.metadata?.participantRequest)?.metadata?.participantRequest;
  await waitFor(() => batchOf()?.autoResumeMessageId !== undefined, 2000);
  assert.equal(batchOf()?.items[0].status, "answered");
  assert.ok(runs.includes(requester.id));
});

test("participant request permission deny blocks requests even with stale capability", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "deny" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "Please review." }]
  });

  assert.equal(result.ok, false);
  assert.match(String(result.error), /disabled/);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.participantRequest), false);
});

test("participant request max depth is configurable", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const actor = {
    ...participantRequestActor(requester),
    participantRequestDepth: 2
  };
  const normalizedRequest = {
    requests: [{ target: target.handle, prompt: "Please review." }],
    timeoutMs: 1000,
    resumeRequester: true
  };
  const defaultService = testService({ conversation }).service as any;

  await assert.rejects(
    () => chatParts(defaultService).participantRequests.prepareParticipantRequest(conversation, requester, normalizedRequest, actor, "mcp"),
    /max depth \(2\) reached/
  );

  const { service } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ROLE],
      chatParticipantRequestMaxDepth: 3
    }
  });
  const prepared = await chatParts(service).participantRequests.prepareParticipantRequest(
    conversation,
    requester,
    normalizedRequest,
    actor,
    "mcp"
  );

  assert.equal(prepared.batch.depth, 3);
  assert.equal(prepared.batch.status, "running");
});

test("participant request depth stays flat for requester sibling rounds but blocks true nesting", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const target = chatParticipant("claude-code", { requestParticipants: "allow" });
  const conversation = chatConversation([requester, target]);
  const normalizedRequest = {
    requests: [{ target: target.handle, prompt: "Please review." }],
    timeoutMs: 1000,
    resumeRequester: true
  };
  const { service } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ROLE],
      chatParticipantRequestMaxDepth: 1
    }
  });
  const serviceAny = service as any;

  const first = await chatParts(serviceAny).participantRequests.prepareParticipantRequest(
    conversation,
    requester,
    normalizedRequest,
    {
      ...participantRequestActor(requester),
      participantRequestDepth: 0,
      chainRootId: "chain-root"
    },
    "mcp"
  );
  conversation.messages.push(first.requestMessage);

  assert.equal(first.batch.depth, 1);
  assert.equal(first.batch.requesterDepth, 0);
  assert.equal(first.batch.chainRootId, "chain-root");

  const sibling = await chatParts(serviceAny).participantRequests.prepareParticipantRequest(
    conversation,
    requester,
    normalizedRequest,
    {
      ...participantRequestActor(requester),
      triggerMessageId: "resume-message",
      triggerThreadId: "resume-message",
      participantRequestDepth: first.batch.requesterDepth,
      chainRootId: first.batch.chainRootId
    },
    "mcp"
  );

  assert.equal(sibling.batch.depth, 1);
  assert.equal(sibling.batch.requesterDepth, 0);
  assert.equal(sibling.batch.chainRootId, first.batch.chainRootId);

  await assert.rejects(
    () => chatParts(serviceAny).participantRequests.prepareParticipantRequest(
      conversation,
      target,
      {
        requests: [{ target: requester.handle, prompt: "Please review." }],
        timeoutMs: 1000,
        resumeRequester: true
      },
      {
        ...participantRequestActor(target),
        triggerMessageId: "target-message",
        triggerThreadId: "target-message",
        participantRequestDepth: first.batch.depth,
        chainRootId: first.batch.chainRootId
      },
      "mcp"
    ),
    /max depth \(1\) reached/
  );
});

test("participant request chain guard limits one logical request chain", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "allow" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  const chainRootId = "chain-root";
  for (let index = 0; index < CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES; index += 1) {
    conversation.messages.push({
      id: `request-${index}`,
      role: "participant",
      participantId: requester.id,
      participantLabel: `@${requester.handle}`,
      content: "Request",
      createdAt: NOW,
      status: "done",
      metadata: {
        participantRequest: {
          id: `batch-${index}`,
          requesterParticipantId: requester.id,
          requesterHandle: requester.handle,
          source: "mcp",
          resumeRequester: true,
          status: "completed",
          depth: 1,
          requesterDepth: 0,
          chainRootId,
          createdAt: NOW,
          updatedAt: NOW,
          items: []
        }
      }
    });
  }
  const { service } = testService({ conversation });

  await assert.rejects(
    () => chatParts(service).participantRequests.prepareParticipantRequest(
      conversation,
      requester,
      {
        requests: [{ target: target.handle, prompt: "Please review." }],
        timeoutMs: 1000,
        resumeRequester: true
      },
      {
        ...participantRequestActor(requester),
        triggerMessageId: "new-request",
        chainRootId
      },
      "mcp"
    ),
    /member request chain limit \(24\) reached/
  );
});

for (const source of ["tool", "inferred", "approved"] as const) {
  test(`member ownership: ${source} requests run same-host targets here and ask the others of their own devices`, async () => {
    const requester = { ...chatParticipant("codex-cli", { requestParticipants: source === "approved" ? "ask" : "allow" }), homeMachineId: "machine-1" };
    const targets = [
      { ...chatParticipant("claude-code"), id: "same", handle: "same", homeMachineId: "machine-1" },
      { ...chatParticipant("claude-code"), id: "desktop", handle: "desktop" },
      { ...chatParticipant("claude-code"), id: "other", handle: "other", homeMachineId: "machine-2" }
    ];
    const conversation = chatConversation([requester, ...targets]);
    const native: string[] = [];
    const { service, storage, tempRoot } = testService({ conversation, run: async participant => {
      native.push(participant.id);
      return { participant, ok: true, content: "Answered here", durationMs: 1 };
    } });
    service.setHostMachineId("machine-1");
    chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
    const link = fakeServerLink("machine-1-device");
    service.setServerLink(link);
    if (source === "inferred") {
      const message = participantReplyMessage(requester, "inferred-source", "@same @desktop @other Please review.");
      conversation.messages.push(message);
      const requests = await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, requester, [message]);
      for (const m of conversation.messages) if (m.metadata?.participantRequest) m.metadata.participantRequest.resumeRequester = false;
      await storage.saveConversation(conversation);
      chatParts(service).participantRequests.startDeferredParticipantRequestRunners(conversation.id, requests);
    } else {
      void service.requestParticipantsFromTool(participantRequestActor(requester), {
        requests: targets.map(target => ({ target: target.handle, prompt: "Please review." })),
        timeoutMs: 5000, resumeRequester: false
      });
      if (source === "approved") {
        await waitFor(() => Boolean(storage.current.metadata.pendingAppToolApprovals?.[0]));
        const approval = storage.current.metadata.pendingAppToolApprovals[0];
        await service.respondToAppToolApproval({ conversationId: conversation.id, approvalId: approval.id, approve: true });
      }
    }
    const asked = () => link.ops.filter((op): op is Extract<HubOp, { kind: "turn.request" }> => op.kind === "turn.request");
    await waitFor(() => asked().length === 2, 2000);
    assert.deepEqual(asked().map((op) => op.participantId).sort(), ["desktop", "other"], "each asked of its own device on the server, never run here");
    for (const request of asked()) {
      const target = targets.find((item) => item.id === request.participantId)!;
      await memberDeviceAnswers(service, request, { participant: target, content: `Answered on ${target.id}`, deviceId: `${target.id}-device` });
    }
    await waitFor(() => storage.current.messages.some((m: ChatMessage) =>
      m.metadata?.participantRequest?.items.every(item => item.status === "answered")), 2000);
    assert.deepEqual(native, ["same"]);
  });
}

test("member ownership: copied replies cannot infer a second request", async () => {
  const requester = { ...chatParticipant("codex-cli", { requestParticipants: "allow" }), homeMachineId: "machine-2" };
  const target = { ...chatParticipant("claude-code"), homeMachineId: "machine-1" };
  const conversation = chatConversation([requester, target]);
  const message = participantReplyMessage(requester, "copied-reply", "@drew Please review.");
  conversation.messages.push(message);
  const { service } = testService({ conversation });
  service.setHostMachineId("machine-1");
  assert.deepEqual(await chatParts(service).inferredRequests.createImplicitParticipantRequestApproval(conversation, requester, [message]), []);
  assert.equal(conversation.messages.some(m => m.metadata?.participantRequest), false);
});

test("a requester a quit kept from resuming is resumed once the quit turns out not to happen", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  service.beginQuit();
  await chatParts(service).requesterResumes.autoResumeParticipantRequest(conversation.id, "request-1", undefined, { groupCheck: true });
  const resumed: unknown[][] = [];
  chatParts(service).requesterResumes.autoResumeParticipantRequest = async (...args: unknown[]) => { resumed.push(args); };
  service.endQuit();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0][0], conversation.id);
  assert.equal(resumed[0][1], "request-1");
  assert.deepEqual(resumed[0][3], { groupCheck: true });
  service.endQuit();
  assert.equal(resumed.length, 1, "once");
});
