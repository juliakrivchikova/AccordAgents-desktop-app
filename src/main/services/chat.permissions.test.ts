import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APP_CHAT_EXPORT_ATTACHMENT_TOOL,
  APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL,
  APP_CHAT_REACT_TOOL,
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
  APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
  APP_ROLES_REQUEST_CHANGE_TOOL,
  APP_TOOL_PERMISSION_TOOL,
  AppMcpService
} from "./appMcp";
import { ChatService } from "./chat";
import {
  chatAgentPermissionsEqual,
  defaultChatAgentPermissions,
  effectiveChatAgentPermissionsForProvider,
  normalizeChatAgentPermissions
} from "../../shared/agentPermissions";
import { CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS } from "../../shared/chatBehaviorRules";
import { CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT } from "../../shared/chatParticipantRequests";
import type {
  AgentHealth,
  AppSettings,
  ChatAppToolApproval,
  ChatAppToolApprovalPolicy,
  ChatBehaviorRuleConfig,
  ChatMessage,
  ChatParticipant,
  ChatParticipantConfig,
  ChatParticipantConfigUpdate,
  ChatParticipantSession,
  ChatProviderKind,
  ChatRoleChangeOperation,
  ChatRoleConfig,
  ChatRoleConfigUpdate,
  ChatSkillMention,
  Conversation,
  ParticipantConfig
} from "../../shared/types";
import {
  chatActivityEventsForSegment,
  chatInlineTranscriptParts,
  chatProcessingTranscriptPrefix,
  chatProcessingTranscriptView,
  chatProcessingTranscriptViewHasHidden
} from "../../shared/processingTranscript";

const NOW = "2026-05-17T12:00:00.000Z";

const ROLE: ChatRoleConfig = {
  id: "engineer",
  label: "Engineer",
  instructions: "Answer directly.",
  version: 1,
  appToolCapabilities: [],
  updatedAt: NOW
};

const ADMIN_ROLE: ChatRoleConfig = {
  id: "administrator",
  label: "Chat Assistant",
  instructions: "Help User set up chat participants.",
  version: 1,
  appToolCapabilities: ["participants.manage"],
  builtIn: true,
  updatedAt: NOW
};

test("permission normalization is idempotent and dedupes structured grants", () => {
  const raw = {
    repoRead: true,
    workspaceWrite: false,
    webAccess: false,
    shell: {
      enabled: true,
      rules: [
        { action: "allow", match: "prefix", pattern: "git diff" },
        { action: "allow", match: "prefix", pattern: "git diff" },
        { action: "ask", match: "exact", pattern: "npm test" }
      ]
    },
    providerNative: {
      "claude-code": {
        allowedTools: ["mcp__accord_agents__app_chat_read_messages", "mcp__accord_agents__app_chat_read_messages", "Read"]
      }
    }
  };

  const normalized = normalizeChatAgentPermissions(raw);

  assert.deepEqual(normalizeChatAgentPermissions(normalized), normalized);
  assert.deepEqual(normalized.shell.rules, [
    { action: "allow", match: "prefix", pattern: "git diff" },
    { action: "ask", match: "exact", pattern: "npm test" }
  ]);
  assert.deepEqual(normalized.providerNative?.["claude-code"]?.allowedTools, [
    "mcp__accord_agents__app_chat_read_messages",
    "Read"
  ]);
  assert.equal(chatAgentPermissionsEqual(normalized, raw as never), true);
});

test("processing transcript metadata preserves visible stream text", () => {
  const service = testService().service as any;

  assert.deepEqual(service.processingTranscriptFromContent("partial reply\n", NOW), {
    content: "partial reply",
    capturedAt: NOW,
    originalLength: "partial reply".length
  });
  assert.equal(service.processingTranscriptFromContent("   ", NOW), undefined);
});

test("processing transcript metadata caps oversized streams to the latest text", () => {
  const service = testService().service as any;
  const content = `${"a".repeat(100_010)}tail`;
  const transcript = service.processingTranscriptFromContent(content, NOW);

  assert.equal(transcript.content.length, 100_000);
  assert.equal(transcript.content.endsWith("tail"), true);
  assert.equal(transcript.originalLength, content.length);
  assert.equal(transcript.retainedStart, content.length - 100_000);
  assert.equal(transcript.truncated, true);
});

test("processing transcript metadata records omitted activity event count", () => {
  const service = testService().service as any;
  const transcript = service.processingTranscriptFromContent("partial reply", NOW, { omittedActivityEventCount: 3 });

  assert.equal(transcript.omittedActivityEventCount, 3);
});

test("processing transcript expansion hides when transcript only contains the final answer", () => {
  const final = "Current EUR/RUB is about **89.8 RUB for 1 EUR**.";

  assert.equal(chatProcessingTranscriptPrefix(final, final), "");
  assert.equal(chatProcessingTranscriptPrefix(`\n${final}\n`, final), "");
});

test("processing transcript expansion returns only text before the final answer", () => {
  const final = "Final answer.";

  assert.equal(chatProcessingTranscriptPrefix(`Checking source...\n\n${final}`, final), "Checking source...");
});

test("processing transcript view keeps preamble hidden and final answer last", () => {
  const preamble = "I’ll check the existing settings first.\n\nSo far: settings are persisted through SettingsService.";
  const final = "Add a first-class `userProfile` setting.";
  const view = chatProcessingTranscriptView(`${preamble}\n\n${final}`, final);

  assert.deepEqual(view.leadingSegments.map((segment) => segment.content), [preamble]);
  assert.equal(view.finalSegment?.content, final);
  assert.equal(view.renderFinalContent, true);
});

test("processing transcript view keeps stored content verbatim for heuristic-looking final answers", () => {
  const content = "I'll check the box on Friday — that's my final recommendation, ship it.\n\nThe deploy window is clear.";
  const view = chatProcessingTranscriptView(content, content);

  assert.equal(view.leadingSegments.length, 0);
  assert.equal(view.finalSegment?.content, content);
  assert.equal(view.renderFinalContent, true);
});

test("processing transcript view does not collapse multi-step final answers to a fragment", () => {
  const content = "I'll create the schema first.\n\nThen I'll verify it.\n\nDone.";
  const view = chatProcessingTranscriptView(content, content);

  assert.equal(view.leadingSegments.length, 0);
  assert.equal(view.finalSegment?.content, content);
});

test("processing transcript view does not split markdown fences with paragraph heuristics", () => {
  const content = "I'll show the exact block:\n\n```ts\nconst value = 1;\n\nconst next = 2;\n```\n\nUse both values.";
  const view = chatProcessingTranscriptView(content, content);

  assert.equal(view.finalSegment?.content, content);
  assert.equal(view.leadingSegments.length, 0);
});

test("processing transcript view keeps all-processing-looking content intact", () => {
  const content = "Checking the release notes.\n\nOK";
  const view = chatProcessingTranscriptView(content, content);

  assert.equal(view.finalSegment?.content, content);
  assert.equal(view.renderFinalContent, true);
});

test("processing transcript activity events are interleaved before and inside the final answer", () => {
  const first = "I’ll check the available roles first so I don’t duplicate an existing medical-specialist role, then I’ll request the new role for app approval.";
  const second = "No existing specialist role matches this, so I’m creating a custom `Gastroenterologist` role with medical-safety boundaries and practical digestive-health guidance.";
  const final = "Requested a new `Gastroenterologist` role. It’s pending your approval in the app.";
  const content = [first, second, final].join("\n\n");
  const prefix = chatProcessingTranscriptPrefix(content, final);
  const view = chatProcessingTranscriptView(content, final);
  const events = [
    { id: "describe", sequence: 1, kind: "tool" as const, label: "Using app_roles_describe_options", createdAt: NOW, afterContentLength: first.length },
    { id: "request", sequence: 2, kind: "tool" as const, label: "Using app_roles_request_change", createdAt: NOW, afterContentLength: [first, second].join("\n\n").length },
    { id: "final", sequence: 3, kind: "tool" as const, label: "Using final_check", createdAt: NOW, afterContentLength: content.length - 12 }
  ];
  const prefixSegment = view.leadingSegments[0];
  const finalSegment = view.finalSegment!;

  const prefixEvents = chatActivityEventsForSegment(events, prefixSegment);
  const finalEvents = chatActivityEventsForSegment(events, finalSegment);
  const parts = chatInlineTranscriptParts(prefix, events, prefixSegment);

  assert.equal(prefix, [first, second].join("\n\n"));
  assert.equal(view.renderFinalContent, true);
  assert.deepEqual(prefixEvents.map((event) => event.id), ["describe", "request"]);
  assert.deepEqual(finalEvents.map((event) => event.id), ["final"]);
  assert.deepEqual(parts.map((part) => part.kind === "activity" ? part.event.id : part.text.trim()), [
    first,
    "describe",
    second,
    "request"
  ]);
});

test("inline transcript snaps activity rows to the next sentence boundary", () => {
  const firstSentence = "Current EUR/RUB is about 1 EUR = 89.88 RUB.";
  const content = `${firstSentence} Next sentence.`;
  const event = {
    id: "search",
    sequence: 1,
    kind: "web" as const,
    label: "Using web search",
    createdAt: NOW,
    afterContentLength: "Current EUR/RUB is".length
  };
  const parts = chatInlineTranscriptParts(content, [event]);

  assert.deepEqual(parts.map((part) => part.kind === "activity" ? `${part.event.id}:${part.event.afterContentLength}` : part.text), [
    firstSentence,
    `search:${firstSentence.length}`,
    " Next sentence."
  ]);
});

test("inline transcript anchors activity rows at segment end when no boundary follows", () => {
  const content = "Streaming without terminal boundary";
  const event = {
    id: "tool",
    sequence: 1,
    kind: "tool" as const,
    label: "Using tool",
    createdAt: NOW,
    afterContentLength: "Streaming".length
  };
  const parts = chatInlineTranscriptParts(content, [event]);

  assert.deepEqual(parts.map((part) => part.kind === "activity" ? `${part.event.id}:${part.event.afterContentLength}` : part.text), [
    content,
    `tool:${content.length}`
  ]);
});

test("inline transcript preserves sequence for multiple activities in one sentence", () => {
  const content = "Current EUR/RUB is about 1 EUR = 89.88 RUB.";
  const events = [
    { id: "search", sequence: 1, kind: "web" as const, label: "Using web search", createdAt: NOW, afterContentLength: "Current EUR/RUB is".length },
    { id: "read", sequence: 2, kind: "tool" as const, label: "Reading result", createdAt: NOW, afterContentLength: "Current EUR/RUB is about".length }
  ];
  const parts = chatInlineTranscriptParts(content, events);

  assert.deepEqual(parts.map((part) => part.kind === "activity" ? `${part.event.id}:${part.event.afterContentLength}` : part.text), [
    content,
    `search:${content.length}`,
    `read:${content.length}`
  ]);
});

test("inline transcript treats parenthetical citations as sentence boundaries", () => {
  const firstParagraph = "Current EUR/RUB is about 1 EUR = 89.88 RUB. (exchange-rates.org)";
  const secondParagraph = "For comparison, the Bank of Russia official rate is 87.4027 RUB per EUR. (cbr.ru)";
  const content = `${firstParagraph}\n\n${secondParagraph}`;
  const event = {
    id: "search",
    sequence: 1,
    kind: "web" as const,
    label: "Using web search",
    createdAt: NOW,
    afterContentLength: "Current EUR/RUB is".length
  };
  const parts = chatInlineTranscriptParts(content, [event]);

  assert.deepEqual(parts.map((part) => part.kind === "activity" ? `${part.event.id}:${part.event.afterContentLength}` : part.text), [
    firstParagraph,
    `search:${firstParagraph.length}`,
    `\n\n${secondParagraph}`
  ]);
});

test("processing transcript expansion exposes activity-only hidden material", () => {
  const final = "Final answer.";
  const view = chatProcessingTranscriptView(final, final);
  const events = [
    { id: "tool", sequence: 1, kind: "tool" as const, label: "Using web search", createdAt: NOW }
  ];

  assert.equal(chatProcessingTranscriptPrefix(final, final), "");
  assert.equal(chatProcessingTranscriptViewHasHidden(view, events), true);
  assert.deepEqual(chatActivityEventsForSegment(events, view.finalSegment!).map((event) => event.id), ["tool"]);
});

test("processing transcript expansion never duplicates a non-trailing final answer", () => {
  const final = "Final answer.";
  const transcript = `Setup.\n\n${final}\n\nFollow-up tool output.`;
  const view = chatProcessingTranscriptView(transcript, final);

  assert.equal(view.renderFinalContent, false);
  assert.equal(view.leadingSegments[0].content, transcript);
  assert.equal(chatProcessingTranscriptPrefix(transcript, final), "");
});

test("processing transcript boundary activity belongs to the final segment only", () => {
  const prefix = "I will use a tool.";
  const final = "Final answer.";
  const transcript = `${prefix}\n\n${final}`;
  const view = chatProcessingTranscriptView(transcript, final);
  const event = {
    id: "tool",
    sequence: 1,
    kind: "tool" as const,
    label: "Using final_check",
    createdAt: NOW,
    afterContentLength: prefix.length + 2
  };

  assert.deepEqual(chatActivityEventsForSegment([event], view.leadingSegments[0]).map((item) => item.id), []);
  assert.deepEqual(chatActivityEventsForSegment([event], view.finalSegment!).map((item) => item.id), ["tool"]);
  assert.deepEqual(chatInlineTranscriptParts(final, [event], view.finalSegment!).map((part) => part.kind === "activity" ? part.event.id : part.text), [
    "tool",
    final
  ]);
});

