import assert from "node:assert/strict";
import test from "node:test";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "./appMcp";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import type {
  ReviewProgress, ChatAgentActivityEvent, ChatAppToolApproval, ChatParticipant, ChatParticipantSession, Conversation
} from "../../shared/types";
import {
  chatConversation, chatParticipant, clone, completeParticipantRequest, inferredRequestMessages, liveTurn, NOW,
  participantReplyMessage, participantRequestActor, ROLE, runningReply, testService, turnActor
} from "./chat/test/permissionFixtures";

test("agent progress sink preserves the exact activity stream offset", () => {
  const service = testService().service as any;
  const intro = "Current EUR/RUB is";
  const full = "Current EUR/RUB is about 1 EUR = 89.88 RUB.";
  const sink = chatParts(service).pendingReplies.createAgentProgressSink("run-1", () => undefined, chatParticipant("codex-cli"), "message-1");

  sink.emit({ kind: "text", text: intro, cumulative: intro });
  sink.emit({ kind: "tool", text: "Using app_roles_describe_options" });
  sink.emit({ kind: "text", text: " about 1 EUR = 89.88 RUB.", cumulative: full });

  assert.equal(sink.activityEvents()[0].afterContentLength, intro.length);
});

test("agent progress sink preserves transcript without a visible progress callback", () => {
  const service = testService().service as any;
  const preamble = "I’ll inspect the existing renderer path first.";
  const final = "Final answer stays visible when collapsed.";
  const full = `${preamble}\n\n${final}`;
  const sink = chatParts(service).pendingReplies.createAgentProgressSink("run-1", undefined, chatParticipant("codex-cli"), "message-1");

  sink.beginAttempt();
  sink.emit({ kind: "text", text: preamble, cumulative: preamble });
  sink.emit({ kind: "tool", text: "Reading renderer state", activityKind: "tool" });
  sink.emit({ kind: "text", text: `\n\n${final}`, cumulative: full });

  assert.equal(sink.processingTranscript(NOW)?.content, full);
  assert.equal(sink.activityEvents()[0].label, "Reading renderer state");
  assert.equal(sink.activityEvents()[0].afterContentLength, preamble.length);
});

test("agent progress sink coalesces activity only by item id and caps retained activity", () => {
  const service = testService().service as any;
  const sink = chatParts(service).pendingReplies.createAgentProgressSink("run-1", undefined, chatParticipant("codex-cli"), "message-1");

  sink.emit({
    kind: "tool",
    text: "Updating files",
    activityKind: "file-edit",
    activityStatus: "started",
    activityDetail: "initial",
    activityItemId: "file-change-1"
  });
  sink.emit({
    kind: "tool",
    text: "Updating files",
    activityKind: "file-edit",
    activityStatus: "completed",
    activityDetail: "final",
    activityItemId: "file-change-1"
  });
  sink.emit({ kind: "tool", text: "Running command", activityKind: "command", activityDetail: "npm test" });
  sink.emit({ kind: "tool", text: "Running command", activityKind: "command", activityDetail: "npm test" });

  const initialEvents = sink.activityEvents();
  assert.deepEqual(initialEvents.map((event: ChatAgentActivityEvent) => [event.sequence, event.itemId, event.label, event.detail, event.status]), [
    [1, "file-change-1", "Updating files", "final", "completed"],
    [2, undefined, "Running command", "npm test", "started"],
    [3, undefined, "Running command", "npm test", "started"]
  ]);

  const longDetail = "x".repeat(4_100);
  for (let index = 0; index < 505; index += 1) {
    sink.emit({
      kind: "tool",
      text: `Using tool ${index}`,
      activityKind: "tool",
      activityDetail: index === 504 ? longDetail : undefined,
      activityItemId: `tool-${index}`
    });
  }

  const retained = sink.activityEvents();
  const transcript = sink.processingTranscript(NOW);
  assert.equal(retained.length, 500);
  assert.equal(retained[0].sequence, 9);
  assert.equal(retained.at(-1)?.sequence, 508);
  assert.equal(retained.at(-1)?.detail?.length, 4_000);
  assert.match(retained.at(-1)?.detail ?? "", /… \[\+122 chars omitted\]$/);
  assert.equal(transcript?.omittedActivityEventCount, 8);
});