test("processing transcript view surfaces truncation and rebases retained offsets", () => {
  const view = chatProcessingTranscriptView("retained text", "retained text", {
    retainedStart: 50,
    truncated: true,
    omittedActivityEventCount: 2
  });
  const events = [
    { id: "old", sequence: 1, kind: "tool" as const, label: "Old", createdAt: NOW, afterContentLength: 10 },
    { id: "kept", sequence: 2, kind: "tool" as const, label: "Kept", createdAt: NOW, afterContentLength: 58 }
  ];

  assert.deepEqual(view.notices, ["Earlier stream output omitted.", "2 earlier activities omitted."]);
  assert.deepEqual(chatActivityEventsForSegment(events, view.finalSegment!).map((event) => `${event.id}:${event.afterContentLength}`), ["kept:8"]);
});

test("agent progress sink preserves the exact activity stream offset", () => {
  const service = testService().service as any;
  const intro = "Current EUR/RUB is";
  const full = "Current EUR/RUB is about 1 EUR = 89.88 RUB.";
  const sink = service.createAgentProgressSink("run-1", () => undefined, chatParticipant("codex-cli"), "message-1");

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
  const sink = service.createAgentProgressSink("run-1", undefined, chatParticipant("codex-cli"), "message-1");

  sink.beginAttempt();
  sink.emit({ kind: "text", text: preamble, cumulative: preamble });
  sink.emit({ kind: "tool", text: "Reading renderer state", activityKind: "tool" });
  sink.emit({ kind: "text", text: `\n\n${final}`, cumulative: full });

  assert.equal(sink.processingTranscript(NOW)?.content, full);
  assert.equal(sink.activityEvents()[0].label, "Reading renderer state");
  assert.equal(sink.activityEvents()[0].afterContentLength, preamble.length);
});

test("agent progress sink keeps in-progress formatted stream for visible runs", async () => {
  const service = testService().service as any;
  const progressItems: Array<{ partialContent?: string; activityEvents?: unknown[] }> = [];
  const preamble = "I’ll inspect the existing renderer path first.";
  const final = "Final answer stays visible when collapsed.";
  const full = `${preamble}\n\n${final}`;
  const sink = service.createAgentProgressSink(
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
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(progressItems.at(-1)?.partialContent, full);
  assert.equal(progressItems.at(-1)?.activityEvents?.length, 1);
  assert.equal(sink.processingTranscript(NOW)?.content, full);
});

test("applyPreparedPermissionChange is the merge-additions path for shell rules and Claude native tools", () => {
  const service = testService().service as any;
  const participant = chatParticipant("claude-code", {
    shell: {
      enabled: true,
      rules: [{ action: "allow", match: "prefix", pattern: "git status" }]
    },
    providerNative: {
      "claude-code": {
        allowedTools: ["Read"]
      }
    }
  });
  const conversation = chatConversation([participant]);

  const shellPrepared = service.preparePermissionChange(participant, {
    kind: "shellRules",
    rules: [
      { action: "allow", match: "prefix", pattern: "git status" },
      { action: "allow", match: "prefix", pattern: "git diff" }
    ]
  });
  service.applyPreparedPermissionChange(conversation, participant.id, shellPrepared);

  const participantAfterShell = (conversation.metadata.participants as ChatParticipant[])[0];
  const nativePrepared = service.preparePermissionChange(participantAfterShell, {
    kind: "providerNative",
    provider: "claude-code",
    allowedTools: ["Read", "mcp__accord_agents__app_chat_read_messages"]
  });
  service.applyPreparedPermissionChange(conversation, participant.id, nativePrepared);

  const permissions = normalizeChatAgentPermissions((conversation.metadata.participants as ChatParticipant[])[0].permissions);
  assert.deepEqual(permissions.shell.rules, [
    { action: "allow", match: "prefix", pattern: "git status" },
    { action: "allow", match: "prefix", pattern: "git diff" }
  ]);
  assert.deepEqual(permissions.providerNative?.["claude-code"]?.allowedTools, [
    "Read",
    "mcp__accord_agents__app_chat_read_messages"
  ]);
});

test("provider-native and wildcard denylist validation rejects unsafe requests", () => {
  const service = testService().service as any;
  const codex = chatParticipant("codex-cli");
  const claude = chatParticipant("claude-code");

  assert.throws(() => service.preparePermissionChange(codex, {
    kind: "providerNative",
    provider: "claude-code",
    allowedTools: ["Read"]
  }), /only be approved for Claude Code participants/);

  for (const token of ["Bash(*)", "*", "mcp__server__*"]) {
    assert.throws(() => service.preparePermissionChange(claude, {
      kind: "providerNative",
      provider: "claude-code",
      allowedTools: [token]
    }), /too broad/);
  }

  assert.throws(() => service.preparePermissionChange(claude, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "*" }]
  }), /too broad/);
});

test("one-time permission overlay is consumed after one run projection", () => {
  const service = testService().service as any;
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved"
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const appliedIds: string[] = [];

  const projected = service.participantPermissionsForRun(conversation, participant, undefined, appliedIds);
  assert.equal(projected.shell.enabled, true);
  assert.deepEqual(projected.shell.rules, [{ action: "allow", match: "prefix", pattern: "git diff" }]);
  assert.deepEqual(appliedIds, [approval.id]);

  service.consumeOneTimePermissionApprovals(conversation, participant, appliedIds);
  const consumedApproval = (conversation.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0];
  assert.equal(Boolean(consumedApproval?.consumedAt), true);

  const after = service.participantPermissionsForRun(conversation, participant);
  assert.equal(after.shell.enabled, false);
  assert.deepEqual(after.shell.rules, []);
});

test("repoRead is a portable permission grant", () => {
  const service = testService().service as any;
  const participant = chatParticipant("claude-code", { repoRead: false });
  const conversation = chatConversation([participant]);

  const prepared = service.preparePermissionChange(participant, {
    kind: "portable",
    permissions: ["repoRead"]
  });
  service.applyPreparedPermissionChange(conversation, participant.id, prepared);

  const permissions = normalizeChatAgentPermissions((conversation.metadata.participants as ChatParticipant[])[0].permissions);
  assert.equal(permissions.repoRead, true);
  assert.equal(prepared.summary.includes("repository read access"), true);
});

test("structured permission request creates exactly one approval card", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "run-42",
    triggerMessageId: "user-message"
  }, {
    kind: "portable",
    permissions: ["webAccess"],
    reason: "Need live web lookup to answer this request."
  });

  assert.equal(result.status, "pending_user_approval");

  const approvals = (storage.current.metadata.pendingAppToolApprovals as ChatAppToolApproval[]).filter(
    (approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.deepEqual(approvals[0].request, {
    kind: "portable",
    reason: "Need live web lookup to answer this request.",
    permissions: ["webAccess"]
  });
  assert.equal(approvals[0].resumeContext?.runId, "run-42");
  assert.equal(approvals[0].resumeContext?.triggerMessageId, "user-message");
});

test("tool permission request waits for user approval and returns allow once", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const pending = service.requestToolPermissionFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "run-42",
    triggerMessageId: "user-message"
  }, {
    tool_name: "mcp__slack__slack_send_message",
    input: { channel_id: "C1", text: "Ship it" },
    reason: "Send the approved update."
  });

  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some(
      (approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL && approval.status === "pending"
    )
  );
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
  )!;
  assert.deepEqual(approval.request, {
    kind: "toolPermission",
    reason: "Send the approved update.",
    toolName: "mcp__slack__slack_send_message",
    toolInput: { channel_id: "C1", text: "Ship it" }
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "once"
  });

  assert.deepEqual(await pending, {
    behavior: "allow",
    updatedInput: { channel_id: "C1", text: "Ship it" }
  });
  const updatedApproval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (item) => item.id === approval.id
  )!;
  assert.equal(updatedApproval.status, "approved");
  assert.equal(updatedApproval.approvalScope, "once");
});

test("tool permission chat approval reuses policy for the same participant and tool", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    runId: "run-42",
    triggerMessageId: "user-message"
  };

  const pending = service.requestToolPermissionFromTool(actor, {
    tool_name: "mcp__atlassian__search",
    input: { query: "roadmap" }
  });
  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some(
      (approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL && approval.status === "pending"
    )
  );
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
  )!;
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "chat"
  });
  assert.deepEqual(await pending, {
    behavior: "allow",
    updatedInput: { query: "roadmap" }
  });

  const second = await service.requestToolPermissionFromTool({
    ...actor,
    runId: "run-43"
  }, {
    tool_name: "mcp__atlassian__search",
    input: { query: "incidents" }
  });

  assert.deepEqual(second, {
    behavior: "allow",
    updatedInput: { query: "incidents" }
  });
  const toolApprovals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
  );
  assert.equal(toolApprovals.length, 1);
  assert.equal(((storage.current.metadata.appToolApprovalPolicies ?? []) as ChatAppToolApprovalPolicy[])[0].targetToolName, "mcp__atlassian__search");
});

test("tool permission request denies and marks approval when run is cancelled", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const runController = new AbortController();
  (service as any).registerTargetRun("run-42", runController, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  const pending = service.requestToolPermissionFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "run-42",
    triggerMessageId: "user-message"
  }, {
    tool_name: "mcp__slack__slack_send_message",
    input: { channel_id: "C1", text: "Ship it" }
  });

  await waitFor(() =>
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).some(
      (approval) => approval.toolName === APP_TOOL_PERMISSION_TOOL && approval.status === "pending"
    )
  );

  assert.equal(service.cancelRun("run-42"), true);
  assert.deepEqual(await pending, {
    behavior: "deny",
    message: "Tool permission request was cancelled because the chat run stopped."
  });
  const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
    (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
  )!;
  assert.equal(approval.status, "denied");
  assert.equal(approval.error, "Tool permission request was cancelled because the chat run stopped.");
});

test("tool permission request denies and marks approval on timeout", async (t) => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  (t.mock.timers as any).enable(["setTimeout"]);
  try {
    const pending = service.requestToolPermissionFromTool({
      conversationId: conversation.id,
      participantId: participant.id,
      roleConfigId: participant.roleConfigId,
      roleConfigVersion: 0,
      capabilities: ["permissions.request"],
      runId: "run-42",
      triggerMessageId: "user-message"
    }, {
      tool_name: "mcp__atlassian__search",
      input: { query: "incidents" }
    });

    await flushMicrotasks();
    const approval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
      (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
    );
    assert.equal(approval?.status, "pending");

    (t.mock.timers as any).tick(30 * 60_000);
    assert.deepEqual(await pending, {
      behavior: "deny",
      message: "Timed out waiting for User approval."
    });
    const updatedApproval = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).find(
      (item) => item.toolName === APP_TOOL_PERMISSION_TOOL
    )!;
    assert.equal(updatedApproval.status, "denied");
    assert.equal(updatedApproval.error, "Timed out waiting for User approval.");
  } finally {
    (t.mock.timers as any).reset();
  }
});

test("auto mode treats in-preset permission requests as already granted", async () => {
  // The Auto-review launch profile already grants repo read / workspace write / web,
  // so an in-preset request must report already_granted instead of producing a
  // spurious auto-applied approval and an unnecessary session relaunch (C6).
  const runs: ParticipantConfig[] = [];
  const participant = chatParticipant("claude-code", { webAccess: false });
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return {
        participant: runParticipant,
        ok: true,
        content: "ok",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "auto-run",
    triggerMessageId: "user-message"
  }, {
    kind: "portable",
    permissions: ["webAccess"],
    reason: "Need live lookup."
  });

  assert.equal(result.status, "already_granted");
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: Conversation["messages"][number]) =>
    message.content.includes("Permission approval needed")
  ), false);
});

test("switching an existing session to auto adopts the mode on the next resumed turn", async () => {
  const runs: Array<{ options: any }> = [];
  const participant = chatParticipant("codex-cli");
  assert.equal(participant.agentMode, "default");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      return {
        participant: runParticipant,
        ok: true,
        content: "ok",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, runId: "run-default", content: "@codex hello" });
  await waitFor(() => runs.length === 1);
  // First turn runs in default mode and seeds a provider session id.
  assert.equal(runs[0].options.agentMode, "default");
  assert.ok(!runs[0].options.sessionId);

  // Flip the persisted participant to Auto-review, then send another message.
  const persisted = storage.current.metadata.participants.find((item: ChatParticipant) => item.id === participant.id);
  persisted.agentMode = "auto";

  await service.sendMessage({ conversationId: conversation.id, runId: "run-auto", content: "@codex again" });
  await waitFor(() => runs.length === 2);
  // The new mode must be adopted (not frozen at the session's original mode)...
  assert.equal(runs[1].options.agentMode, "auto");
  // ...while still resuming the same provider session (no reset / no lost context).
  // The provider re-asserts the new profile on resume.
  assert.equal(runs[1].options.sessionId, "session-1");
  // The launched options resolve to the Auto-review preset through the shared helper.
  const effective = effectiveChatAgentPermissionsForProvider("codex-cli", runs[1].options.agentMode, runs[1].options.permissions);
  assert.equal(effective.workspaceWrite, true);
  assert.equal(effective.webAccess, true);
});

test("reported provider session id is persisted even if the first turn fails", async () => {
  const runs: Array<{ options: any }> = [];
  const earlySessionId = "11111111-1111-4111-8111-111111111111";
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      if (runs.length === 1) {
        options.onSessionId?.(earlySessionId);
        throw new Error("provider failed after session start");
      }
      return {
        participant: runParticipant,
        ok: true,
        content: "ok",
        durationMs: 1,
        sessionId: earlySessionId
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await assert.rejects(
    () => (service as any).runParticipantTurnSerialized(
      conversation,
      participant,
      conversation.messages[0],
      "failed-first-turn",
      undefined,
      undefined,
      { warnings: [] }
    ),
    /provider failed after session start/
  );

  await waitFor(() =>
    storage.current.metadata.participantSessions?.some((session: any) =>
      session.participantId === participant.id && session.sessionId === earlySessionId
    )
  );

  await (service as any).runParticipantTurnSerialized(
    conversation,
    participant,
    conversation.messages[0],
    "second-turn",
    undefined,
    undefined,
    { warnings: [] }
  );

  assert.equal(runs.length, 2);
  assert.equal(runs[1].options.sessionId, earlySessionId);
});

test("non-batch participant turns record pending bubbles as last-message pointer", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const trigger: ChatMessage = {
    id: "thread-trigger",
    role: "user",
    content: "Thread follow up.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "user-message",
      parentMessageId: "user-message",
      chatThreadRootId: "user-message"
    }
  };
  conversation.messages.push(trigger);
  const snapshots: Conversation[] = [];
  let runStarted = false;
  let releaseRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    run: async (runParticipant) => {
      runStarted = true;
      await runCanFinish;
      return {
        participant: runParticipant,
        ok: true,
        content: "Thread answer.",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const turn = (service as any).runParticipantTurnSerialized(
    conversation,
    participant,
    trigger,
    "thread-continuation-run",
    undefined,
    undefined,
    { continuation: true, warnings: [] }
  );

  await waitFor(() =>
    runStarted &&
    storage.current.messages.some((message: ChatMessage) =>
      message.role === "participant" &&
      message.participantId === participant.id &&
      message.status === "pending"
    )
  );

  const pending = storage.current.messages.find((message: ChatMessage) =>
    message.role === "participant" &&
    message.participantId === participant.id &&
    message.status === "pending"
  )!;
  const pendingPointer = storage.current.metadata.lastMessageByParticipant?.[participant.id];
  assert.equal(pendingPointer?.messageId, pending.id);
  assert.equal(pendingPointer?.threadRootId, "user-message");

  await waitFor(() =>
    snapshots.some((snapshot) =>
      snapshot.metadata.lastMessageByParticipant?.[participant.id]?.messageId === pending.id
    )
  );
  const snapshotPointer = snapshots.find((snapshot) =>
    snapshot.metadata.lastMessageByParticipant?.[participant.id]?.messageId === pending.id
  )!.metadata.lastMessageByParticipant![participant.id];
  assert.equal(snapshotPointer.threadRootId, "user-message");

  releaseRun();
  const messages = await turn;
  assert.equal(messages[0]?.id, pending.id);
  await waitFor(() =>
    storage.current.messages.some((message: ChatMessage) =>
      message.id === pending.id &&
      message.status === "done" &&
      message.content === "Thread answer."
    )
  );
  const completedPointer = storage.current.metadata.lastMessageByParticipant?.[participant.id];
  assert.equal(completedPointer?.messageId, pending.id);
  assert.equal(completedPointer?.threadRootId, "user-message");
});

test("auto mode handles shell permission requests via native auto without a user approval", async () => {
  const participant = chatParticipant("claude-code");
  participant.agentMode = "auto";
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "auto-shell-run",
    triggerMessageId: "user-message"
  }, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }],
    reason: "Need shell."
  });

  // Auto-review delegates shell decisions to the native auto classifier, so a shellRules
  // request is reported already-handled and creates no pending User approval.
  assert.equal(result.status, "already_granted");
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
});

test("permission resume attaches resumed participant-request reply to the original batch", async () => {
  const runs: Array<{ participant: ParticipantConfig; options: any; prompt: string }> = [];
  const participant = chatParticipant("claude-code");
  const trigger = {
    id: "request-message",
    role: "system" as const,
    content: "@drew Run git diff.",
    createdAt: NOW,
    status: "done" as const,
    metadata: {
      threadId: "thread-1",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: "requester",
        requesterHandle: "codex",
        source: "mcp" as const,
        resumeRequester: false,
        status: "running" as const,
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "user-message",
        items: [{
          targetParticipantId: participant.id,
          targetHandle: participant.handle,
          prompt: "Run git diff.",
          status: "running" as const,
          replyMessageId: "pending-reply",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  };
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: trigger.id,
      participantRequestBatchId: "batch-1"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  conversation.messages.push(trigger);
  const progressEvents: Array<{ runId: string; phase: string; message: string; agentProgress?: { state: string } }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ participant: runParticipant, prompt, options });
      return {
        participant: runParticipant,
        ok: true,
        content: "Finished after approval.",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).autoResumePermissionApproval(conversation.id, approval.id, (progress: typeof progressEvents[number]) => {
    progressEvents.push(progress);
  });
  await waitFor(() => runs.length === 1 && storage.current.messages.some(
    (message: Conversation["messages"][number]) => message.content === "Finished after approval."
  ));

  assert.equal(runs.length, 1);
  assert.equal(runs[0].prompt.includes("Message ID: request-message"), true);
  assert.equal(runs[0].options.permissions.shell.enabled, true);
  assert.deepEqual(runs[0].options.permissions.shell.rules, [{ action: "allow", match: "prefix", pattern: "git diff" }]);
  const saved = storage.current;
  const batch = saved.messages.find((message: Conversation["messages"][number]) => message.id === trigger.id)?.metadata?.participantRequest;
  const reply = saved.messages.find((message: Conversation["messages"][number]) => message.content === "Finished after approval.");
  assert.equal(saved.metadata.running, false);
  assert.equal(saved.metadata.runId, undefined);
  assert.equal(batch?.status, "answered");
  assert.equal(batch?.items[0].status, "answered");
  assert.equal(batch?.items[0].replyMessageId, reply?.id);
  assert.equal(saved.metadata.pendingAppToolApprovals[0].consumedAt.length > 0, true);
  assert.equal(progressEvents[0]?.runId, "blocked-run");
  assert.equal(progressEvents[0]?.phase, "initial");
  assert.equal(progressEvents.some((event) => event.agentProgress?.state === "running"), true);
  assert.equal(progressEvents.at(-1)?.phase, "done");
});

test("permission resume clears running and emits terminal error when resumed participant fails", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const progressEvents: Array<{ runId: string; phase: string; message: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async () => {
      throw new Error("resume exploded");
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).autoResumePermissionApproval(
    conversation.id,
    approval.id,
    (progress: typeof progressEvents[number]) => {
      progressEvents.push(progress);
    }
  );
  await waitFor(() =>
    progressEvents.some((item) => item.phase === "error" && item.message === "resume exploded") &&
    storage.current.metadata.running === false
  );

  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(progressEvents.some((item) => item.phase === "error" && item.message === "resume exploded"), true);
});

test("permission resume registers a cancellable chat run controller", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "shellRules",
    rules: [{ action: "allow", match: "prefix", pattern: "git diff" }]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let capturedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, signal: AbortSignal | undefined) => {
      capturedSignal = signal;
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        participant: runParticipant,
        ok: false,
        content: "",
        error: "cancelled",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const resume = (service as any).autoResumePermissionApproval(conversation.id, approval.id);
  await started;
  await waitFor(() => {
    const pending = storage.current.messages.find((message: ChatMessage) =>
      message.role === "participant" &&
      message.participantId === participant.id &&
      message.status === "pending"
    );
    return Boolean(pending && storage.current.metadata.lastMessageByParticipant?.[participant.id]?.messageId === pending.id);
  });
  const pendingMessageId = storage.current.metadata.lastMessageByParticipant?.[participant.id]?.messageId;

  assert.equal(service.cancelRun("blocked-run"), true);
  await resume;
  await waitFor(() => storage.current.metadata.running === false);

  assert.equal(capturedSignal?.aborted, true);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  const stoppedMessage = storage.current.messages.find((message: ChatMessage) => message.role === "participant");
  assert.equal(stoppedMessage?.status, "error");
  assert.equal(stoppedMessage?.metadata?.terminalReason, "user-stopped");
  assert.equal(stoppedMessage?.content, "@drew stopped by user.");
  assert.equal(stoppedMessage?.id, pendingMessageId);
  assert.equal(storage.current.metadata.lastMessageByParticipant?.[participant.id]?.messageId, stoppedMessage?.id);
});

test("approved permission resume ignores duplicate concurrent resume attempts", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "auto-resume-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let runCount = 0;
  let releaseRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      await runCanFinish;
      return {
        participant: runParticipant,
        ok: true,
        content: "Finished auto-applied resume.",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const first = (service as any).autoResumePermissionApproval(conversation.id, approval.id);
  const second = (service as any).autoResumePermissionApproval(conversation.id, approval.id);
  await waitFor(() => runCount === 1);
  await Promise.all([first, second]);
  releaseRun();
  await waitFor(() => storage.current.metadata.running === false);

  assert.equal(runCount, 1);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].consumedAt.length > 0, true);
});

test("permission resume waits behind an in-flight same-participant turn", async () => {
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "auto-resume-run",
      triggerMessageId: "user-message"
    }
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  let runStarted = false;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runStarted = true;
      return {
        participant: runParticipant,
        ok: true,
        content: "resumed",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  // Simulate an in-flight turn for the same participant holding the per-participant
  // serialization queue; the resume must serialize behind it via participantTurnQueues.
  const queueKey = `${conversation.id}:${participant.id}`;
  let releaseInFlight!: () => void;
  (service as any).participantTurnQueues.set(queueKey, new Promise<void>((resolve) => {
    releaseInFlight = resolve;
  }));

  const resume = (service as any).autoResumePermissionApproval(conversation.id, approval.id);
  // Allow the resume to reach the queue wait; it must not start the run while blocked.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runStarted, false);

  releaseInFlight();
  await resume;
  await waitFor(() => runStarted && storage.current.metadata.running === false);

  assert.equal(runStarted, true);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
});

test("duplicate chat run ids stay active until every owner ends", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  await (service as any).beginChatRun(conversation, "shared-run");
  await (service as any).beginChatRun(conversation, "shared-run");
  await (service as any).endChatRun(conversation, "shared-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["shared-run"]);
  assert.equal(storage.current.metadata.running, true);

  await (service as any).endChatRun(conversation, "shared-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.running, false);
});

test("ending one active run preserves survivor metadata", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  await (service as any).beginChatRun(conversation, "first-run");
  await (service as any).beginChatRun(conversation, "second-run");
  await (service as any).endChatRun(conversation, "first-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["second-run"]);
  assert.equal(storage.current.metadata.running, true);
  assert.equal(storage.current.metadata.runId, "second-run");

  await (service as any).endChatRun(conversation, "second-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
});

test("participant reservation is released if turn controller setup fails", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const serviceAny = service as any;
  const trigger = conversation.messages[0];
  const reservation = serviceAny.reserveParticipantTurn(conversation.id, participant.id);
  serviceAny.ensureChatTurnController = () => {
    throw new Error("controller setup failed");
  };

  await assert.rejects(
    () => serviceAny.runParticipantTurnSerialized(conversation, participant, trigger, "failed-run", undefined, undefined, {
      warnings: [],
      turnReservation: reservation
    }),
    /controller setup failed/
  );

  const nextReservation = serviceAny.reserveParticipantTurn(conversation.id, participant.id);
  assert.equal(nextReservation.queued, false);
  nextReservation.release();
});

test("same participant sends show queued bubble and serialize provider runs", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let runCount = 0;
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond!: () => void;
  const secondCanFinish = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      const runNumber = runCount;
      if (runNumber === 1) {
        await firstCanFinish;
      } else if (runNumber === 2) {
        await secondCanFinish;
      }
      return {
        participant: runParticipant,
        ok: true,
        content: `reply ${runNumber}`,
        durationMs: 1,
        sessionId: `session-${runNumber}`
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "first-send",
    content: "@codex first"
  });
  await waitFor(() => runCount === 1);

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "second-send",
    content: "@codex second"
  });
  await waitFor(() => storage.current.messages.some(
    (message: Conversation["messages"][number]) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  ));
  const queuedMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  );

  assert.equal(runCount, 1);
  releaseFirst();
  await waitFor(() => {
    const promoted = storage.current.messages.find((message: Conversation["messages"][number]) => message.id === queuedMessage?.id);
    return runCount === 2 &&
      promoted?.status === "pending" &&
      promoted.metadata?.queuedBehind === undefined;
  });

  releaseSecond();
  await waitFor(() =>
    storage.current.messages.some((message: Conversation["messages"][number]) => message.content === "reply 2") &&
    storage.current.metadata.running === false
  );
});