test("agent progress sink: a step's words change as it ends, a label stays one bounded line, and one reply's details stay within budget", () => {
  const service = testService().service as any;
  // What the window gets with each live update: the whole list, so its
  // details must stay within the same budget on every one.
  let mostDetailsInOneUpdate = 0;
  const sink = chatParts(service).pendingReplies.createAgentProgressSink("run-1", (progress: ReviewProgress) => {
    const details = (progress.agentProgress?.activityEvents ?? []).reduce((sum, event) => sum + (event.detail?.length ?? 0), 0);
    mostDetailsInOneUpdate = Math.max(mostDetailsInOneUpdate, details);
  }, chatParticipant("codex-cli"), "message-1");
  sink.emit({ kind: "tool", text: "Running npm test", activityKind: "command", activityStatus: "started", activityDetail: "npm test", activityItemId: "cmd-1" });
  sink.emit({ kind: "tool", text: "Ran npm test", activityKind: "command", activityStatus: "completed", activityItemId: "cmd-1" });
  assert.deepEqual(sink.activityEvents().map((event: ChatAgentActivityEvent) => [event.itemId, event.label, event.detail, event.status]), [
    ["cmd-1", "Ran npm test", "npm test", "completed"]
  ]);
  sink.emit({ kind: "tool", text: `Running ${"y".repeat(1_500)}`, activityKind: "command" });
  const long = sink.activityEvents().at(-1);
  assert.equal(long.label.length, 1_000);
  assert.ok(long.label.endsWith("…"));

  // Rows whose label only names the kind of step show their detail's line.
  sink.emit({ kind: "tool", text: "Viewing image", activityKind: "tool", activityDetail: `/tmp/shot.png\n${"meta ".repeat(300)}`, activityItemId: "image-1" });
  sink.emit({ kind: "tool", text: "Thinking", activityKind: "status", activityDetail: `I need the rate first.\n${"more ".repeat(300)}`, activityItemId: "think-1" });
  for (let index = 0; index < 150; index += 1) {
    sink.emit({ kind: "tool", text: `Running step ${index}`, activityKind: "command", activityDetail: `${index}:${"z".repeat(1_795)}`, activityItemId: `step-${index}` });
  }
  const events: ChatAgentActivityEvent[] = sink.activityEvents();
  const totalDetails = events.reduce((sum, event) => sum + (event.detail?.length ?? 0), 0);
  assert.ok(totalDetails <= 24_000, `all details of one reply stay within the budget (${totalDetails})`);
  assert.ok(events.find((event) => event.itemId === "step-149")?.detail?.startsWith("149:"), "the newest steps keep their details");
  assert.equal(events.find((event) => event.itemId === "step-0")?.detail, undefined, "the oldest lose theirs first");
  assert.equal(events.find((event) => event.itemId === "step-0")?.label, "Running step 0", "and keep their words");
  assert.ok(events.find((event) => event.itemId === "image-1")?.detail?.startsWith("/tmp/shot.png\n"), "a row that shows its detail keeps it while others can go");
  assert.ok(events.find((event) => event.itemId === "think-1")?.detail?.startsWith("I need the rate first.\n"));
  // Past that, such rows are cut down to the line they show, oldest first.
  for (let index = 0; index < 40; index += 1) {
    sink.emit({ kind: "tool", text: "Viewing image", activityKind: "tool", activityDetail: `/tmp/shot-${index}.png\n${"meta ".repeat(300)}`, activityItemId: `image-${index + 2}` });
  }
  const later: ChatAgentActivityEvent[] = sink.activityEvents();
  assert.ok(later.reduce((sum, event) => sum + (event.detail?.length ?? 0), 0) <= 24_000);
  assert.equal(later.find((event) => event.itemId === "image-1")?.detail, "/tmp/shot.png", "the oldest keeps the line its row shows");
  assert.equal(later.find((event) => event.itemId === "think-1")?.detail, "I need the rate first.");
  assert.ok(later.find((event) => event.itemId === "image-41")?.detail?.startsWith("/tmp/shot-39.png\n"), "the newest keeps all of it");
  assert.ok(mostDetailsInOneUpdate > 24_000 - 1_800 && mostDetailsInOneUpdate <= 24_000,
    `a full update is trimmed to the budget, and none carries more (${mostDetailsInOneUpdate})`);
});