test("cancelling same participant queued response removes bubble before earlier turn releases", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let runCount = 0;
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseThird!: () => void;
  const thirdCanFinish = new Promise<void>((resolve) => {
    releaseThird = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      const runNumber = runCount;
      if (runNumber === 1) {
        await firstCanFinish;
      } else if (runNumber === 2) {
        await thirdCanFinish;
      }
      return {
        participant: runParticipant,
        ok: true,
        content: `reply ${runNumber}`,
        durationMs: 1,
        sessionId: `session-${runNumber}`
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "first-send",
    content: "@codex first"
  });
  await waitFor(() => runCount === 1);

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "second-send",
    content: "@codex second"
  });
  await waitFor(() => storage.current.messages.some(
    (message: ChatMessage) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  ));
  const queuedMessage = storage.current.messages.find(
    (message: ChatMessage) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  );
  const queuedRunId = queuedMessage?.metadata?.runId;
  assert.ok(queuedMessage);
  assert.ok(queuedRunId);

  assert.equal(service.cancelRun(queuedRunId), true);
  await waitFor(() => {
    const activeRunIds = storage.current.metadata.activeRunIds ?? [];
    return !storage.current.messages.some((message: ChatMessage) => message.id === queuedMessage.id) &&
      storage.current.messages.some((message: ChatMessage) =>
        message.role === "system" &&
        message.content === `@${participant.handle} stopped by user.`
      ) &&
      activeRunIds.length === 1 &&
      !activeRunIds.includes(queuedRunId) &&
      runCount === 1;
  });
  assert.notEqual(
    storage.current.metadata.lastMessageByParticipant?.[participant.id]?.messageId,
    queuedMessage.id
  );
  assert.equal(
    ((storage.current.metadata.removedChatMessageIds as string[] | undefined) ?? []).includes(queuedMessage.id),
    true
  );

  storage.current.messages.push(clone(queuedMessage));
  await (service as any).refreshStoredChatState(storage.current);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.id === queuedMessage.id), false);
  assert.equal(
    storage.current.messages.some((message: ChatMessage) => message.metadata?.queuedBehind?.handle === participant.handle),
    false
  );

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "third-send",
    content: "@codex third"
  });
  await waitFor(() => storage.current.messages.some(
    (message: ChatMessage) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  ));
  const thirdQueuedMessage = storage.current.messages.find(
    (message: ChatMessage) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  );
  assert.ok(thirdQueuedMessage);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(runCount, 1);

  releaseFirst();
  await waitFor(() => {
    const promoted = storage.current.messages.find((message: ChatMessage) => message.id === thirdQueuedMessage.id);
    return runCount === 2 &&
      promoted?.status === "pending" &&
      promoted.metadata?.queuedBehind === undefined;
  });

  releaseThird();
  await waitFor(() =>
    storage.current.messages.some((message: ChatMessage) =>
      message.id === thirdQueuedMessage.id &&
      message.content === "reply 2" &&
      message.status === "done"
    ) &&
    storage.current.metadata.running === false
  );
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.id === queuedMessage.id), false);
});

test("same participant queued bubble is finalized when startup throws before turn try", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let runCount = 0;
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      await firstCanFinish;
      return {
        participant: runParticipant,
        ok: true,
        content: "reply 1",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  const serviceAny = service as any;
  serviceAny.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "first-send",
    content: "@codex first"
  });
  await waitFor(() => runCount === 1);

  serviceAny.sessionForParticipant = async () => {
    throw new Error("session setup failed");
  };
  await service.sendMessage({
    conversationId: conversation.id,
    runId: "second-send",
    content: "@codex second"
  });
  await waitFor(() => storage.current.messages.some(
    (message: Conversation["messages"][number]) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  ));
  const queuedMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  );

  releaseFirst();
  await waitFor(() => {
    const finalized = storage.current.messages.find((message: Conversation["messages"][number]) => message.id === queuedMessage?.id);
    return finalized?.status === "error" &&
      finalized.metadata?.queuedBehind === undefined &&
      finalized.content.includes("session setup failed") &&
      storage.current.metadata.running === false;
  });
  assert.equal(runCount, 1);
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

  await (service as any).appendParticipantTurnMessages(conversation, participant, replies);

  const approvals = ((conversation.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (item) => item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
  assert.equal(conversation.messages.some((message) => message.content.includes("Permission approval needed")), false);
});

test("internal-mechanics phrasing in a draft is delivered as-is without retry", async () => {
  const participant = chatParticipant("claude-code", { workspaceWrite: false });
  const conversation = chatConversation([participant]);
  let runCount = 0;
  const draft = "The write tool is not enabled, so I cannot edit the file here.";
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      return {
        participant: runParticipant,
        ok: true,
        content: draft,
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const result = await service.sendMessage({
    conversationId: conversation.id,
    runId: "no-retry-run",
    content: "@drew please update the file"
  });
  await waitFor(() => runCount === 1);

  assert.equal(
    result.warnings.some((warning) =>
      warning.includes("rejected response that mentioned") ||
      warning.includes("blocked") ||
      warning.includes("Blocked")
    ),
    false
  );
  await waitFor(() => runCount === 1 && storage.current.messages.some(
    (message: Conversation["messages"][number]) => message.role === "participant" && message.content === draft
  ));
  const participantMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) => message.role === "participant"
  );
  assert.equal(participantMessage?.content, draft);
  assert.equal(participantMessage?.status, "done");
  assert.equal(typeof participantMessage?.metadata?.workedMs, "number");
  assert.ok((participantMessage?.metadata?.workedMs ?? -1) >= 0);
  const approvals = ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[]).filter(
    (item) => item.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL
  );
  assert.equal(approvals.length, 0);
});

test("approved permission without resumeContext does not auto-run", async () => {
  const runs: ParticipantConfig[] = [];
  const participant = chatParticipant("claude-code");
  const approval = permissionApproval(participant, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved"
  });
  const conversation = chatConversation([participant], { pendingAppToolApprovals: [approval] });
  const { service } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return {
        participant: runParticipant,
        ok: true,
        content: "Unexpected run.",
        durationMs: 1
      };
    }
  });

  await (service as any).autoResumePermissionApproval(conversation.id, approval.id);

  assert.equal(runs.length, 0);
});

test("participantPermissionPolicy guides blocked capabilities to request before refusing", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("claude-code", "default", defaultChatAgentPermissions(), true);

  assert.match(prompt, /Shell commands are blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*shellRules/);
  assert.match(prompt, /Workspace file edits are blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*workspaceWrite/);
  assert.match(prompt, /Web access is blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*webAccess/);
  assert.doesNotMatch(prompt, /General shell commands are blocked/);
  assert.doesNotMatch(prompt, /Do not edit files/);
  assert.doesNotMatch(prompt, /Do not use web search/);
});

test("participantPermissionPolicy reflects Auto-review preset capabilities", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("codex-cli", "auto", defaultChatAgentPermissions(), true);

  assert.match(prompt, /shell commands allowed/);
  assert.match(prompt, /workspace edits allowed/);
  assert.match(prompt, /web access allowed/);
  assert.match(prompt, /Codex Auto-review mode enables native command execution/);
  assert.doesNotMatch(prompt, /Web access is blocked/);
  assert.doesNotMatch(prompt, /Workspace file edits are blocked/);
});

test("participantPermissionPolicy keeps explicit shell deny rules as hard stops", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("claude-code", "default", normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    shell: {
      enabled: true,
      rules: [{ action: "deny", match: "exact", pattern: "rm -rf" }]
    }
  }), true);

  assert.match(prompt, /deny exact "rm -rf"/);
  assert.match(prompt, /Deny rules are strict hard stops for matching commands/);
  assert.match(prompt, /do not request escalation for commands that match a deny rule/);
  assert.match(prompt, /outside these rules/);
});

test("participantPermissionPolicy uses explanation fallback when permission requests are unavailable", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("claude-code", "default", defaultChatAgentPermissions(), false);

  assert.match(prompt, /explain the specific command and shell rule needed before refusing/);
  assert.match(prompt, /explain that `workspaceWrite` is needed before refusing/);
  assert.match(prompt, /explain that `webAccess` is needed before refusing/);
  assert.doesNotMatch(prompt, /app_permissions_request_change/);
});

test("participantPermissionPolicy guides blocked repoRead to request before refusing", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("claude-code", "default", normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    repoRead: false
  }), true);

  assert.match(prompt, /repoRead/);
  assert.match(prompt, /app_permissions_request_change/);
});

test("participantPermissionPolicy does not suggest escalation for agent-mode masked shell and workspace grants", () => {
  const { service } = testService();
  const prompt = (service as any).participantPermissionPolicy("claude-code", "plan", normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    workspaceWrite: true,
    webAccess: false,
    shell: {
      enabled: true,
      rules: [{ action: "allow", match: "prefix", pattern: "npm run" }]
    }
  }), true);

  assert.match(prompt, /Shell commands are blocked by the current agent mode/);
  assert.match(prompt, /Workspace file edits are blocked by the current agent mode/);
  assert.match(prompt, /app_permissions_request_change.*webAccess/);
  assert.doesNotMatch(prompt, /shellRules/);
  assert.doesNotMatch(prompt, /workspaceWrite/);
});

test("injected Chat Assistant defaults to no repository access", async () => {
  const { service } = testService({
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] },
    agents: [{ kind: "codex-cli", installed: true } as AgentHealth]
  });

  const [assistant] = await (service as any).ensureAdministratorParticipant([]);

  assert.equal(assistant.roleConfigId, ADMIN_ROLE.id);
  assert.equal(assistant.handle, "assistant");
  assert.equal(assistant.permissions.repoRead, false);
  assert.equal(assistant.permissions.workspaceWrite, false);
  assert.equal(assistant.permissions.webAccess, false);
  assert.equal(assistant.permissions.shell.enabled, false);
});

test("Chat Assistant prompt suppresses repo edit shell escalation while preserving web guidance", async () => {
  const appMcp = new AppMcpService();
  const { service } = testService({
    appMcp,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });
  const assistant = {
    ...chatParticipant("codex-cli", { repoRead: false, webAccess: false }),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = {
    ...chatConversation([assistant]),
    repoPath: "/repo"
  };
  const triggerMessage: ChatMessage = {
    ...conversation.messages[0],
    content: "Please inspect #src/main.ts",
    metadata: {
      repoFileMentions: [{ path: "src/main.ts" }]
    }
  };
  const session = await (service as any).newSessionForParticipant(assistant);
  const { prompt } = (service as any).buildPromptParts(
    conversation,
    assistant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: false, agentMode: "default", permissions: assistant.permissions }
  );

  assert.match(prompt, /Repository access, file edits, and shell commands are not Chat Assistant's default behavior/);
  assert.match(prompt, /generic participant/);
  assert.match(prompt, /Web access is blocked/);
  assert.match(prompt, /app_permissions_request_change.*webAccess/);
  assert.match(prompt, /Referenced repository files/);
  assert.match(prompt, /Chat Assistant does not read repository files by default/);
  assert.doesNotMatch(prompt, /Repository: \/repo/);
  assert.doesNotMatch(prompt, /repoRead/);
  assert.doesNotMatch(prompt, /workspaceWrite/);
  assert.doesNotMatch(prompt, /shellRules/);
});

test("chat creation does not seed a visible Chat Assistant setup message", async () => {
  const { service, storage } = testService({
    agents: [{ kind: "codex-cli", installed: true } as AgentHealth],
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const result = await service.createConversation({
    title: "Fresh chat",
    participants: [],
    skipDefaultParticipants: true
  });
  const participants = result.conversation.metadata.participants as ChatParticipant[];

  assert.equal(participants.some((participant) => participant.roleConfigId === ADMIN_ROLE.id), true);
  assert.equal(result.conversation.messages.length, 1);
  assert.equal(result.conversation.messages[0].role, "system");
  assert.equal(result.conversation.messages.some((message) => message.role === "participant"), false);
  assert.equal(storage.current.messages.some((message: ChatMessage) =>
    message.metadata?.appMessageSource === "chat-assistant-cold-start"
  ), false);
});

test("static chat instructions include structured participant request and reply guidance", () => {
  const { service } = testService();
  const instructions = (service as any).staticChatInstructions({
    roleAppToolCapabilities: ["participants.request", "permissions.request"]
  });

  assert.match(instructions, /use `app_chat_request_participants` rather than plain `@mentions`/);
  assert.match(instructions, /Reaction MCP tool: `app_chat_react` adds or toggles an emoji reaction on a specific message/);
  assert.match(instructions, /When replying to a participant request addressed to you, answer in the active thread/);
  assert.match(instructions, /if request matching is ambiguous, ask for clarification rather than guessing/);
  assert.doesNotMatch(instructions, /app_chat_reply_to_participant_request/);
});

test("chat creation is blocked when no local CLI is installed", async () => {
  const { service } = testService();

  await assert.rejects(
    () => service.createConversation({ title: "Fresh chat", participants: [] }),
    /Install Codex CLI or Claude Code/
  );
});

test("last message pointer advances by createdAt even when the new message has a smaller window-relative index", () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });

  // Simulate a pre-fix stale pointer recorded at a high index when full history was loaded.
  conversation.metadata = {
    ...conversation.metadata,
    lastMessageByParticipant: {
      [codex.id]: { messageId: "old-message", sequence: 50, createdAt: "2026-05-17T12:00:00.000Z" }
    }
  };

  // After reopening, conversation.messages is a small window; the genuinely newer message
  // lands at a low index (1) but a later timestamp. The old index guard froze the pointer
  // here; ordering by createdAt must advance it.
  const newer: ChatMessage = {
    id: "newer-message",
    role: "participant",
    participantId: codex.id,
    participantLabel: "@codex",
    content: "A fresher answer.",
    createdAt: "2026-05-17T12:05:00.000Z",
    status: "done"
  };
  conversation.messages = [conversation.messages[0], newer];
  (service as any).recordLastMessageByParticipant(conversation, newer);
  assert.equal(conversation.metadata.lastMessageByParticipant?.[codex.id]?.messageId, "newer-message");

  // A re-record of a strictly older message must not move the pointer backward.
  const older: ChatMessage = {
    id: "older-message",
    role: "participant",
    participantId: codex.id,
    participantLabel: "@codex",
    content: "Stale answer.",
    createdAt: "2026-05-17T11:00:00.000Z",
    status: "done"
  };
  conversation.messages = [conversation.messages[0], older, newer];
  (service as any).recordLastMessageByParticipant(conversation, older);
  assert.equal(conversation.metadata.lastMessageByParticipant?.[codex.id]?.messageId, "newer-message");
});

test("removing a recorded message repairs the last-message pointer to the previous visible message", () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
  const earlier: ChatMessage = {
    id: "earlier",
    role: "participant",
    participantId: codex.id,
    participantLabel: "@codex",
    content: "Earlier answer.",
    createdAt: "2026-05-17T12:00:00.000Z",
    status: "done"
  };
  // A just-started (empty, pending) turn bubble — recorded as the pointer when the turn begins.
  const pending: ChatMessage = {
    id: "pending",
    role: "participant",
    participantId: codex.id,
    participantLabel: "@codex",
    content: "",
    createdAt: "2026-05-17T12:05:00.000Z",
    status: "pending"
  };
  conversation.messages = [conversation.messages[0], earlier, pending];
  (service as any).rebuildLastMessagesByParticipant(conversation);
  assert.equal(conversation.metadata.lastMessageByParticipant?.[codex.id]?.messageId, "pending");

  // Stop-before-output splices the pending bubble; the pointer must fall back, not dangle.
  conversation.messages = conversation.messages.filter((message) => message.id !== "pending");
  (service as any).repairLastMessagePointerAfterRemoval(conversation, "pending");
  assert.equal(conversation.metadata.lastMessageByParticipant?.[codex.id]?.messageId, "earlier");

  // Removing the last remaining message clears the pointer rather than pointing at nothing.
  conversation.messages = conversation.messages.filter((message) => message.id !== "earlier");
  (service as any).repairLastMessagePointerAfterRemoval(conversation, "earlier");
  assert.equal(conversation.metadata.lastMessageByParticipant?.[codex.id], undefined);
});

test("heal back-fills createdAt onto a legacy pointer and reports the change so it persists", () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
  const message: ChatMessage = {
    id: "answer",
    role: "participant",
    participantId: codex.id,
    participantLabel: "@codex",
    content: "Answer.",
    createdAt: "2026-05-17T12:00:00.000Z",
    status: "done"
  };
  conversation.messages = [conversation.messages[0], message];
  // Simulate a pre-fix pointer: correct messageId, but no stored createdAt.
  conversation.metadata = {
    ...conversation.metadata,
    lastMessageByParticipant: { [codex.id]: { messageId: "answer", sequence: 1 } }
  };
  const changed = (service as any).rebuildLastMessagesByParticipantIfChanged(conversation);
  assert.equal(changed, true, "back-filling createdAt must register as a change so the heal persists it");
  assert.equal(conversation.metadata.lastMessageByParticipant?.[codex.id]?.createdAt, "2026-05-17T12:00:00.000Z");

  // Idempotent: a second heal over the now-complete pointer reports no change (no save churn).
  const changedAgain = (service as any).rebuildLastMessagesByParticipantIfChanged(conversation);
  assert.equal(changedAgain, false);
});

test("last message pointer tracks visible participant messages including Chat Assistant and thread replies", () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([assistant, codex]);
  const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
  const visibleAssistant: ChatMessage = {
    id: "assistant-setup",
    role: "participant",
    participantId: assistant.id,
    participantLabel: "@assistant",
    content: "Hi, I'm Chat Assistant.",
    createdAt: NOW,
    status: "done",
    metadata: { threadId: "system" }
  };
  const hiddenWaiting: ChatMessage = {
    id: "waiting",
    role: "participant",
    participantId: codex.id,
    participantLabel: "@codex",
    content: "Waiting for user approval.",
    createdAt: NOW,
    status: "done"
  };
  const topLevel: ChatMessage = {
    id: "top-level",
    role: "participant",
    participantId: codex.id,
    participantLabel: "@codex",
    content: "Top-level answer.",
    createdAt: NOW,
    status: "done"
  };
  const threadReply: ChatMessage = {
    id: "thread-reply",
    role: "participant",
    participantId: codex.id,
    participantLabel: "@codex",
    content: "Thread answer.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "root-message",
      parentMessageId: "root-message",
      chatThreadRootId: "root-message"
    }
  };

  conversation.messages = [conversation.messages[0], visibleAssistant, hiddenWaiting];
  (service as any).rebuildLastMessagesByParticipant(conversation);
  assert.deepEqual(conversation.metadata.lastMessageByParticipant?.[assistant.id], {
    messageId: "assistant-setup",
    sequence: 1,
    createdAt: NOW
  });
  assert.equal(conversation.metadata.lastMessageByParticipant?.[codex.id], undefined);

  (service as any).upsertCompletedMessage(conversation, topLevel);
  assert.deepEqual(conversation.metadata.lastMessageByParticipant?.[codex.id], {
    messageId: "top-level",
    sequence: 3,
    createdAt: NOW
  });

  (service as any).upsertCompletedMessage(conversation, threadReply);
  assert.deepEqual(conversation.metadata.lastMessageByParticipant?.[codex.id], {
    messageId: "thread-reply",
    sequence: 4,
    createdAt: NOW,
    threadRootId: "root-message"
  });
});

test("unmentioned timeline messages route to the last sender while explicit mentions bypass it", () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([assistant, codex]);
  const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });

  const unmentioned = (service as any).resolveDispatchTargetsForContent(conversation, "Please help me set up this chat.");
  assert.deepEqual(unmentioned.targets.map((participant: ChatParticipant) => participant.handle), ["assistant"]);

  conversation.messages.push({
    id: "codex-reply",
    role: "participant",
    participantId: codex.id,
    content: "message codex-reply",
    createdAt: NOW,
    status: "done",
    metadata: { threadId: "user-message", parentMessageId: "user-message" }
  });
  const lastTimelineSender = (service as any).resolveDispatchTargetsForContent(conversation, "follow up");
  assert.deepEqual(lastTimelineSender.targets.map((participant: ChatParticipant) => participant.handle), ["codex"]);

  conversation.messages.push({
    id: "assistant-reply",
    role: "participant",
    participantId: assistant.id,
    content: "message assistant-reply",
    createdAt: NOW,
    status: "done",
    metadata: { threadId: "assistant-thread", parentMessageId: "codex-reply" }
  });
  const assistantAsLastSender = (service as any).resolveDispatchTargetsForContent(conversation, "follow up again");
  assert.deepEqual(assistantAsLastSender.targets.map((participant: ChatParticipant) => participant.handle), ["assistant"]);

  const explicit = (service as any).resolveDispatchTargetsForContent(conversation, "@codex answer directly.");
  assert.deepEqual(explicit.targets.map((participant: ChatParticipant) => participant.handle), ["codex"]);
});

test("unmentioned thread replies route to the newest thread sender instead of the parent author", () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const codex = chatParticipant("codex-cli");
  const drew = chatParticipant("claude-code");

  const threadMsg = (
    id: string,
    role: ChatMessage["role"],
    threadId: string,
    participantId?: string,
    parentMessageId?: string,
    chatThreadRootId?: string
  ): ChatMessage => ({
    id,
    role,
    participantId,
    content: `message ${id}`,
    createdAt: NOW,
    status: "done",
    metadata: { threadId, parentMessageId, chatThreadRootId }
  });

  const handlesFor = (
    service: any,
    conversation: Conversation,
    content: string,
    context: { parentMessageId?: string; threadId?: string; chatThreadRootId?: string }
  ): string[] =>
    service
      .resolveDispatchTargetsForContent(conversation, content, context)
      .targets.map((participant: ChatParticipant) => participant.handle);

  // A real thread reply passes the root as parent; last sender should still win.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [
      threadMsg("assistant-root", "participant", "t-mixed", assistant.id),
      threadMsg("codex-reply", "participant", "t-mixed", codex.id, "assistant-root", "assistant-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(
      handlesFor(service, conversation, "follow up", { parentMessageId: "assistant-root", threadId: "t-mixed", chatThreadRootId: "assistant-root" }),
      ["codex"]
    );
  }

  // The assistant/administrator is also a valid last sender.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [
      threadMsg("codex-root", "participant", "t-assistant", codex.id),
      threadMsg("assistant-reply", "participant", "t-assistant", assistant.id, "codex-root", "codex-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(
      handlesFor(service, conversation, "follow up", { parentMessageId: "codex-root", threadId: "t-assistant", chatThreadRootId: "codex-root" }),
      ["assistant"]
    );
  }

  // Removed newest sender is skipped in favor of the next older roster participant.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [
      threadMsg("codex-root", "participant", "t-removed", codex.id),
      threadMsg("removed-reply", "participant", "t-removed", "removed-participant", "codex-root", "codex-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(
      handlesFor(service, conversation, "follow up", { parentMessageId: "codex-root", threadId: "t-removed", chatThreadRootId: "codex-root" }),
      ["codex"]
    );
  }

  // Top-level participant replies carry a threadId, so timeline routing must not require absent threadId.
  {
    const conversation = chatConversation([assistant, codex, drew]);
    conversation.messages = [
      threadMsg("codex-top-level", "participant", "user-thread", codex.id, "user-message"),
      threadMsg("drew-thread-reply", "participant", "thread-1", drew.id, "thread-root", "thread-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(handlesFor(service, conversation, "timeline follow up", {}), ["codex"]);
  }

  // If only a removed participant qualifies in scope, parent author is the fallback.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [
      threadMsg("codex-root", "participant", "t-parent-fallback", codex.id),
      threadMsg("removed-reply", "participant", "t-parent-fallback", "removed-participant", "codex-root", "codex-root")
    ];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(
      handlesFor(service, conversation, "follow up", { parentMessageId: "codex-root", threadId: "missing-thread", chatThreadRootId: "missing-root" }),
      ["codex"]
    );
  }

  // Explicit mention overrides thread routing.
  {
    const conversation = chatConversation([assistant, codex, drew]);
    conversation.messages = [threadMsg("codex-root", "participant", "codex-root", codex.id)];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(handlesFor(service, conversation, "@drew take this", { parentMessageId: "codex-root", threadId: "codex-root" }), ["drew"]);
  }

  // A cold thread with no prior participant still falls back to Chat Assistant.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [threadMsg("user-root", "user", "t-cold", undefined)];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    assert.deepEqual(handlesFor(service, conversation, "follow up", { parentMessageId: "user-root", threadId: "t-cold" }), ["assistant"]);
  }

  // An unknown explicit mention is preserved and never infers a thread agent or falls back.
  {
    const conversation = chatConversation([assistant, codex]);
    conversation.messages = [threadMsg("codex-root", "participant", "codex-root", codex.id)];
    const { service } = testService({ conversation, settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });
    const dispatch = (service as any).resolveDispatchTargetsForContent(conversation, "@missing help", { parentMessageId: "codex-root", threadId: "codex-root" });
    assert.deepEqual(dispatch.targets, []);
    assert.deepEqual(dispatch.unknownHandles, ["missing"]);
  }
});

test("removeParticipant clears stale participant state in the same mutation", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const requester = {
    ...chatParticipant("claude-code"),
    id: "requester-participant",
    handle: "requester"
  };
  const removed = {
    ...chatParticipant("codex-cli"),
    id: "removed-participant",
    handle: "removed"
  };
  const other = {
    ...chatParticipant("claude-code"),
    id: "other-participant",
    handle: "other"
  };
  const removedPermissionApproval = permissionApproval(removed, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    id: "removed-permission-approval"
  });
  const removedTargetApproval = participantRequestApproval(requester, [{
    target: removed.handle,
    prompt: "Please review this."
  }], {
    id: "removed-target-approval",
    requestMessageId: "request-message",
    batchId: "batch-1"
  });
  const unrelatedApproval = permissionApproval(other, {
    kind: "portable",
    permissions: ["repoRead"]
  }, {
    id: "unrelated-approval"
  });
  const policies: ChatAppToolApprovalPolicy[] = [
    {
      id: "removed-requester-policy",
      participantId: removed.id,
      roleConfigId: removed.roleConfigId,
      toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
      capability: "participants.request",
      targetParticipantId: other.id,
      scope: "chat",
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      id: "removed-target-policy",
      participantId: requester.id,
      roleConfigId: requester.roleConfigId,
      toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
      capability: "participants.request",
      targetParticipantId: removed.id,
      scope: "chat",
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      id: "unrelated-policy",
      participantId: requester.id,
      roleConfigId: requester.roleConfigId,
      toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
      capability: "participants.request",
      targetParticipantId: other.id,
      scope: "chat",
      createdAt: NOW,
      updatedAt: NOW
    }
  ];
  const sessions: ChatParticipantSession[] = [{
    participantId: removed.id,
    sessionId: "removed-session",
    roleConfigId: removed.roleConfigId,
    roleConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  }];
  const conversation = chatConversation([assistant, requester, removed, other], {
    pendingAppToolApprovals: [removedPermissionApproval, removedTargetApproval, unrelatedApproval],
    appToolApprovalPolicies: policies,
    participantSessions: sessions
  });
  conversation.messages.push({
    id: "mention-message",
    role: "participant",
    participantId: requester.id,
    content: "Participant requests:\n- @removed\n- @other",
    createdAt: NOW,
    status: "done",
    metadata: {
      pendingMentions: [
        { targetParticipantId: removed.id, targetHandle: removed.handle, status: "pending" },
        { targetParticipantId: other.id, targetHandle: other.handle, status: "pending" }
      ]
    }
  }, {
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    content: "@removed Please review this.\n@other Please also review.",
    createdAt: NOW,
    status: "done",
    metadata: {
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: "pending_approval",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        items: [
          {
            targetParticipantId: removed.id,
            targetHandle: removed.handle,
            prompt: "Please review this.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          },
          {
            targetParticipantId: other.id,
            targetHandle: other.handle,
            prompt: "Please also review.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          }
        ]
      }
    }
  });
  const { service, storage } = testService({ conversation });

  await service.removeParticipant({ conversationId: conversation.id, participantId: removed.id });

  const saved = storage.current as Conversation;
  assert.deepEqual((saved.metadata.participants as ChatParticipant[]).map((participant) => participant.id), [
    assistant.id,
    requester.id,
    other.id
  ]);
  assert.deepEqual(saved.metadata.participantSessions, []);
  const approvals = saved.metadata.pendingAppToolApprovals as ChatAppToolApproval[];
  assert.equal(approvals.find((approval) => approval.id === removedPermissionApproval.id)?.status, "denied");
  assert.equal(approvals.find((approval) => approval.id === removedTargetApproval.id)?.status, "denied");
  assert.equal(approvals.find((approval) => approval.id === unrelatedApproval.id)?.status, "pending");
  assert.equal(approvals.find((approval) => approval.id === removedPermissionApproval.id)?.error, "Participant was removed from this chat.");
  assert.deepEqual((saved.metadata.appToolApprovalPolicies as ChatAppToolApprovalPolicy[]).map((policy) => policy.id), []);

  const mentionMessage = saved.messages.find((message) => message.id === "mention-message") as ChatMessage;
  assert.deepEqual(mentionMessage.metadata?.pendingMentions?.map((mention) => mention.targetParticipantId), [other.id]);

  const requestBatch = saved.messages.find((message) => message.id === "request-message")?.metadata?.participantRequest;
  assert.equal(requestBatch?.status, "pending_approval");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === removed.id)?.status, "failed");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === removed.id)?.error, "Participant was removed from this chat.");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === other.id)?.status, "pending_approval");
});