test("agent progress sink keeps in-progress formatted stream for visible runs", async () => {
  const service = testService().service as any;
  const progressItems: Array<{ partialContent?: string; activityEvents?: unknown[] }> = [];
  const preamble = "I’ll inspect the existing renderer path first.";
  const final = "Final answer stays visible when collapsed.";
  const full = `${preamble}\n\n${final}`;
  const sink = chatParts(service).pendingReplies.createAgentProgressSink(
    "run-1",
    (progress: { agentProgress?: { partialContent?: string; activityEvents?: unknown[] } }) => {
      progressItems.push({
        partialContent: progress.agentProgress?.partialContent,
        activityEvents: progress.agentProgress?.activityEvents
      });
    },
    chatParticipant("codex-cli"),
    "message-1"
  );

  sink.beginAttempt();
  sink.emit({ kind: "text", text: preamble, cumulative: preamble });
  sink.emit({ kind: "tool", text: "Reading renderer state", activityKind: "tool" });
  sink.emit({ kind: "text", text: `\n\n${final}`, cumulative: full });
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(progressItems.at(-1)?.partialContent, full);
  assert.equal(progressItems.at(-1)?.activityEvents?.length, 1);
  assert.equal(sink.processingTranscript(NOW)?.content, full);
});

test("agent progress sink coalesces rapid text updates and flushes the latest partial", async () => {
  const service = testService().service as any;
  const progressItems: Array<{ state?: string; partialContent?: string }> = [];
  const sink = chatParts(service).pendingReplies.createAgentProgressSink(
    "run-1",
    (progress: { agentProgress?: { state?: string; partialContent?: string } }) => {
      progressItems.push({
        state: progress.agentProgress?.state,
        partialContent: progress.agentProgress?.partialContent
      });
    },
    chatParticipant("codex-cli"),
    "message-1"
  );

  sink.beginAttempt();
  sink.emit({ kind: "text", text: "A", cumulative: "A" });
  sink.emit({ kind: "text", text: "B", cumulative: "AB" });
  assert.equal(progressItems.at(-1)?.partialContent, undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(progressItems.at(-1)?.partialContent, "AB");
  sink.finish();
});

test("agent progress sink emits finish immediately and suppresses pending flushes", async () => {
  const service = testService().service as any;
  const progressItems: Array<{ state?: string; partialContent?: string }> = [];
  const sink = chatParts(service).pendingReplies.createAgentProgressSink(
    "run-1",
    (progress: { agentProgress?: { state?: string; partialContent?: string } }) => {
      progressItems.push({
        state: progress.agentProgress?.state,
        partialContent: progress.agentProgress?.partialContent
      });
    },
    chatParticipant("codex-cli"),
    "message-1"
  );

  sink.beginAttempt();
  sink.emit({ kind: "text", text: "A", cumulative: "A" });
  sink.finish();

  assert.equal(progressItems.at(-1)?.state, "finished");
  assert.equal(progressItems.at(-2)?.partialContent, "A", "the final short burst precedes the finished marker");

  const countAfterFinish = progressItems.length;
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(progressItems.length, countAfterFinish);
});

test("agent progress sink preserves immediate tool start and completion between text flushes", () => {
  const service = testService().service as any;
  const observed: string[] = [];
  const sink = chatParts(service).pendingReplies.createAgentProgressSink("run-tool", (update: ReviewProgress) => {
    const status = update.agentProgress?.activityEvents?.at(-1)?.status;
    if (status) observed.push(status);
  }, chatParticipant("codex-cli"), "message-tool");
  sink.beginAttempt();
  sink.emit({ kind: "tool", text: "Command", activityKind: "command", activityItemId: "command-1", activityStatus: "started" });
  sink.emit({ kind: "tool", text: "Command", activityKind: "command", activityItemId: "command-1", activityStatus: "completed" });
  assert.deepEqual(observed, ["started", "completed"]);
  sink.finish();
});

test("participant prose mentioning blocked permissions does not create approval cards", async () => {
  const participant = chatParticipant("claude-code", {
    repoRead: false,
    workspaceWrite: false,
    webAccess: false
  });
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });

  const replies: any[] = [
    {
      id: "reply-1",
      role: "participant",
      participantId: participant.id,
      content: "I can't do that here - I need workspace edit access to save the file.",
      createdAt: NOW,
      status: "done",
      metadata: {
        threadId: "thread-1",
        sourceMessageId: "user-message"
      }
    },
    {
      id: "reply-2",
      role: "participant",
      participantId: participant.id,
      content: "I cannot edit files until write access is approved. A grant file editing card would be needed in older builds.",
      createdAt: NOW,
      status: "done",
      metadata: {
        threadId: "thread-1",
        sourceMessageId: "user-message"
      }
    },
    {
      id: "reply-3",
      role: "participant",
      participantId: participant.id,
      content: "Need web access and repository read permission to continue.",
      createdAt: NOW,
      status: "done",
      metadata: {
        threadId: "thread-1",
        sourceMessageId: "user-message"
      }
    }
  ];

  await chatParts(service).pendingReplies.appendParticipantTurnMessages(conversation, participant, replies);

  const approvals = ((conversation.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (item) => item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
  assert.equal(conversation.messages.some((message) => message.content.includes("Permission approval needed")), false);
});

test("a post's mention asks that member once; the reply's final words naming it again do not ask again", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([requester, target]);
  conversation.messages.push(runningReply(requester));
  const { service, storage } = testService({ conversation });
  liveTurn(service, requester);
  const turnCopy = clone(storage.current) as Conversation;
  await service.sendChatMessageFromTool(turnActor(requester, { capabilities: ["participants.request"] }), { content: "@drew please review X." });
  const asked = inferredRequestMessages(storage.current);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].metadata?.participantRequest?.triggerMessageId, "reply-1", "filed under the reply the post is part of");
  completeParticipantRequest(asked[0]);
  const turnReply = turnCopy.messages[1];
  turnReply.status = "done";
  turnReply.content = "I asked @drew to review X.";
  await chatParts(service).pendingReplies.finalizePendingParticipantMessage(turnCopy, requester, turnReply);
  assert.equal(inferredRequestMessages(storage.current).length, 1, "asked once");
});