test("removeParticipant cannot be undone by a later stale chat mutation", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const removed = {
    ...chatParticipant("claude-code"),
    id: "removed-participant",
    handle: "removed"
  };
  const other = {
    ...chatParticipant("codex-cli"),
    id: "other-participant",
    handle: "other"
  };
  const removedApproval = participantRequestApproval(assistant, [{
    target: removed.handle,
    prompt: "Please review this."
  }], {
    id: "removed-target-approval",
    requestMessageId: "request-message",
    batchId: "batch-1"
  });
  const removedSession: ChatParticipantSession = {
    participantId: removed.id,
    sessionId: "removed-session",
    roleConfigId: removed.roleConfigId,
    roleConfigVersion: 1,
    roleLabel: ROLE.label,
    roleInstructions: ROLE.instructions,
    updatedAt: NOW
  };
  const removedPolicy: ChatAppToolApprovalPolicy = {
    id: "removed-target-policy",
    participantId: assistant.id,
    roleConfigId: assistant.roleConfigId,
    toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
    capability: "participants.request",
    targetParticipantId: removed.id,
    scope: "chat",
    createdAt: NOW,
    updatedAt: NOW
  };
  const conversation = chatConversation([assistant, removed, other], {
    pendingAppToolApprovals: [removedApproval],
    appToolApprovalPolicies: [removedPolicy],
    participantSessions: [removedSession]
  });
  conversation.messages.push({
    id: "mention-message",
    role: "participant",
    participantId: assistant.id,
    content: "Participant requests:\n- @removed",
    createdAt: NOW,
    status: "done",
    metadata: {
      pendingMentions: [
        { targetParticipantId: removed.id, targetHandle: removed.handle, status: "pending" },
        { targetParticipantId: other.id, targetHandle: other.handle, status: "pending" }
      ]
    }
  }, {
    id: "request-message",
    role: "participant",
    participantId: assistant.id,
    content: "@removed Please review this.\n@other Please also review.",
    createdAt: NOW,
    status: "done",
    metadata: {
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: assistant.id,
        requesterHandle: assistant.handle,
        source: "mcp",
        resumeRequester: true,
        status: "pending_approval",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        items: [
          {
            targetParticipantId: removed.id,
            targetHandle: removed.handle,
            prompt: "Please review this.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          },
          {
            targetParticipantId: other.id,
            targetHandle: other.handle,
            prompt: "Please also review.",
            status: "pending_approval",
            createdAt: NOW,
            updatedAt: NOW
          }
        ]
      }
    }
  });
  const { service, storage } = testService({ conversation });
  const staleConversation = await storage.getConversation(conversation.id) as Conversation;

  await service.removeParticipant({ conversationId: conversation.id, participantId: removed.id });
  await (service as any).withChatMutation(staleConversation, async () => {
    staleConversation.updatedAt = "2026-05-17T12:00:01.000Z";
    await (service as any).saveConversation(staleConversation);
  });

  const saved = storage.current as Conversation;
  assert.deepEqual((saved.metadata.participants as ChatParticipant[]).map((participant) => participant.id), [
    assistant.id,
    other.id
  ]);
  assert.deepEqual(saved.metadata.participantSessions, []);
  assert.deepEqual(saved.metadata.appToolApprovalPolicies, []);
  assert.equal((saved.metadata.pendingAppToolApprovals as ChatAppToolApproval[])[0].status, "denied");
  assert.deepEqual(
    saved.messages.find((message) => message.id === "mention-message")?.metadata?.pendingMentions?.map((mention) => mention.targetParticipantId),
    [other.id]
  );
  const requestBatch = saved.messages.find((message) => message.id === "request-message")?.metadata?.participantRequest;
  assert.equal(requestBatch?.status, "pending_approval");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === removed.id)?.status, "failed");
  assert.equal(requestBatch?.items.find((item) => item.targetParticipantId === other.id)?.status, "pending_approval");
});

test("stale permission approval for a removed requester fails closed", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const removed = {
    ...chatParticipant("claude-code"),
    id: "removed-participant",
    handle: "removed",
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      webAccess: false
    })
  };
  const approval = permissionApproval(removed, {
    kind: "portable",
    permissions: ["webAccess"]
  });
  const conversation = chatConversation([assistant], { pendingAppToolApprovals: [approval] });
  const { service, storage } = testService({ conversation });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "chat"
  });

  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "denied");
  assert.equal(normalizeChatAgentPermissions((storage.current.metadata.participants as ChatParticipant[])[0]?.permissions).webAccess, false);
  assert.equal(storage.current.messages.some((message: ChatMessage) =>
    message.content.includes("The requesting participant is no longer in this chat.")
  ), true);
});

test("stale participant-request approval for a removed target fails closed without running", async () => {
  const requester = {
    ...chatParticipant("claude-code"),
    id: "requester-participant",
    handle: "requester"
  };
  const removed = {
    ...chatParticipant("codex-cli"),
    id: "removed-participant",
    handle: "removed"
  };
  const approval = participantRequestApproval(requester, [{
    target: removed.handle,
    prompt: "Please review this."
  }], {
    requestMessageId: "request-message",
    batchId: "batch-1"
  });
  const conversation = chatConversation([requester], { pendingAppToolApprovals: [approval] });
  conversation.messages.push({
    id: "request-message",
    role: "participant",
    participantId: requester.id,
    content: "@removed Please review this.",
    createdAt: NOW,
    status: "done",
    metadata: {
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: "pending_approval",
        depth: 1,
        createdAt: NOW,
        updatedAt: NOW,
        items: [{
          targetParticipantId: removed.id,
          targetHandle: removed.handle,
          prompt: "Please review this.",
          status: "pending_approval",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  });
  let runCount = 0;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async () => {
      runCount += 1;
      return {
        participant: { id: "removed", kind: "codex-cli", label: "removed" },
        ok: true,
        content: "should not run",
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: approval.id,
    approve: true,
    scope: "chat"
  });
  await waitFor(() => storage.current.messages.find((message: ChatMessage) => message.id === "request-message")
    ?.metadata?.participantRequest?.items[0]?.status === "failed");

  const savedApproval = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  const batch = storage.current.messages.find((message: ChatMessage) => message.id === "request-message")
    ?.metadata?.participantRequest;
  assert.equal(savedApproval.status, "approved");
  assert.deepEqual(savedApproval.appliedParticipantIds, []);
  assert.equal(batch?.status, "failed");
  assert.equal(batch?.items[0].status, "failed");
  assert.equal(batch?.items[0].error, "Target participant is no longer in this chat.");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies ?? [], []);
  assert.equal(runCount, 0);
});

test("removeParticipant rejects unsafe removal requests", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const target = {
    ...chatParticipant("claude-code"),
    id: "target-participant",
    handle: "target"
  };

  {
    const conversation = chatConversation([assistant, target], { running: true });
    const { service } = testService({ conversation });

    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: target.id }),
      /turn is running/
    );
  }

  {
    const conversation = chatConversation([assistant, target]);
    const { service } = testService({ conversation });

    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: assistant.id }),
      /Chat Assistant cannot be removed/
    );
    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: "missing-participant" }),
      /not found/
    );
  }

  {
    const conversation = chatConversation([target]);
    const { service } = testService({ conversation });

    await assert.rejects(
      () => service.removeParticipant({ conversationId: conversation.id, participantId: target.id }),
      /last chat participant/
    );
  }
});

test("participant request with saveAsPreset false adds a chat-only participant", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const requested = await service.requestParticipantChangeFromTool(actor, {
    reason: "One-off participant for this chat.",
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "skeptic",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    }]
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId as string,
    approve: true
  });

  assert.equal(settingsState.chatParticipantConfigs.length, 0);
  assert.ok((storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "skeptic"));
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

test("participant creation rejects archived roles for new participants", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const archivedRole: ChatRoleConfig = {
    ...ROLE,
    id: "archived-reviewer",
    label: "Archived Reviewer",
    archivedAt: NOW
  };
  const conversation = chatConversation([assistant]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE, archivedRole], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  await assert.rejects(
    () => service.requestParticipantChangeFromTool(actor, {
      reason: "Do not allow new references to archived roles.",
      operations: [{
        type: "add_new_participant_to_chat",
        saveAsPreset: false,
        participant: {
          handle: "archived",
          roleConfigId: archivedRole.id,
          kind: "codex-cli"
        }
      }]
    }),
    /Deleted role "Archived Reviewer" cannot be used/
  );

  await assert.rejects(
    () => service.addParticipant({
      conversationId: conversation.id,
      participant: {
        handle: "archived-direct",
        roleConfigId: archivedRole.id,
        kind: "codex-cli"
      }
    }),
    /Deleted role "Archived Reviewer" cannot be used/
  );
});

test("role option discovery advertises archive_role and archived metadata", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const archivedRole: ChatRoleConfig = {
    ...ROLE,
    id: "archived-reviewer",
    label: "Archived Reviewer",
    archivedAt: NOW
  };
  const conversation = chatConversation([assistant]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE, archivedRole], chatParticipantConfigs: [] }
  });

  const options = await service.describeRoleOptionsForTool(participantManagerActor(conversation.id, assistant)) as any;
  assert.deepEqual(options.roleChange.supportedOperations, ["create_role", "edit_role", "archive_role"]);
  assert.match(options.roleChange.editPolicy, /archive_role/);
  const archived = options.roles.find((role: { id: string }) => role.id === archivedRole.id);
  assert.equal(archived.archived, true);
  assert.equal(archived.archivedAt, NOW);
});

test("Chat Assistant cannot edit built-in roles through role app tool", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  await assert.rejects(
    () => service.requestRoleChangeFromTool(participantManagerActor(conversation.id, assistant), {
      operations: [{
        type: "edit_role",
        role: {
          roleConfigId: ADMIN_ROLE.id,
          label: "Changed Assistant",
          instructions: "Changed instructions."
        }
      }]
    }),
    /Built-in role/
  );
});

test("Chat Assistant cannot edit deleted roles through role app tool", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const archivedRole: ChatRoleConfig = {
    ...ROLE,
    id: "archived-reviewer",
    label: "Archived Reviewer",
    archivedAt: NOW
  };
  const conversation = chatConversation([assistant]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, archivedRole] }
  });

  await assert.rejects(
    () => service.requestRoleChangeFromTool(participantManagerActor(conversation.id, assistant), {
      operations: [{
        type: "edit_role",
        role: {
          roleConfigId: archivedRole.id,
          label: "Edited Archived Reviewer",
          instructions: "This should not be accepted."
        }
      }]
    }),
    /Deleted role "Archived Reviewer" cannot be edited/
  );
});

test("dependent role and participant requests collapse into one atomic grouped approval", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const roleResult = await service.requestRoleChangeFromTool(actor, {
    reason: "Need a specialized privacy role.",
    operations: [{
      type: "create_role",
      role: {
        label: "Privacy Threat Modeler",
        instructions: "Identify privacy threats and mitigation gaps."
      }
    }]
  }) as { approvalId: string; createdRoleRefs: Array<{ draftRoleRef: string }> };
  const draftRoleRef = roleResult.createdRoleRefs[0].draftRoleRef;
  assert.match(draftRoleRef, /^draft-role-/);
  assert.equal(storage.current.metadata.pendingAppToolApprovals.length, 1);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].toolName, APP_ROLES_REQUEST_CHANGE_TOOL);

  const participantResult = await service.requestParticipantChangeFromTool(actor, {
    reason: "Add privacy reviewer and save it.",
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: true,
      participant: {
        handle: "privacy",
        roleConfigId: draftRoleRef,
        kind: "claude-code"
      }
    }]
  }) as { approvalId: string };

  assert.equal(participantResult.approvalId, roleResult.approvalId);
  const pending = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal(pending.toolName, APP_PARTICIPANTS_REQUEST_CHANGE_TOOL);
  assert.equal((pending.request as any).kind, "role_participant_change");

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: participantResult.approvalId,
    approve: true
  });

  const createdRole = settingsState.chatRoleConfigs.find((role) => role.label === "Privacy Threat Modeler");
  assert.ok(createdRole);
  assert.equal(settingsState.batchWriteCount, 1);
  assert.equal(settingsState.chatParticipantConfigs.length, 1);
  assert.equal(settingsState.chatParticipantConfigs[0].roleConfigId, createdRole.id);
  const addedParticipant = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "privacy");
  assert.equal(addedParticipant?.roleConfigId, createdRole.id);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

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

test("a selected skill cannot be sent to more than one mentioned participant", async () => {
  const a = chatParticipant("codex-cli");
  const b = chatParticipant("claude-code");
  const conversation = chatConversation([a, b]);
  const { service } = testService({ conversation });
  const mention = skillMention("codex-cli");

  await assert.rejects(
    () => (service as any).validateChatSkillMentionsForTargets(conversation, "@codex @drew /accord", [mention], [a, b]),
    /runs on a single participant/
  );
});

test("a selected skill without an explicit mention targets the implicit last sender", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([assistant, codex]);
  conversation.messages.push({
    id: "codex-reply",
    role: "participant",
    participantId: codex.id,
    content: "message codex-reply",
    createdAt: NOW,
    status: "done",
    metadata: { threadId: "user-message", parentMessageId: "user-message" }
  });
  const seen: Array<{ kind: ChatProviderKind; participantId: string }> = [];
  const userSkills = {
    async validateMentionForParticipant(
      _mention: unknown,
      kind: ChatProviderKind,
      _context: unknown,
      participantId: string
    ): Promise<{ ok: true }> {
      seen.push({ kind, participantId });
      return { ok: true };
    }
  };
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] },
    userSkills
  });
  const dispatch = (service as any).resolveDispatchTargetsForContent(conversation, "Use the selected skill.");

  const validation = await (service as any).validateChatSkillMentionsForTargets(
    conversation,
    "Use the selected skill.",
    [skillMention("codex-cli")],
    dispatch.targets
  );

  assert.deepEqual(validation.targets.map((participant: ChatParticipant) => participant.handle), ["codex"]);
  assert.deepEqual(seen, [{ kind: "codex-cli", participantId: codex.id }]);
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
  (service as any).ensureHistoryFiles = async () => tempRoot;

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
  assert.match(runs[0].prompt, /Selected skills for this turn:/);
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
  (service as any).ensureHistoryFiles = async () => tempRoot;

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
    const validation = await (service as any).validateChatSkillMentionsForTargets(
      conversation,
      content,
      undefined,
      [codex]
    );
    assert.deepEqual(validation.skillMentions, []);
    assert.deepEqual(validation.targets.map((participant: ChatParticipant) => participant.id), [codex.id]);
  }

  const multiTarget = await (service as any).validateChatSkillMentionsForTargets(
    conversation,
    "@codex @drew /accord",
    undefined,
    [codex, drew]
  );
  assert.deepEqual(multiTarget.skillMentions, []);
  assert.deepEqual(multiTarget.targets.map((participant: ChatParticipant) => participant.id), [codex.id, drew.id]);
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

  await (service as any).refreshStoredChatState(staleConversation);

  assert.equal(staleConversation.messages[0].metadata?.reactions?.["✅"]?.[0]?.actorLabel, "@codex");

  const staleConversationWithReaction = clone(staleConversation);

  await service.reactToMessageFromTool(actor, {
    messageId: "user-message",
    emoji: "✅"
  });

  assert.equal(storage.current.messages[0].metadata.reactions, undefined);

  await (service as any).refreshStoredChatState(staleConversationWithReaction);

  assert.equal(staleConversationWithReaction.messages[0].metadata?.reactions, undefined);
});

test("refreshStoredChatState preserves stored completed messages over stale pending copies", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const runId = "completed-run";
  conversation.messages.push(pendingParticipantMessage(participant, "answer", runId, {
    status: "done",
    content: "Finished answer.",
    metadata: { runId }
  }));
  const staleConversation = clone(conversation);
  staleConversation.messages = staleConversation.messages.map((message: any) =>
    message.id === "answer"
      ? pendingParticipantMessage(participant, "answer", runId)
      : message
  );
  const { service } = testService({ conversation });

  await (service as any).refreshStoredChatState(staleConversation);

  const answer = staleConversation.messages.find((message: any) => message.id === "answer")!;
  assert.equal(answer.status, "done");
  assert.equal(answer.content, "Finished answer.");
  assert.equal((service as any).recoverStaleChatRun(staleConversation), false);
  assert.equal(answer.metadata?.staleRunRecovery, undefined);
});

function pendingParticipantMessage(
  participant: ChatParticipant,
  id: string,
  runId: string,
  patch: Partial<{ status: "pending" | "done" | "error"; content: string; metadata: any }> = {}
): any {
  return {
    id,
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: patch.content ?? "",
    createdAt: NOW,
    status: patch.status ?? "pending",
    metadata: patch.metadata ?? { runId }
  };
}

test("recoverStaleChatRun leaves a pending message whose run is still live", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const runId = "live-run";
  conversation.messages.push(pendingParticipantMessage(participant, "pending-live", runId));
  const { service } = testService({ conversation });
  (service as any).chatRunMeta.set(runId, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  const changed = (service as any).recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  const pending = conversation.messages.find((message: any) => message.id === "pending-live")!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.metadata?.staleRunRecovery, undefined);
});

test("a swept placeholder is marked, and a late result repairs it preserving reactions", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const runId = "dead-run";
  conversation.messages.push(pendingParticipantMessage(participant, "pending-dead", runId));
  const { service } = testService({ conversation });

  const swept = (service as any).recoverStaleChatRun(conversation);
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
  await (service as any).appendParticipantTurnMessages(conversation, participant, [completed]);

  const repaired = conversation.messages.find((message: any) => message.id === "pending-dead")!;
  assert.equal(repaired.status, "done");
  assert.equal(repaired.content, "Here is the real answer.");
  assert.equal(repaired.metadata?.staleRunRecovery, undefined);
  assert.equal(repaired.metadata?.reactions?.["✅"]?.[0]?.actorLabel, "User");
});

test("a late result does not resurrect a non-recovery error (user-stopped) message", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.messages.push(pendingParticipantMessage(participant, "stopped", "stopped-run", {
    status: "error",
    content: "Stopped by user.",
    metadata: { runId: "stopped-run" }
  }));
  const { service } = testService({ conversation });

  await (service as any).appendParticipantTurnMessages(conversation, participant, [
    pendingParticipantMessage(participant, "stopped", "stopped-run", {
      status: "done",
      content: "Late answer that should be ignored.",
      metadata: { runId: "stopped-run" }
    })
  ]);

  const after = conversation.messages.find((message: any) => message.id === "stopped")!;
  assert.equal(after.status, "error");
  assert.equal(after.content, "Stopped by user.");
});

test("recoverStaleChatRun keeps run metadata when a pending bubble is live only via the registry", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "registry-only-run";
  const conversation = chatConversation([participant], { activeRunIds: [runId], running: true });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-registry", runId));
  const { service } = testService({ conversation });
  // Stale metadata lists the run, the in-memory activeRunIds Set has lost it, but
  // the controller/meta registry still tracks it as live.
  (service as any).chatRunMeta.set(runId, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });

  const changed = (service as any).recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  assert.deepEqual(conversation.metadata.activeRunIds, [runId]);
  assert.equal(conversation.metadata.running, true);
  const warnings = (conversation.metadata.warnings as string[] | undefined) ?? [];
  assert.equal(warnings.some((warning) => /interrupt/i.test(warning)), false);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-registry")!.status, "pending");
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
  await (service as any).appendParticipantTurnMessages(conversation, participant, [
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

test("app MCP advertises app_chat_react to chat participants", () => {
  const appMcp = new AppMcpService();
  const tools = (appMcp as any).toolsForActor({
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: []
  }) as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> }; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
  const reactionTool = tools.find((tool) => tool.name === APP_CHAT_REACT_TOOL);
  const exportTool = tools.find((tool) => tool.name === APP_CHAT_EXPORT_ATTACHMENT_TOOL);

  assert.ok(reactionTool);
  assert.ok(reactionTool.inputSchema?.properties?.messageId);
  assert.ok(reactionTool.inputSchema?.properties?.emoji);
  assert.ok(exportTool);
  assert.equal(exportTool.annotations?.readOnlyHint, false);
  assert.equal(exportTool.annotations?.destructiveHint, true);
  assert.ok(exportTool.inputSchema?.properties?.attachmentId);
  assert.ok(exportTool.inputSchema?.properties?.targetPath);
  assert.ok(tools.find((tool) => tool.name === APP_TOOL_PERMISSION_TOOL));
});

test("appMcpToolNames exposes participant request only with participants.request capability", () => {
  const { service } = testService();
  const defaultTools = (service as any).appMcpToolNames([]);
  const requestTools = (service as any).appMcpToolNames(["participants.request"]);

  assert.equal(defaultTools.includes(APP_CHAT_REQUEST_PARTICIPANTS_TOOL), false);
  assert.ok(defaultTools.includes(APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL));
  assert.ok(requestTools.includes(APP_CHAT_REQUEST_PARTICIPANTS_TOOL));
  assert.ok(requestTools.includes(APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL));
});

test("app MCP tracks client generation setup and required tools", async () => {
  const appMcp = new AppMcpService();
  const actor = {
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: ["participants.request"],
    clientGenerationId: "client-generation-1",
    expectedToolNames: [
      APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
      APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL
    ]
  };

  await (appMcp as any).handleRpcRequest(actor, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {}
  });
  let status = appMcp.clientStatus("client-generation-1");
  assert.equal(status?.initialized, true);
  assert.equal(status?.listedTools, false);

  await (appMcp as any).handleRpcRequest(actor, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  status = appMcp.clientStatus("client-generation-1");
  assert.equal(status?.listedTools, true);
  assert.equal(status?.requiredToolsPresent, true);
  assert.deepEqual(status?.missingToolNames, []);
});

test("app MCP client generation records missing expected tools", async () => {
  const appMcp = new AppMcpService();
  const actor = {
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: [],
    clientGenerationId: "client-generation-missing",
    expectedToolNames: ["missing-tool"]
  };

  await (appMcp as any).handleRpcRequest(actor, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  });
  const status = appMcp.clientStatus("client-generation-missing");

  assert.equal(status?.listedTools, true);
  assert.equal(status?.requiredToolsPresent, false);
  assert.deepEqual(status?.missingToolNames, ["missing-tool"]);
});

test("app MCP role request tool is not provider-destructive because app approval gates deletion", () => {
  const appMcp = new AppMcpService();
  const tools = (appMcp as any).toolsForActor({
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ADMIN_ROLE.id,
    roleConfigVersion: ADMIN_ROLE.version,
    capabilities: ["participants.manage"]
  }) as Array<{ name: string; annotations?: { destructiveHint?: boolean } }>;
  const roleRequestTool = tools.find((tool) => tool.name === APP_ROLES_REQUEST_CHANGE_TOOL);

  assert.ok(roleRequestTool);
  assert.equal(roleRequestTool.annotations?.destructiveHint, false);
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

  (service as any).applyCliRunMetadata(session, {
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

test("participant behavior rules are merged into session role instructions", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "concise",
    label: "Be concise",
    instructions: "Keep replies short unless User asks for detail.",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };

  const session = await (service as any).newSessionForParticipant(participant);

  assert.match(session.roleInstructions, /## Participant Behavior Rules/);
  assert.match(session.roleInstructions, /### Be concise/);
  assert.match(session.roleInstructions, /Keep replies short unless User asks for detail/);
  assert.deepEqual(session.participantBehaviorRules, [{
    id: behaviorRule.id,
    label: behaviorRule.label,
    instructions: behaviorRule.instructions,
    version: behaviorRule.version
  }]);
});

test("behavior rules are reinforced in every turn prompt even when role instructions are omitted", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "greeting",
    label: "Test Rule",
    instructions: "Always start message with \"hi\".",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await (service as any).newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];

  // Simulate a resume turn: native role runtime, so role instructions are not re-sent.
  const { prompt, sections } = (service as any).buildPromptParts(
    conversation,
    participant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: false, agentMode: "default", permissions: participant.permissions }
  );

  assert.match(prompt, /Active behavior rules/);
  assert.match(prompt, /- Test Rule: Always start message with "hi"\./);
  assert.ok(sections.behaviorRules > 0);
  // Role instructions are excluded on this turn, so the full role-embedded section must be absent;
  // only the per-turn reinforcement carries the rule.
  assert.doesNotMatch(prompt, /## Participant Behavior Rules/);
});

test("behavior rule prompt reinforcement truncates oversized legacy rule instructions", async () => {
  const longInstructions = `${"x".repeat(CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS + 20)} sentinel`;
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "large-rule",
    label: "Large Rule",
    instructions: longInstructions,
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await (service as any).newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];

  const { prompt } = (service as any).buildPromptParts(
    conversation,
    participant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: false, agentMode: "default", permissions: participant.permissions }
  );

  const promptText = prompt as string;
  const ruleLine = promptText.split("\n").find((line: string) => line.startsWith("- Large Rule: "));
  assert.ok(ruleLine);
  const reinforcedInstructions = ruleLine.replace("- Large Rule: ", "");
  assert.equal(reinforcedInstructions.length <= CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS, true);
  assert.match(reinforcedInstructions, /\.\.\.$/);
  assert.doesNotMatch(reinforcedInstructions, /sentinel/);
});