test("mixed tool provenance logs each suppressed target with its deciding scope", async () => {
  const requester = chatParticipant("codex-cli", { requestParticipants: "ask" });
  const originTarget = chatParticipant("claude-code");
  const resumedRunTarget: ChatParticipant = {
    ...chatParticipant("claude-code"),
    id: "mixed-run-target",
    handle: "taylor"
  };
  const conversation = chatConversation([requester, originTarget, resumedRunTarget]);
  const { service, storage } = testService({ conversation });
  const debugEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
  chatDependencies(service).debugLogs.write = async (event: string, payload: Record<string, unknown>) => {
    debugEntries.push({ event, payload });
  };

  await service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId: "mixed-origin-run",
    turnSegmentId: "mixed-origin-segment"
  }, { content: "@drew do X." });
  const originRequest = inferredRequestMessages(storage.current)[0];
  const originBatchId = originRequest.metadata?.participantRequest?.id;
  assert.equal(typeof originBatchId, "string");
  completeParticipantRequest(originRequest);

  await service.sendChatMessageFromTool({
    ...participantRequestActor(requester),
    runId: "mixed-resume-run",
    turnSegmentId: "mixed-resume-segment",
    participantRequestBatchId: originBatchId
  }, { content: "@taylor do Y." });
  completeParticipantRequest(inferredRequestMessages(storage.current)[1]);

  const resumedFinal = participantReplyMessage(
    requester,
    "mixed-resumed-final",
    "@drew completed X; @taylor completed Y."
  );
  resumedFinal.metadata = {
    ...resumedFinal.metadata,
    runId: "mixed-resume-run",
    turnSegmentId: "mixed-resume-segment",
    participantRequestDepth: 1,
    participantRequestBatchId: originBatchId
  };
  await chatParts(service).pendingReplies.appendParticipantTurnMessages(storage.current, requester, [resumedFinal]);

  assert.equal(inferredRequestMessages(storage.current).length, 2);
  const suppressions = debugEntries.filter((entry) =>
    entry.event === "chat.participant-request.inferred-skipped-existing" &&
    entry.payload.messageId === resumedFinal.id
  );
  assert.deepEqual(
    suppressions.map((entry) => ({
      scope: entry.payload.decidingScope,
      targets: entry.payload.targets
    })),
    [
      { scope: "final-source-tool-origin-segment", targets: ["drew"] },
      { scope: "final-source-tool-origin-run", targets: ["taylor"] }
    ]
  );
});