test("behavior rule reinforcement preserves multi-line rule structure instead of flattening it", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "multi-step",
    label: "Multi Step",
    instructions: "Follow these steps:\n1. Greet\n2. Answer\n3. Summarize",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await (service as any).newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];

  const { prompt } = (service as any).buildPromptParts(
    conversation,
    participant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: false, agentMode: "default", permissions: participant.permissions }
  );

  const promptText = prompt as string;
  // Continuation lines stay on their own indented lines under the bullet.
  assert.ok(promptText.includes("- Multi Step: Follow these steps:\n  1. Greet\n  2. Answer\n  3. Summarize"));
  // The structure must not be collapsed into a single line.
  assert.doesNotMatch(promptText, /Follow these steps: 1\. Greet/);
});

test("behavior rule reinforcement is skipped when role instructions already carry the rules", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "concise",
    label: "Be concise",
    instructions: "Keep replies short unless User asks for detail.",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await (service as any).newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];

  // First / refreshed turn: role instructions are included and embed the rules verbatim.
  const { prompt, sections } = (service as any).buildPromptParts(
    conversation,
    participant,
    session,
    triggerMessage,
    "/tmp/workspace",
    false,
    { includeRoleInstructions: true, agentMode: "default", permissions: participant.permissions }
  );

  assert.match(prompt, /## Participant Behavior Rules/);
  // No duplicated, divergent reinforcement copy in the same prompt.
  assert.doesNotMatch(prompt, /Active behavior rules/);
  assert.equal(sections.behaviorRules, 0);
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
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const result = await service.requestParticipantsFromTool(participantRequestActor(requester), {
    requests: [{ target: target.handle, prompt: "Please review." }],
    timeoutMs: 5000
  });

  assert.equal(result.ok, true);
  assert.equal(result.approvalRequired, false);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, target.id);
  assert.equal(storage.current.metadata.pendingAppToolApprovals, undefined);
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
    () => defaultService.prepareParticipantRequest(conversation, requester, normalizedRequest, actor, "mcp"),
    /max depth \(2\) reached/
  );

  const { service } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ROLE],
      chatParticipantRequestMaxDepth: 3
    }
  });
  const prepared = await (service as any).prepareParticipantRequest(
    conversation,
    requester,
    normalizedRequest,
    actor,
    "mcp"
  );

  assert.equal(prepared.batch.depth, 3);
  assert.equal(prepared.batch.status, "running");
});

test("agent modes do not promote participant request permission", () => {
  const ask = normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "ask" });
  const deny = normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "deny" });

  assert.equal(effectiveChatAgentPermissionsForProvider("codex-cli", "auto", ask).requestParticipants, "ask");
  assert.equal(effectiveChatAgentPermissionsForProvider("codex-cli", "plan", ask).requestParticipants, "ask");
  assert.equal(effectiveChatAgentPermissionsForProvider("codex-cli", "auto", deny).requestParticipants, "deny");
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

  const loaded = await (service as any).requireChat(conversation.id);

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
  (service as any).ensureHistoryFiles = async () => tempRoot;

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
  assert.match(userMessage.content, /@codex \/accord/);
  assert.match(userMessage.content, /Selected accord participants: drew\./);
  assert.doesNotMatch(userMessage.content, /@drew/);

  const facilitatorAfterStart = storage.current.metadata.participants.find((participant: ChatParticipant) => participant.id === facilitator.id);
  assert.equal(facilitatorAfterStart.permissions.requestParticipants, "allow");
  assert.deepEqual(storage.current.metadata.appToolApprovalPolicies, undefined);
  assert.equal(result.sourceMessageId, userMessage.id);
});

test("manual accord structured skill mention flips only the dispatched facilitator", () => {
  const facilitator = chatParticipant("codex-cli");
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([facilitator, target]);
  const { service } = testService({ conversation });

  const nextTargets = (service as any).allowParticipantRequestsForManualAccordIfSelected(
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

function testService(options: {
  conversation?: Conversation;
  run?: (...args: any[]) => Promise<any>;
  agents?: AgentHealth[];
  userSkills?: any;
  appMcp?: AppMcpService;
  onSnapshot?: (conversation: Conversation) => void;
  settings?: {
    chatRoleConfigs: ChatRoleConfig[];
    chatBehaviorRules?: ChatBehaviorRuleConfig[];
    chatParticipantConfigs?: ChatParticipantConfig[];
    chatParticipantRequestMaxDepth?: number;
  };
} = {}): { service: ChatService; storage: any; settingsState: {
  chatRoleConfigs: ChatRoleConfig[];
  chatBehaviorRules: ChatBehaviorRuleConfig[];
  chatParticipantConfigs: ChatParticipantConfig[];
  batchWriteCount: number;
}; tempRoot: string } {
  const tempRoot = path.join(tmpdir(), "accordagents-chat-permissions-test");
  const storage = {
    current: options.conversation ? clone(options.conversation) : undefined,
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    }
  };
  const settingsState = {
    chatRoleConfigs: clone(options.settings?.chatRoleConfigs ?? [ROLE]),
    chatBehaviorRules: clone(options.settings?.chatBehaviorRules ?? []),
    chatParticipantConfigs: clone(options.settings?.chatParticipantConfigs ?? []),
    batchWriteCount: 0
  };
  const publicSettings = (): AppSettings => ({
    roundLimitDefault: 1,
    cliAgentRunTimeoutMs: 24 * 60 * 60_000,
    chatParticipantRequestMaxDepth: options.settings?.chatParticipantRequestMaxDepth
      ?? CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    providers: [
      { kind: "codex-cli", label: "Codex CLI", enabled: true },
      { kind: "claude-code", label: "Claude Code", enabled: true }
    ],
    chatRoleConfigs: clone(settingsState.chatRoleConfigs),
    chatBehaviorRules: clone(settingsState.chatBehaviorRules),
    chatSavedPrompts: [],
    chatParticipantConfigs: clone(settingsState.chatParticipantConfigs),
    chatParticipantSeedState: {}
  });
  const roleIdFromLabel = (label: string): string =>
    `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "role"}-test`;
  const settings = {
    async getPublicSettings(): Promise<AppSettings> {
      return publicSettings();
    },
    async ensureGenericChatParticipantSeeds(): Promise<AppSettings> {
      return publicSettings();
    },
    async getChatParticipantRequestMaxDepth(): Promise<number> {
      return publicSettings().chatParticipantRequestMaxDepth;
    },
    async saveChatRoleConfig(update: ChatRoleConfigUpdate): Promise<AppSettings> {
      const existing = update.id ? settingsState.chatRoleConfigs.find((role) => role.id === update.id) : undefined;
      if (existing) {
        settingsState.chatRoleConfigs = settingsState.chatRoleConfigs.map((role) =>
          role.id === existing.id
            ? {
                ...role,
                label: update.label,
                instructions: update.instructions,
                appToolCapabilities: update.appToolCapabilities ?? role.appToolCapabilities,
                version: role.version + 1,
                updatedAt: NOW
              }
            : role
        );
      } else {
        const id = roleIdFromLabel(update.label);
        settingsState.chatRoleConfigs.push({
          id,
          label: update.label,
          instructions: update.instructions,
          version: 1,
          builtIn: false,
          appToolCapabilities: update.appToolCapabilities,
          updatedAt: NOW
        });
      }
      return publicSettings();
    },
    async saveChatParticipantConfig(update: ChatParticipantConfigUpdate): Promise<AppSettings> {
      const next: ChatParticipantConfig = {
        id: update.id ?? `participant-${settingsState.chatParticipantConfigs.length + 1}`,
        handle: update.handle.replace(/^@/, ""),
        roleConfigId: update.roleConfigId,
        behaviorRuleIds: update.behaviorRuleIds ?? [],
        kind: update.kind,
        model: update.model,
        reasoningEffort: update.reasoningEffort,
        avatarId: update.avatarId,
        agentMode: update.agentMode,
        permissions: normalizeChatAgentPermissions(update.permissions),
        updatedAt: NOW
      };
      settingsState.chatParticipantConfigs = settingsState.chatParticipantConfigs.some((participant) => participant.id === next.id)
        ? settingsState.chatParticipantConfigs.map((participant) => participant.id === next.id ? next : participant)
        : [...settingsState.chatParticipantConfigs, next];
      return publicSettings();
    },
    async saveChatRoleParticipantConfigBatch(
      roleOperations: ChatRoleChangeOperation[],
      participantUpdates: ChatParticipantConfigUpdate[]
    ): Promise<{ settings: AppSettings; roleIdByDraftRoleRef: Record<string, string> }> {
      settingsState.batchWriteCount += 1;
      const roleIdByDraftRoleRef: Record<string, string> = {};
      for (const operation of roleOperations) {
        if (operation.type === "create_role") {
          const id = roleIdFromLabel(operation.role.label);
          if (operation.role.draftRoleRef) {
            roleIdByDraftRoleRef[operation.role.draftRoleRef] = id;
          }
          settingsState.chatRoleConfigs.push({
            id,
            label: operation.role.label,
            instructions: operation.role.instructions,
            version: 1,
            builtIn: false,
            appToolCapabilities: operation.role.appToolCapabilities,
            updatedAt: NOW
          });
        } else if (operation.type === "edit_role") {
          settingsState.chatRoleConfigs = settingsState.chatRoleConfigs.map((role) =>
            role.id === operation.role.roleConfigId
              ? {
                  ...role,
                  label: operation.role.label,
                  instructions: operation.role.instructions,
                  appToolCapabilities: operation.role.appToolCapabilities ?? role.appToolCapabilities,
                  version: role.version + 1,
                  updatedAt: NOW
                }
              : role
          );
        }
      }
      for (const update of participantUpdates) {
        await settings.saveChatParticipantConfig({
          ...update,
          roleConfigId: roleIdByDraftRoleRef[update.roleConfigId] ?? update.roleConfigId
        });
      }
      return { settings: publicSettings(), roleIdByDraftRoleRef };
    }
  };
  const cliRunner = {
    async detectAgents(): Promise<AgentHealth[]> {
      return clone(options.agents ?? []);
    },
    run: options.run ?? (async (participant: ParticipantConfig) => ({
      participant,
      ok: true,
      content: "ok",
      durationMs: 1
    }))
  };
  const debugLogs = {
    async write(): Promise<void> {
      return undefined;
    }
  };
  return {
    service: new ChatService(storage as never, settings as never, cliRunner as never, debugLogs as never, options.appMcp as never, options.onSnapshot, options.userSkills as never),
    storage,
    settingsState,
    tempRoot
  };
}

function chatParticipant(
  kind: ChatParticipant["kind"],
  permissionPatch: Partial<ReturnType<typeof defaultChatAgentPermissions>> = {}
): ChatParticipant {
  const permissions = normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    ...permissionPatch,
    shell: {
      ...defaultChatAgentPermissions().shell,
      ...permissionPatch.shell
    }
  });
  return {
    id: kind === "claude-code" ? "claude-participant" : "codex-participant",
    handle: kind === "claude-code" ? "drew" : "codex",
    roleConfigId: ROLE.id,
    kind,
    agentMode: "default",
    permissions
  };
}

function chatConversation(participants: ChatParticipant[], metadata: Record<string, any> = {}): Conversation {
  return {
    id: "conversation-1",
    title: "Test chat",
    kind: "chat",
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{
      id: "user-message",
      role: "user",
      content: "Please help.",
      createdAt: NOW,
      status: "done"
    }],
    findings: [],
    metadata: {
      participants,
      ...metadata
    }
  };
}

function permissionApproval(
  participant: ChatParticipant,
  request: ChatAppToolApproval["request"],
  patch: Partial<ChatAppToolApproval> = {}
): ChatAppToolApproval {
  return {
    id: patch.id ?? "approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: participant.roleConfigId,
    toolName: APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
    capability: "permissions.request",
    status: "pending",
    request,
    summary: "Grant permission",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  };
}

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

function participantRequestActor(participant: ChatParticipant): any {
  return {
    conversationId: "conversation-1",
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: ["participants.request"],
    triggerMessageId: "user-message",
    triggerThreadId: "user-message",
    snapshotMaxSequence: 0,
    continuation: false,
    participantRequestDepth: 0
  };
}

function participantRequestApproval(
  participant: ChatParticipant,
  requests: Array<{ target: string; prompt: string; reason?: string }>,
  patch: Partial<ChatAppToolApproval> & { requestMessageId?: string; batchId?: string } = {}
): ChatAppToolApproval {
  const { requestMessageId, batchId, ...approvalPatch } = patch;
  return {
    id: approvalPatch.id ?? "participant-request-approval-1",
    conversationId: "conversation-1",
    requesterParticipantId: participant.id,
    requesterHandle: participant.handle,
    requesterRoleConfigId: participant.roleConfigId,
    toolName: APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
    capability: "participants.request",
    status: "pending",
    request: {
      requests,
      resumeRequester: true,
      source: "mcp",
      requestMessageId,
      batchId
    },
    summary: "Request participant input",
    createdAt: NOW,
    updatedAt: NOW,
    ...approvalPatch
  };
}

function participantManagerActor(conversationId: string, participant: ChatParticipant): {
  conversationId: string;
  participantId: string;
  roleConfigId: string;
  roleConfigVersion: number;
  capabilities: ["participants.manage"];
} {
  return {
    conversationId,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: ["participants.manage"]
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

async function flushMicrotasks(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function skillMention(kind: ChatParticipant["kind"]): unknown {
  return {
    skillId: "skill-1",
    displayName: "/accord",
    frontmatterName: "accord",
    description: "Accord",
    contentHash: "hash",
    capabilityState: "invocable",
    variants: [{
      providerKind: kind,
      scope: "personal",
      rootKind: "personal",
      sourceKey: "src",
      frontmatterName: "accord",
      contentHash: "hash",
      capabilityState: "invocable"
    }]
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