test("existing pending preparation preserves optional provenance unless replacement context is provided", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const pending = participantReplyMessage(participant, "existing-provenance-pending", "");
  pending.status = "pending";
  pending.metadata = {
    ...pending.metadata,
    participantRequestBatchId: "existing-batch",
    participantRequestChainRootId: "existing-chain",
    queuedBehind: { handle: participant.handle }
  };
  conversation.messages.push(pending);
  const { service } = testService({ conversation });
  const cliParticipant = {
    id: participant.id,
    kind: participant.kind,
    label: `@${participant.handle}`,
    model: participant.model
  };

  const preserved = await chatParts(service).pendingReplies.prepareExistingPendingMessageForRun(
    conversation,
    pending,
    cliParticipant,
    conversation.messages[0],
    false,
    { turnSegmentId: "preserved-segment", participantRequestDepth: 1 }
  );
  assert.equal(preserved.metadata?.participantRequestBatchId, "existing-batch");
  assert.equal(preserved.metadata?.participantRequestChainRootId, "existing-chain");
  assert.equal(preserved.metadata?.queuedBehind, undefined);

  const replaced = await chatParts(service).pendingReplies.prepareExistingPendingMessageForRun(
    conversation,
    pending,
    cliParticipant,
    conversation.messages[0],
    false,
    {
      turnSegmentId: "replacement-segment",
      participantRequestDepth: 2,
      participantRequestBatchId: "replacement-batch",
      chainRootId: "replacement-chain"
    }
  );
  assert.equal(replaced.metadata?.participantRequestBatchId, "replacement-batch");
  assert.equal(replaced.metadata?.participantRequestChainRootId, "replacement-chain");
});

test("app MCP client failure clears provider session and advances generation", () => {
  const { service } = testService();
  const participant = chatParticipant("codex-cli");
  const session: ChatParticipantSession = {
    participantId: participant.id,
    sessionId: "provider-session-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    appMcpClientGeneration: 2,
    updatedAt: NOW
  };
  const warnings: string[] = [];

  chatParts(service).pendingReplies.applyCliRunMetadata(session, {
    participant: { id: participant.id, kind: "codex-cli", label: "@codex" },
    ok: true,
    content: "done",
    sessionId: "provider-session-2",
    appMcpClientFailed: true,
    warnings: ["@codex: app tools did not load for this run; the AccordAgents MCP bridge may be unreachable or stale."]
  }, participant, warnings);

  assert.equal(session.sessionId, "");
  assert.equal(session.appMcpClientGeneration, 3);
  assert.deepEqual(warnings, ["@codex: app tools did not load for this run; the AccordAgents MCP bridge may be unreachable or stale."]);
});
