import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APP_CHAT_EXPORT_ATTACHMENT_TOOL,
  APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL,
  APP_CHAT_LIST_ATTACHMENTS_TOOL,
  APP_CHAT_READ_ATTACHMENT_TOOL,
  APP_CHAT_REACT_TOOL,
  APP_CHAT_REQUEST_COMPACTION_TOOL,
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
  APP_CHAT_SET_TITLE_TOOL,
  APP_PARTICIPANTS_REQUEST_CHANGE_TOOL,
  APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
  APP_ROLES_REQUEST_CHANGE_TOOL,
  APP_ROSTER_REQUEST_CHANGE_TOOL,
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
import {
  CHAT_PARTICIPANT_REQUEST_MAX_CHAIN_BATCHES,
  CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
  CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT
} from "../../shared/chatParticipantRequests";
import { CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT } from "../../shared/chatAutoWatch";
import { DEFAULT_CHAT_PROMPT_CONTEXT } from "../../shared/chatPromptContext";
import { preferredReadyAssistantProviderKind } from "../../shared/cliReadiness";
import type {
  AgentHealth,
  AppSettings,
  ChatAgentActivityEvent,
  ChatAppToolApproval,
  ChatAppToolApprovalPolicy,
  ChatBehaviorRuleConfig,
  ChatMessage,
  ChatParticipant,
  ChatParticipantConfig,
  ChatParticipantConfigUpdate,
  ChatParticipantRequestBatch,
  ChatParticipantRequestStatus,
  ChatParticipantSession,
  ChatProviderKind,
  ChatRoleChangeOperation,
  ChatRoleConfig,
  ChatRoleConfigUpdate,
  ChatSkillMention,
  Conversation,
  ParticipantConfig,
  ProviderSettings
} from "../../shared/types";
import {
  chatActivityEventsForSegment,
  chatInlineTranscriptParts,
  chatProcessingTranscriptPrefix,
  chatProcessingTranscriptView,
  chatProcessingTranscriptViewHasHidden
} from "../../shared/processingTranscript";
import { issueFromRequirement, RemoteRunPreflightError } from "./toolchainRequirements";
import type { ToolchainRequirement } from "./toolchainRequirements";

const NOW = "2026-05-17T12:00:00.000Z";
const ONE_BY_ONE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

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
  participantDefaults: {
    autoWatch: false,
    requestParticipants: "ask",
    manageRolesParticipants: "ask"
  },
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
    manageRolesParticipants: "allow",
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
  assert.equal(normalized.manageRolesParticipants, "allow");
  assert.equal(normalized.requestCompaction, "ask");
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
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(progressItems.at(-1)?.partialContent, full);
  assert.equal(progressItems.at(-1)?.activityEvents?.length, 1);
  assert.equal(sink.processingTranscript(NOW)?.content, full);
});

test("agent progress sink coalesces rapid text updates and flushes the latest partial", async () => {
  const service = testService().service as any;
  const progressItems: Array<{ state?: string; partialContent?: string }> = [];
  const sink = service.createAgentProgressSink(
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
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(progressItems.at(-1)?.partialContent, undefined);

  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.equal(progressItems.at(-1)?.partialContent, "AB");
});

test("agent progress sink emits finish immediately and suppresses pending flushes", async () => {
  const service = testService().service as any;
  const progressItems: Array<{ state?: string; partialContent?: string }> = [];
  const sink = service.createAgentProgressSink(
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

  const countAfterFinish = progressItems.length;
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(progressItems.length, countAfterFinish);
});

test("run owner heartbeat timer clears when final active run is forgotten", () => {
  const service = testService().service as any;

  service.rememberActiveChatRun("conversation-1", "run-1");
  assert.ok(service.runOwnerHeartbeatTimer);

  service.forgetActiveChatRun("conversation-1", "run-1");
  assert.equal(service.runOwnerHeartbeatTimer, undefined);
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
  }), /only be approved for Claude Code members/);

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

test("permission request has stable requestId and idempotent replay after approval", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    runId: "remote-run-1",
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  };
  const request = {
    kind: "portable",
    permissions: ["webAccess"],
    reason: "Need live web lookup from the remote worker."
  };

  const first = await service.requestPermissionChangeFromTool(actor, request);
  assert.equal(first.status, "pending_user_approval");
  assert.equal(typeof first.requestId, "string");
  assert.equal(first.requestId, first.approvalId);

  const duplicate = await service.requestPermissionChangeFromTool(actor, request);
  assert.equal(duplicate.status, "pending_user_approval");
  assert.equal(duplicate.requestId, first.requestId);
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    1
  );
  assert.equal(
    storage.current.messages.filter((message: ChatMessage) => message.content.startsWith("Permission approval needed")).length,
    1
  );

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: first.requestId ?? "",
    approve: true,
    scope: "once"
  });

  const lookup = await service.requestPermissionChangeFromTool(actor, { requestId: first.requestId });
  assert.equal(lookup.status, "approved");
  assert.equal(lookup.requestId, first.requestId);
  assert.equal(lookup.approvalScope, "once");

  const replayAfterDecision = await service.requestPermissionChangeFromTool(actor, request);
  assert.equal(replayAfterDecision.status, "approved");
  assert.equal(replayAfterDecision.requestId, first.requestId);
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    1
  );
});

test("permission request status lookup returns denied decisions idempotently", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    runId: "remote-run-2",
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  };

  const pending = await service.requestPermissionChangeFromTool(actor, {
    kind: "portable",
    permissions: ["webAccess"]
  });
  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: pending.requestId ?? "",
    approve: false
  });

  const lookup = await service.requestPermissionChangeFromTool(actor, { requestId: pending.requestId });
  assert.equal(lookup.status, "denied");
  assert.equal(lookup.requestId, pending.requestId);
});

test("permission request status lookup is scoped to the actor run", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request" as const],
    runId: "remote-run-a",
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  };

  const pending = await service.requestPermissionChangeFromTool(actor, {
    kind: "portable",
    permissions: ["webAccess"]
  });
  const otherRunLookup = await service.requestPermissionChangeFromTool({
    ...actor,
    runId: "remote-run-b"
  }, {
    requestId: pending.requestId
  });

  assert.equal(otherRunLookup.ok, false);
  assert.equal(otherRunLookup.status, "not_found");
  assert.equal(otherRunLookup.requestId, pending.requestId);
});

test("permission request already_granted uses run-scoped permissions when present", async () => {
  const participant = {
    ...chatParticipant("codex-cli", { webAccess: true }),
    agentMode: "auto" as const
  };
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "remote-run-3",
    triggerMessageId: "user-message",
    runPermissions: defaultChatAgentPermissions()
  }, {
    kind: "portable",
    permissions: ["webAccess"]
  });

  assert.equal(result.status, "pending_user_approval");
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    1
  );
});

test("permission request returns already_granted when run-scoped permissions cover it", async () => {
  const participant = chatParticipant("claude-code", { webAccess: false });
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });

  const result = await service.requestPermissionChangeFromTool({
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 0,
    capabilities: ["permissions.request"],
    runId: "remote-run-4",
    triggerMessageId: "user-message",
    runPermissions: { ...defaultChatAgentPermissions(), webAccess: true }
  }, {
    kind: "portable",
    permissions: ["webAccess"]
  });

  assert.equal(result.status, "already_granted");
  assert.equal(
    ((storage.current.metadata.pendingAppToolApprovals ?? []) as ChatAppToolApproval[])
      .filter((approval) => approval.toolName === APP_PERMISSIONS_REQUEST_CHANGE_TOOL).length,
    0
  );
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

test("local provider preference records only the first nonempty successful Assistant response", async () => {
  const participant = { ...chatParticipant("claude-code"), roleConfigId: ADMIN_ROLE.id, handle: "assistant" };
  const conversation = chatConversation([participant]);
  let outcome: "failed" | "empty" | "success" = "failed";
  const { service, settingsState, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] },
    run: async (runParticipant) => outcome === "failed"
      ? { participant: runParticipant, ok: false, content: "Provider failed.", error: "failed", durationMs: 1 }
      : outcome === "empty"
        ? { participant: runParticipant, ok: true, content: "", durationMs: 1 }
        : { participant: runParticipant, ok: true, content: "Completed.", durationMs: 1 }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "failed-preference", undefined, undefined, { warnings: [] }
  );
  assert.deepEqual(settingsState.recordedSuccessfulProviders, []);

  outcome = "empty";
  await (service as any).runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "empty-preference", undefined, undefined, { warnings: [] }
  );
  assert.deepEqual(settingsState.recordedSuccessfulProviders, []);

  outcome = "success";
  await (service as any).runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "successful-preference", undefined, undefined, { warnings: [] }
  );
  assert.deepEqual(settingsState.recordedSuccessfulProviders, ["claude-code"]);

  await (service as any).runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "later-success", undefined, undefined, { warnings: [] }
  );
  assert.deepEqual(settingsState.recordedSuccessfulProviders, ["claude-code"]);
  assert.equal(conversation.metadata.activationProviderKind, "claude-code");
});

test("successful non-Assistant participant responses do not change the Assistant provider preference", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const { service, settingsState, tempRoot } = testService({ conversation });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runParticipantTurnSerialized(
    conversation, participant, conversation.messages[0], "generic-success", undefined, undefined, { warnings: [] }
  );

  assert.deepEqual(settingsState.recordedSuccessfulProviders, []);
  assert.equal(conversation.metadata.activationProviderKind, undefined);
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
        depth: 2,
        requesterDepth: 1,
        chainRootId: "chain-root",
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

test("permission resume preserves target depth instead of requester depth", async () => {
  const requester = chatParticipant("codex-cli");
  const target = chatParticipant("claude-code");
  const trigger: ChatMessage = {
    id: "request-message",
    role: "system",
    content: "@target continue after permission.",
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "thread-1",
      participantRequest: {
        id: "batch-1",
        requesterParticipantId: requester.id,
        requesterHandle: requester.handle,
        source: "mcp",
        resumeRequester: true,
        status: "running",
        depth: 2,
        requesterDepth: 1,
        chainRootId: "chain-root",
        createdAt: NOW,
        updatedAt: NOW,
        triggerMessageId: "user-message",
        items: [{
          targetParticipantId: target.id,
          targetHandle: target.handle,
          prompt: "Continue after permission.",
          status: "running",
          createdAt: NOW,
          updatedAt: NOW
        }]
      }
    }
  };
  const approval = permissionApproval(target, {
    kind: "portable",
    permissions: ["webAccess"]
  }, {
    approvalScope: "once",
    status: "approved",
    resumeContext: {
      runId: "blocked-run",
      triggerMessageId: trigger.id,
      participantRequestBatchId: "batch-1"
    }
  });
  const conversation = chatConversation([requester, target], { pendingAppToolApprovals: [approval] });
  conversation.messages.push(trigger);
  const { service, storage, tempRoot } = testService({ conversation });
  const serviceAny = service as any;
  const capturedRuns: Array<{ participantId: string; options: any }> = [];
  serviceAny.ensureHistoryFiles = async () => tempRoot;
  serviceAny.runParticipantTurnSerialized = async (
    _conversation: Conversation,
    participant: ChatParticipant,
    _trigger: ChatMessage,
    _runId: string,
    _signal: AbortSignal | undefined,
    _progress: unknown,
    options: any
  ) => {
    capturedRuns.push({ participantId: participant.id, options });
    return [{
      id: "target-reply",
      role: "participant",
      participantId: participant.id,
      participantLabel: `@${participant.handle}`,
      content: "Target resumed at preserved depth.",
      createdAt: NOW,
      status: "done",
      metadata: {
        threadId: "thread-1",
        parentMessageId: trigger.id,
        sourceMessageId: trigger.id
      }
    }];
  };

  await serviceAny.autoResumePermissionApproval(conversation.id, approval.id);
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.id === "target-reply"));

  const targetRun = capturedRuns.find((run) => run.participantId === target.id);
  assert.equal(targetRun?.options.participantRequestDepth, 2);
  assert.equal(targetRun?.options.participantRequestBatchId, "batch-1");
  assert.equal(targetRun?.options.chainRootId, "chain-root");
  await waitFor(() => capturedRuns.some((run) => run.participantId === requester.id));
  const requesterRun = capturedRuns.find((run) => run.participantId === requester.id);
  assert.equal(requesterRun?.options.participantRequestDepth, 1);
  assert.equal(requesterRun?.options.participantRequestBatchId, "batch-1");
  assert.equal(requesterRun?.options.chainRootId, "chain-root");
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

test("stop from a non-owner instance records a cancel request the owning instance honors", async () => {
  const participant = chatParticipant("gemini-cli");
  const runId = "cross-instance-run";
  const ownerHeartbeat = new Date().toISOString();
  const conversation = chatConversation([participant], {
    running: true,
    runId,
    activeRunIds: [runId],
    activeRunOwnersByRunId: {
      [runId]: {
        processId: process.ppid,
        instanceId: "owner-instance",
        startedAt: ownerHeartbeat,
        updatedAt: ownerHeartbeat
      }
    }
  });
  const { service, storage } = testService({ conversation });

  // This instance has no controller for the run and the owner heartbeat is
  // fresh: Stop must enqueue a cancel request instead of silently no-oping or
  // sweeping the owner's live run state.
  assert.equal(service.cancelRun(runId), true);
  await waitFor(() => storage.cancelRequests.has(runId));
  assert.deepEqual(storage.current.metadata.activeRunIds, [runId]);
  assert.equal(storage.current.metadata.running, true);

  // The owning instance shares the same storage and holds the live controller.
  const ownerService = new ChatService(
    storage as never,
    {} as never,
    {} as never,
    { write: async () => undefined } as never
  );
  const controller = new AbortController();
  (ownerService as never as {
    registerTargetRun(runId: string, controller: AbortController, meta: { conversationId: string; participantId: string; participantHandle: string }): void;
  }).registerTargetRun(runId, controller, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });
  (ownerService as never as {
    rememberActiveChatRun(conversationId: string, runId: string): void;
  }).rememberActiveChatRun(conversation.id, runId);

  await (ownerService as never as {
    consumeCrossInstanceCancelRequests(): Promise<void>;
  }).consumeCrossInstanceCancelRequests();

  assert.equal(controller.signal.aborted, true);
  assert.equal(storage.cancelRequests.size, 0);
});

test("cross-instance cancel requests stay queued until the run registers a controller", async () => {
  const participant = chatParticipant("gemini-cli");
  const runId = "early-active-run";
  const conversation = chatConversation([participant], {
    running: true,
    runId,
    activeRunIds: [runId]
  });
  const { storage } = testService({ conversation });
  storage.cancelRequests.set(runId, conversation.id);

  const ownerService = new ChatService(
    storage as never,
    {} as never,
    {} as never,
    { write: async () => undefined } as never
  );
  const ownerInternals = ownerService as never as {
    rememberActiveChatRun(conversationId: string, runId: string): void;
    registerTargetRun(runId: string, controller: AbortController, meta: { conversationId: string; participantId: string; participantHandle: string }): void;
    consumeCrossInstanceCancelRequests(): Promise<void>;
  };

  // beginChatRun marks the run active before the turn registers its abort
  // controller; a heartbeat tick in that window must leave the request queued
  // instead of consuming it with nothing to abort.
  ownerInternals.rememberActiveChatRun(conversation.id, runId);
  await ownerInternals.consumeCrossInstanceCancelRequests();
  assert.equal(storage.cancelRequests.has(runId), true);
  assert.deepEqual(storage.current.metadata.activeRunIds, [runId]);
  assert.equal(storage.current.metadata.running, true);

  const controller = new AbortController();
  ownerInternals.registerTargetRun(runId, controller, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });
  await ownerInternals.consumeCrossInstanceCancelRequests();
  assert.equal(controller.signal.aborted, true);
  assert.equal(storage.cancelRequests.size, 0);
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
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["shared-run"]?.processId, process.pid);

  await (service as any).endChatRun(conversation, "shared-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId, undefined);
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
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["second-run"]?.processId, process.pid);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["first-run"], undefined);

  await (service as any).endChatRun(conversation, "second-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId, undefined);
});

test("active local run metadata stores participant attribution and clears it when idle", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const serviceAny = service as any;
  const controller = new AbortController();

  serviceAny.registerTargetRun("target-run", controller, {
    conversationId: conversation.id,
    participantId: participant.id,
    participantHandle: participant.handle
  });
  await serviceAny.beginChatRun(conversation, "target-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["target-run"]);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["target-run"], participant.id);

  await serviceAny.endChatRun(conversation, "target-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId, undefined);
  serviceAny.unregisterTargetRun("target-run", controller);
});

test("ending one participant run preserves survivor participant attribution", async () => {
  const codex = chatParticipant("codex-cli");
  const claude = chatParticipant("claude-code");
  const conversation = chatConversation([codex, claude]);
  const { service, storage } = testService({ conversation });
  const serviceAny = service as any;
  const firstController = new AbortController();
  const secondController = new AbortController();

  serviceAny.registerTargetRun("first-run", firstController, {
    conversationId: conversation.id,
    participantId: codex.id,
    participantHandle: codex.handle
  });
  serviceAny.registerTargetRun("second-run", secondController, {
    conversationId: conversation.id,
    participantId: claude.id,
    participantHandle: claude.handle
  });
  await serviceAny.beginChatRun(conversation, "first-run");
  await serviceAny.beginChatRun(conversation, "second-run");
  await serviceAny.endChatRun(conversation, "first-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["second-run"]);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["first-run"], undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["second-run"], claude.id);

  await serviceAny.endChatRun(conversation, "second-run");

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId, undefined);
  serviceAny.unregisterTargetRun("first-run", firstController);
  serviceAny.unregisterTargetRun("second-run", secondController);
});

test("local run owner heartbeat preserves participant attribution map", () => {
  const participant = chatParticipant("codex-cli");
  const { service } = testService();
  const metadata = {
    running: true,
    runId: "run-1",
    activeRunIds: ["run-1"],
    activeRunParticipantIdsByRunId: {
      "run-1": participant.id
    }
  };

  const updated = (service as any).metadataWithLocalRunOwner(metadata, "run-1", NOW);

  assert.equal(updated.activeRunOwnersByRunId?.["run-1"]?.processId, process.pid);
  assert.deepEqual(updated.activeRunParticipantIdsByRunId, {
    "run-1": participant.id
  });
});

test("ending a current run preserves live external run metadata", async () => {
  const participant = chatParticipant("claude-code");
  const ownerPid = process.ppid > 0 ? process.ppid : 1;
  const fresh = new Date().toISOString();
  const conversation = chatConversation([participant], {
    activeRunIds: ["external-run"],
    runId: "external-run",
    running: true,
    activeRunOwnersByRunId: {
      "external-run": {
        processId: ownerPid,
        instanceId: "external-instance",
        startedAt: NOW,
        updatedAt: fresh
      }
    },
    activeRunParticipantIdsByRunId: {
      "external-run": participant.id
    }
  });
  const { service, storage } = testService({ conversation });

  await (service as any).beginChatRun(conversation, "current-run");
  await (service as any).endChatRun(conversation, "current-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["external-run"]);
  assert.equal(storage.current.metadata.runId, "external-run");
  assert.equal(storage.current.metadata.running, true);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["external-run"]?.instanceId, "external-instance");
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["external-run"], participant.id);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId?.["current-run"], undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId?.["current-run"], undefined);
});

test("ending local launcher keeps remote run active until terminal state", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation });
  const now = "2026-06-27T22:00:00.000Z";
  conversation.metadata = {
    ...conversation.metadata,
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: conversation.id,
        participantId: participant.id,
        participantHandle: participant.handle,
        worker: { host: "worker.example" },
        status: "running",
        startedAt: now,
        updatedAt: now
      }
    }
  };

  await (service as any).beginChatRun(conversation, "remote-run");
  await (service as any).endChatRun(conversation, "remote-run");

  assert.deepEqual(storage.current.metadata.activeRunIds, ["remote-run"]);
  assert.equal(storage.current.metadata.running, true);
  assert.equal(storage.current.metadata.runId, "remote-run");
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId, undefined);

  await service.updateRemoteRunHandleState(conversation.id, "remote-run", {
    runId: "remote-run",
    conversationId: conversation.id,
    participantId: participant.id,
    status: "completed",
    completedAt: "2026-06-27T22:01:00.000Z"
  });

  assert.equal(storage.current.metadata.activeRunIds, undefined);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId, undefined);
  assert.equal((storage.current.metadata.remoteRunHandles as any)["remote-run"].status, "completed");
});

test("remote provider_result without durationMs gets workedMs from handle timings", async () => {
  const participant = chatParticipant("codex-cli");
  const startedAt = "2026-06-27T22:00:00.000Z";
  const completedAt = "2026-06-27T22:01:00.000Z";
  const conversation = chatConversation([participant], {
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        participantId: participant.id,
        participantHandle: participant.handle,
        worker: { host: "worker.example" },
        status: "running",
        startedAt,
        completedAt,
        updatedAt: completedAt
      }
    }
  });
  (conversation.metadata.remoteRunHandles as any)["remote-run"].conversationId = conversation.id;
  const { service, storage } = testService({ conversation });

  await service.applyRemoteRunReplayRecord({
    kind: "provider_result",
    id: "remote-run:final",
    seq: 1,
    runId: "remote-run",
    conversationId: conversation.id,
    participantId: participant.id,
    ok: true,
    content: "Remote answer."
  } as any);
  await service.applyRemoteRunReplayRecord({
    kind: "terminal_state",
    id: "remote-run:terminal",
    seq: 2,
    runId: "remote-run",
    conversationId: conversation.id,
    status: "completed",
    createdAt: completedAt
  } as any);

  const msg = storage.current.messages.find(
    (item: Conversation["messages"][number]) =>
      item.role === "participant" && item.metadata?.runId === "remote-run"
  );
  assert.ok(msg, "expected a finalized remote participant message");
  assert.equal(msg?.status, "done");
  assert.equal(msg?.metadata?.workedMs, 60_000);
});

test("remote lifecycle status updates the original pending provider bubble", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        providerOutputMessageId: "pending-remote",
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push({
    id: "pending-remote",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    metadata: { runId: "remote-run" }
  });
  const { service, storage } = testService({ conversation });

  await service.applyRemoteRunReplayRecord({
    id: "remote-run:phase:syncing",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 1,
    createdAt: NOW,
    kind: "lifecycle",
    state: "started",
    remoteRunStatus: {
      phase: "syncing-files",
      label: "Syncing project files",
      startedAt: NOW,
      updatedAt: NOW
    }
  } as any);

  const msg = storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote");
  assert.equal(msg?.status, "pending");
  assert.equal(msg?.metadata?.appMessageSource, "remote-run-provider-output");
  assert.equal(msg?.metadata?.remoteRunStatus?.phase, "syncing-files");
  assert.equal(msg?.metadata?.remoteRunStatus?.label, "Syncing project files");
  assert.equal((storage.current.metadata.remoteRunReplay as any)["remote-run"].providerOutputMessageId, "pending-remote");
});

test("remote provider text reuses the pending bubble and marks processing started", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        providerOutputMessageId: "pending-remote",
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push({
    id: "pending-remote",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    metadata: { runId: "remote-run", appMessageSource: "remote-run-provider-output" }
  });
  const { service, storage } = testService({ conversation });

  await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:1",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 1,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${JSON.stringify({ type: "agent_message_delta", delta: "Remote text." })}\n`
  } as any);

  const messages = storage.current.messages.filter((item: ChatMessage) =>
    item.role === "participant" && item.participantId === participant.id
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "pending-remote");
  assert.equal(messages[0].content, "Remote text.");
  assert.equal(messages[0].status, "pending");
  assert.equal(messages[0].metadata?.remoteRunStatus?.phase, "processing-request");
  assert.equal(typeof messages[0].metadata?.remoteRunStatus?.processingStartedAt, "string");
});

test("remote provider completed agent message reuses the pending bubble", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        providerOutputMessageId: "pending-remote",
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push({
    id: "pending-remote",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    metadata: { runId: "remote-run", appMessageSource: "remote-run-provider-output" }
  });
  const { service, storage } = testService({ conversation });

  await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:1",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 1,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Remote complete text." }
    })}\n`
  } as any);

  const messages = storage.current.messages.filter((item: ChatMessage) =>
    item.role === "participant" && item.participantId === participant.id
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "pending-remote");
  assert.equal(messages[0].content, "Remote complete text.");
  assert.equal(messages[0].status, "pending");
  assert.equal(messages[0].metadata?.remoteRunStatus?.phase, "processing-request");
  assert.equal(typeof messages[0].metadata?.remoteRunStatus?.processingStartedAt, "string");
});

test("remote provider text keeps processing start stable across chunks", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        providerOutputMessageId: "pending-remote",
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push({
    id: "pending-remote",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    metadata: { runId: "remote-run", appMessageSource: "remote-run-provider-output" }
  });
  const { service, storage } = testService({ conversation });

  await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:1",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 1,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${JSON.stringify({ type: "agent_message_delta", delta: "Remote " })}\n`
  } as any);
  const firstStartedAt = storage.current.messages
    .find((item: ChatMessage) => item.id === "pending-remote")
    ?.metadata?.remoteRunStatus?.processingStartedAt;
  assert.equal(typeof firstStartedAt, "string");

  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:2",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 2,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${JSON.stringify({ type: "agent_message_delta", delta: "text." })}\n`
  } as any);

  const msg = storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote");
  assert.equal(msg?.content, "Remote text.");
  assert.equal(msg?.metadata?.remoteRunStatus?.processingStartedAt, firstStartedAt);
  assert.equal(
    (storage.current.metadata.remoteRunReplay as any)["remote-run"].remoteRunStatus.processingStartedAt,
    firstStartedAt
  );
});

test("remote provider activity survives split JSONL and renders before text", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        providerOutputMessageId: "pending-remote",
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push({
    id: "pending-remote",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    metadata: { runId: "remote-run", appMessageSource: "remote-run-provider-output" }
  });
  const { service, storage } = testService({ conversation });
  const commandLine = JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", command: "rg remote" }
  });
  const splitAt = Math.floor(commandLine.length / 2);

  await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:1",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 1,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: commandLine.slice(0, splitAt)
  } as any);

  assert.equal(storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote")?.metadata?.activityEvents, undefined);

  const activityResult = await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:2",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 2,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${commandLine.slice(splitAt)}\n`
  } as any);

  const activityMessage = storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote");
  assert.equal(activityResult.applied, true);
  assert.equal(activityMessage?.status, "pending");
  assert.equal(activityMessage?.content, "");
  assert.deepEqual(activityMessage?.metadata?.activityEvents?.map((event: ChatAgentActivityEvent) => [event.sequence, event.label]), [[1, "Running command"]]);

  const textResult = await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:3",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 3,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${JSON.stringify({ type: "agent_message_delta", delta: "Remote text." })}\n`
  } as any);
  const duplicate = await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:3",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 3,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${JSON.stringify({ type: "agent_message_delta", delta: "Remote text." })}\n`
  } as any);

  const message = storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote");
  const replay = (storage.current.metadata.remoteRunReplay as any)["remote-run"];
  assert.equal(textResult.applied, true);
  assert.equal(duplicate.applied, false);
  assert.equal(message?.content, "Remote text.");
  assert.deepEqual(message?.metadata?.activityEvents?.map((event: ChatAgentActivityEvent) => [event.sequence, event.label]), [[1, "Running command"]]);
  assert.equal(message?.metadata?.remoteRunStatus?.phase, "processing-request");
  assert.equal(replay.providerOutputLineBuffer, "");
  assert.equal(replay.providerActivitySequence, 1);
  assert.equal(replay.providerActivityEvents.length, 1);
});

test("remote activity accumulator survives restart, dedupes labels, and stays bounded", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        providerOutputMessageId: "pending-remote",
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push({
    id: "pending-remote",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    metadata: { runId: "remote-run", appMessageSource: "remote-run-provider-output" }
  });
  const first = testService({ conversation });
  await first.service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:first",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 1,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", name: "first_tool" } })}\n`
  } as any);

  const restarted = testService({ conversation: JSON.parse(JSON.stringify(first.storage.current)) });
  const toolLines = Array.from({ length: 82 }, (_, index) => JSON.stringify({
    type: "item.started",
    item: { type: "mcp_tool_call", name: `tool_${index}` }
  }));
  toolLines.push(toolLines.at(-1) as string);
  await restarted.service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-output:restored",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 2,
    createdAt: "2026-06-27T22:00:01.000Z",
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${toolLines.join("\n")}\n`
  } as any);

  const replay = (restarted.storage.current.metadata.remoteRunReplay as any)["remote-run"];
  const message = restarted.storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote");
  assert.equal(replay.providerActivitySequence, 83);
  assert.equal(replay.providerActivityEvents.length, 80);
  assert.equal(replay.providerOmittedActivityEventCount, 3);
  assert.equal(replay.providerActivityEvents[0].label, "Using tool_2");
  assert.equal(replay.providerActivityEvents.at(-1).label, "Using tool_81");
  assert.equal(message?.metadata?.activityEvents?.length, 80);
});

test("stale conversation replay merge does not double-count omitted remote activity", async () => {
  const participant = chatParticipant("codex-cli");
  const activityEvents = (from: number, to: number): ChatAgentActivityEvent[] =>
    Array.from({ length: to - from + 1 }, (_, index) => {
      const sequence = from + index;
      return {
        id: `remote-run:activity:${sequence}`,
        sequence,
        kind: "tool",
        label: `Using tool_${sequence}`,
        createdAt: `2026-06-27T22:00:00.${String(sequence).padStart(3, "0")}Z`,
        status: "started"
      };
    });
  const conversation = chatConversation([participant], {
    remoteRunReplay: {
      "remote-run": {
        cursorSeq: 140,
        appliedRecordIds: [],
        providerActivityEvents: activityEvents(61, 140),
        providerActivitySequence: 140,
        providerActivityLabel: "Using tool_140",
        providerOmittedActivityEventCount: 60,
        updatedAt: "2026-06-27T22:00:01.000Z"
      }
    }
  });
  const staleConversation = clone(conversation);
  const { service, storage } = testService({ conversation });
  storage.current.metadata.remoteRunReplay["remote-run"] = {
    cursorSeq: 150,
    appliedRecordIds: [],
    providerActivityEvents: activityEvents(71, 150),
    providerActivitySequence: 150,
    providerActivityLabel: "Using tool_150",
    providerOmittedActivityEventCount: 70,
    updatedAt: "2026-06-27T22:00:02.000Z"
  };

  await (service as any).refreshStoredChatState(staleConversation);

  const replay = (staleConversation.metadata.remoteRunReplay as any)["remote-run"];
  assert.equal(replay.providerActivitySequence, 150);
  assert.equal(replay.providerActivityEvents.length, 80);
  assert.equal(replay.providerActivityEvents[0].sequence, 71);
  assert.equal(replay.providerActivityEvents.at(-1).sequence, 150);
  assert.equal(replay.providerOmittedActivityEventCount, 70);
});

test("remote Assistant result keeps exact content and records preference only after successful terminalization", async () => {
  const participant = { ...chatParticipant("codex-cli"), roleConfigId: ADMIN_ROLE.id, handle: "assistant" };
  const conversation = chatConversation([participant], {
    running: true,
    runId: "remote-run",
    activeRunIds: ["remote-run"],
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        providerOutputMessageId: "pending-remote",
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push({
    id: "pending-remote",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "Partial.",
    createdAt: NOW,
    status: "pending",
    metadata: {
      runId: "remote-run",
      appMessageSource: "remote-run-provider-output",
      activityEvents: [{
        id: "remote-run:activity:1",
        sequence: 1,
        kind: "tool",
        label: "Running command",
        createdAt: NOW
      }]
    }
  });
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  await service.applyRemoteRunReplayRecord({
    id: "remote-run:provider-result",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 1,
    createdAt: NOW,
    kind: "provider_result",
    participantId: participant.id,
    ok: true,
    content: "Authoritative final."
  } as any);
  assert.equal(storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote")?.status, "pending");
  assert.equal(storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote")?.content, "Authoritative final.");
  assert.deepEqual(settingsState.recordedSuccessfulProviders, []);

  await service.applyRemoteRunReplayRecord({
    id: "remote-run:terminal",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 2,
    createdAt: "2026-06-27T22:00:01.000Z",
    kind: "terminal_state",
    status: "completed"
  } as any);

  const messages = storage.current.messages.filter((item: ChatMessage) => item.role === "participant");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, "done");
  assert.equal(messages[0].content, "Authoritative final.");
  assert.equal(messages[0].metadata?.activityEvents, undefined);
  assert.equal(messages[0].metadata?.remoteRunStatus?.label, "Completed");
  assert.deepEqual(storage.current.metadata.activeRunIds, undefined);
  assert.deepEqual(settingsState.recordedSuccessfulProviders, ["codex-cli"]);
  assert.equal(storage.current.metadata.activationProviderKind, "codex-cli");
});

test("remote cancellation suppresses late output, result, and permission side effects", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    running: true,
    runId: "remote-run",
    activeRunIds: ["remote-run"],
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        providerOutputMessageId: "pending-remote",
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push({
    id: "pending-remote",
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    content: "Partial remote content.",
    createdAt: NOW,
    status: "pending",
    metadata: {
      runId: "remote-run",
      appMessageSource: "remote-run-provider-output",
      activityEvents: [{
        id: "remote-run:activity:1",
        sequence: 1,
        kind: "tool",
        label: "Running command",
        createdAt: NOW
      }]
    }
  });
  const { service, storage } = testService({ conversation });

  await service.updateRemoteRunHandleState(conversation.id, "remote-run", {
    runId: "remote-run",
    conversationId: conversation.id,
    participantId: participant.id,
    status: "cancelled",
    completedAt: "2026-06-27T22:00:01.000Z",
    error: "user cancelled"
  });
  await service.applyRemoteRunReplayRecord({
    id: "remote-run:late-result",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 1,
    createdAt: NOW,
    kind: "provider_result",
    participantId: participant.id,
    ok: true,
    content: "Late final must not win."
  } as any);
  await service.applyRemoteRunReplayRecord({
    id: "remote-run:late-output",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 2,
    createdAt: NOW,
    kind: "provider_output",
    participantId: participant.id,
    stream: "stdout",
    content: `${JSON.stringify({ type: "agent_message_delta", delta: "Late text." })}\n`
  } as any);
  await service.applyRemoteRunReplayRecord({
    id: "remote-run:late-permission",
    conversationId: conversation.id,
    runId: "remote-run",
    seq: 3,
    createdAt: NOW,
    kind: "permission_pending",
    participantId: participant.id,
    requestId: "late-permission",
    request: { kind: "portable", permissions: ["webAccess"] },
    runPermissions: defaultChatAgentPermissions()
  } as any);

  const message = storage.current.messages.find((item: ChatMessage) => item.id === "pending-remote");
  assert.equal(message?.status, "error");
  assert.equal(message?.content, "Partial remote content.");
  assert.equal(message?.metadata?.remoteRunStatus?.label, "Cancelled");
  assert.equal(message?.metadata?.activityEvents, undefined);
  assert.equal((storage.current.metadata.remoteRunReplay as any)["remote-run"].cursorSeq, 3);
  assert.deepEqual(storage.current.metadata.pendingAppToolApprovals ?? [], []);
  assert.equal(storage.current.messages.some((item: ChatMessage) => item.content.includes("Late final")), false);
  assert.equal(storage.current.messages.some((item: ChatMessage) => item.content.includes("Permission approval needed")), false);
});

test("cancelRun stops a remote run immediately even when the worker is unreachable", async () => {
  const participant = chatParticipant("codex-cli");
  const now = "2026-06-27T22:00:00.000Z";
  const handle = {
    runId: "remote-run",
    conversationId: "conversation-1",
    participantId: participant.id,
    participantHandle: participant.handle,
    worker: { host: "worker.example" },
    status: "running",
    startedAt: now,
    updatedAt: now
  };
  const conversation = chatConversation([participant], {
    running: true,
    runId: "remote-run",
    activeRunIds: ["remote-run"],
    remoteRunHandles: {
      "remote-run": handle
    }
  });
  const { service, storage } = testService({ conversation });
  let workerCancelAttempts = 0;
  service.setRemoteRunService({
    async startDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    async pollDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    // Simulate an unreachable worker: the SSH cancel never returns. Stop must
    // not wait on it.
    cancelDetachedRun(): Promise<any> {
      workerCancelAttempts += 1;
      return new Promise(() => {});
    },
    registerDetachedRunContext(): void {}
  });
  const stopTrackingCalls: string[] = [];
  service.setRemoteRunCoordinator({
    trackRun(): void {},
    stopTracking(runId: string): void {
      stopTrackingCalls.push(runId);
    }
  });
  (service as any).registerRemoteRunHandle(handle);

  assert.equal(service.cancelRun("remote-run"), true);

  // Terminalized locally without awaiting the hung worker cancel.
  await waitFor(() => {
    const stored = (storage.current.metadata.remoteRunHandles as any)["remote-run"];
    return stored.status === "cancelled" &&
      storage.current.metadata.running === false &&
      storage.current.metadata.activeRunIds === undefined;
  });
  const stored = (storage.current.metadata.remoteRunHandles as any)["remote-run"];
  assert.equal(stored.status, "cancelled");
  assert.equal(storage.current.metadata.activeRunIds, undefined);
  // The coordinator is told to stop polling the now-dead run, and the worker
  // cancel is still attempted best-effort.
  assert.deepEqual(stopTrackingCalls, ["remote-run"]);
  assert.equal(workerCancelAttempts, 1);
});

test("cancelRun cancels persisted remote runs without in-memory handles", async () => {
  const codex = chatParticipant("codex-cli");
  const claude = chatParticipant("claude-code");
  const now = "2026-06-27T22:05:00.000Z";
  const remoteOne = {
    runId: "remote-one",
    conversationId: "conversation-1",
    participantId: codex.id,
    participantHandle: codex.handle,
    worker: { host: "worker-one.example" },
    status: "running",
    startedAt: now,
    updatedAt: now
  };
  const remoteTwo = {
    runId: "remote-two",
    conversationId: "conversation-1",
    participantId: claude.id,
    participantHandle: claude.handle,
    worker: { host: "worker-two.example" },
    status: "running",
    startedAt: now,
    updatedAt: now
  };
  const conversation = chatConversation([codex, claude], {
    running: true,
    runId: "remote-one",
    activeRunIds: ["remote-one", "remote-two"],
    remoteRunHandles: {
      "remote-one": remoteOne,
      "remote-two": remoteTwo
    }
  });
  const { service, storage } = testService({ conversation });
  const cancelledRunIds: string[] = [];
  service.setRemoteRunService({
    async startDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    async pollDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    async cancelDetachedRun(request: any): Promise<any> {
      cancelledRunIds.push(request.runId);
      return {
        runId: request.runId,
        conversationId: conversation.id,
        participantId: request.runId === "remote-one" ? codex.id : claude.id,
        status: "cancelled",
        completedAt: now
      };
    },
    registerDetachedRunContext(): void {}
  });

  assert.equal(service.cancelRun("remote-one"), true);
  assert.equal(service.cancelRun("remote-two"), true);

  await waitFor(() => storage.current.metadata.activeRunIds === undefined && cancelledRunIds.length === 2);
  assert.deepEqual(cancelledRunIds.sort(), ["remote-one", "remote-two"]);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal((storage.current.metadata.remoteRunHandles as any)["remote-one"].status, "cancelled");
  assert.equal((storage.current.metadata.remoteRunHandles as any)["remote-two"].status, "cancelled");
});

test("cancelRun force clears stale local and orphaned active run ids", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    running: true,
    runId: "local-run",
    activeRunIds: ["local-run", "orphan-run"],
    activeRunOwnersByRunId: {
      "local-run": {
        processId: process.pid,
        instanceId: "dead-instance",
        startedAt: NOW,
        updatedAt: NOW
      }
    },
    activeRunParticipantIdsByRunId: {
      "local-run": participant.id,
      "orphan-run": participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-local", "local-run"));
  conversation.messages.push(pendingParticipantMessage(participant, "pending-orphan", "orphan-run"));
  const { service, storage } = testService({ conversation });

  assert.equal(service.cancelRun("local-run"), true);
  assert.equal(service.cancelRun("orphan-run"), true);

  await waitFor(() => storage.current.metadata.activeRunIds === undefined);
  assert.equal(storage.current.metadata.running, false);
  assert.equal(storage.current.metadata.runId, undefined);
  assert.equal(storage.current.metadata.activeRunOwnersByRunId, undefined);
  assert.equal(storage.current.metadata.activeRunParticipantIdsByRunId, undefined);
  for (const messageId of ["pending-local", "pending-orphan"]) {
    const message = storage.current.messages.find((item: ChatMessage) => item.id === messageId);
    assert.equal(message?.status, "error");
    assert.equal(message?.metadata?.terminalReason, "user-stopped");
  }
});

test("chat add paths normalize legacy run location to concrete local or remote", async () => {
  const agents: AgentHealth[] = [{ kind: "codex-cli", label: "Codex CLI", installed: true }];
  const { service, storage, tempRoot } = testService({
    agents,
    settings: { chatRoleConfigs: [ROLE] }
  });

  const created = await service.createConversation({
    title: "Cloud run routing",
    participants: [
      { handle: "legacy", roleConfigId: ROLE.id, kind: "codex-cli" },
      { handle: "inherit", roleConfigId: ROLE.id, kind: "codex-cli", remoteExecution: "inherit" },
      { handle: "remote", roleConfigId: ROLE.id, kind: "codex-cli", remoteExecution: "remote" }
    ]
  });

  const createdParticipants = created.conversation.metadata.participants as ChatParticipant[];
  assert.deepEqual(createdParticipants.map((participant) => participant.remoteExecution), ["local", "local", "remote"]);

  const conversation = chatConversation([chatParticipant("codex-cli")]);
  storage.current = conversation;
  await service.addParticipant({
    conversationId: conversation.id,
    participant: { handle: "added", roleConfigId: ROLE.id, kind: "codex-cli", remoteExecution: "inherit" }
  });

  const added = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "added");
  assert.equal(added?.remoteExecution, "local");
});

test("auto-watch runtime update enforces one watcher and clears scheduler state on disable", async () => {
  const codex = chatParticipant("codex-cli");
  const drew = chatParticipant("claude-code");
  const conversation = chatConversation([codex, drew]);
  const { service, storage } = testService({ conversation });
  const scheduled: Array<{ conversationId: string; reason: string }> = [];
  (service as any).scheduleAutoWatchEvaluation = (conversationId: string, reason: string) => {
    scheduled.push({ conversationId, reason });
  };

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: codex.id,
    autoWatch: true
  });

  let participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.id === codex.id)?.autoWatch, true);
  assert.equal(storage.current.metadata.participantWatchers[codex.id].wakeChainDepth, 0);
  assert.deepEqual(scheduled, [{ conversationId: conversation.id, reason: "toggle-on" }]);

  await assert.rejects(
    () => service.updateParticipantRuntime({
      conversationId: conversation.id,
      participantId: drew.id,
      autoWatch: true
    }),
    /Only one member can watch a chat/
  );

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: codex.id,
    autoWatch: false
  });

  participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.id === codex.id)?.autoWatch, false);
  assert.equal(storage.current.metadata.participantWatchers, undefined);
});

test("Workflow Manager default-on seeding keeps only one active watcher", async () => {
  const workflowRole: ChatRoleConfig = {
    ...ROLE,
    id: "workflow-manager",
    label: "Workflow Manager",
    participantDefaults: {
      autoWatch: true,
      requestParticipants: "allow",
      manageRolesParticipants: "allow"
    }
  };
  const codex = { ...chatParticipant("codex-cli"), autoWatch: true };
  const conversation = chatConversation([codex]);
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE, workflowRole] }
  });
  const scheduled: Array<{ conversationId: string; reason: string }> = [];
  (service as any).scheduleAutoWatchEvaluation = (conversationId: string, reason: string) => {
    scheduled.push({ conversationId, reason });
  };

  await service.addParticipant({
    conversationId: conversation.id,
    participant: { handle: "wm2", roleConfigId: workflowRole.id, kind: "codex-cli" }
  });

  let participants = storage.current.metadata.participants as ChatParticipant[];
  const added = participants.find((participant) => participant.handle === "wm2");
  assert.equal(added?.autoWatch, false);
  assert.equal(added?.permissions?.requestParticipants, "allow");
  assert.equal(added?.permissions?.manageRolesParticipants, undefined);
  assert.deepEqual(scheduled, []);

  participants = participants.map((participant) => ({ ...participant, autoWatch: false }));
  storage.current = chatConversation(participants, { participantWatchers: undefined });
  await service.addParticipant({
    conversationId: conversation.id,
    participant: { handle: "wm3", roleConfigId: workflowRole.id, kind: "codex-cli" }
  });

  participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.handle === "wm3")?.autoWatch, true);
  assert.equal(participants.find((participant) => participant.handle === "wm3")?.permissions?.requestParticipants, "allow");
  assert.equal(participants.find((participant) => participant.handle === "wm3")?.permissions?.manageRolesParticipants, undefined);
  assert.deepEqual(scheduled, [{ conversationId: conversation.id, reason: "participant-added" }]);
});

test("custom role participant defaults apply to new chat participants", async () => {
  const managerRole: ChatRoleConfig = {
    ...ROLE,
    id: "custom-manager",
    label: "Custom Manager",
    participantDefaults: {
      autoWatch: true,
      requestParticipants: "deny",
      requestCompaction: "allow"
    }
  };
  const { service, storage, tempRoot } = testService({
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true }],
    settings: { chatRoleConfigs: [ROLE, managerRole] }
  });

  const created = await service.createConversation({
    title: "Role defaults",
    participants: [
      { handle: "manager", roleConfigId: managerRole.id, kind: "codex-cli" }
    ]
  });

  let participant = (created.conversation.metadata.participants as ChatParticipant[]).find((item) => item.handle === "manager");
  assert.equal(participant?.autoWatch, true);
  assert.equal(participant?.permissions?.requestParticipants, "deny");
  assert.equal(participant?.permissions?.requestCompaction, "allow");

  const conversation = chatConversation([]);
  storage.current = conversation;
  await service.addParticipant({
    conversationId: conversation.id,
    participant: {
      handle: "manager2",
      roleConfigId: managerRole.id,
      kind: "codex-cli",
      autoWatch: false,
      permissions: {
        ...defaultChatAgentPermissions(),
        requestParticipants: "allow",
        requestCompaction: "deny"
      }
    }
  });

  participant = (storage.current.metadata.participants as ChatParticipant[]).find((item) => item.handle === "manager2");
  assert.equal(participant?.autoWatch, false);
  assert.equal(participant?.permissions?.requestParticipants, "allow");
  assert.equal(participant?.permissions?.requestCompaction, "deny");
});

test("auto-watch evaluation dispatches watcher from new participant output", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: Array<{ participant: ParticipantConfig; prompt: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    run: async (participant, prompt) => {
      runs.push({ participant, prompt });
      return {
        participant,
        ok: true,
        content: "Manager evaluated.",
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runAutoWatchEvaluation(conversation.id, "test");
  await waitFor(() => runs.length === 1);

  assert.equal(runs[0].participant.id, manager.id);
  assert.match(runs[0].prompt, /Auto-watch trigger/);
  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.equal(trigger.metadata?.autoWatchTrigger?.participantId, manager.id);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["worker-reply"]);
});

test("auto-watch cursor is not advanced when watcher dispatch fails before run starts", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const { service, storage } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ]
  });
  let dispatchCalled = false;
  (service as any).runParticipantBatch = async () => {
    dispatchCalled = true;
    throw new Error("dispatch failed before begin");
  };

  await (service as any).runAutoWatchEvaluation(conversation.id, "test");
  await waitFor(() => storage.current.metadata.participantWatchers?.[manager.id]?.pausedReason === "error");

  assert.equal(dispatchCalled, true);
  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.lastSeenMessageId, "user-message");
  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.wakeChainDepth, 0);
  assert.ok(storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger));
});

test("auto-watch schedules after background participant output drains", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    running: true,
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  const { service, storage } = testService({ conversation });
  const scheduled: Array<{ conversationId: string; reason: string }> = [];
  (service as any).scheduleAutoWatchEvaluation = (conversationId: string, reason: string) => {
    scheduled.push({ conversationId, reason });
  };

  (service as any).incrementBackgroundRunner(conversation.id);
  await (service as any).appendParticipantTurnMessages(conversation, worker, [
    timelineMessage("worker-delayed", "Delayed reply.", {
      role: "participant",
      participantId: worker.id,
      participantLabel: `@${worker.handle}`,
      metadata: { threadId: "user-message" }
    })
  ]);
  storage.current = clone(conversation);

  assert.deepEqual(scheduled, []);

  (service as any).decrementBackgroundRunner(conversation.id);
  await waitFor(() => scheduled.length === 1);

  assert.deepEqual(scheduled, [{ conversationId: conversation.id, reason: "background-runner-idle" }]);
  assert.equal(storage.current.metadata.running, false);
});

test("auto-watch evaluation can launch a remote watcher from local participant output", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true, remoteExecution: "remote" as const };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  let localRuns = 0;
  let remoteLaunch: { participantId: string; prompt: string; runId: string } | undefined;
  const { service, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    settings: {
      chatRoleConfigs: [ROLE],
      cloudRuns: { enabled: true, worker: { host: "worker.example" } }
    },
    run: async () => {
      localRuns += 1;
      return { ok: true, content: "local fallback", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;
  service.setRemoteRunService({
    async startDetachedRun(request): Promise<any> {
      if (!request.runId) {
        throw new Error("missing remote run id");
      }
      remoteLaunch = {
        participantId: request.participant.id,
        prompt: request.prompt,
        runId: request.runId
      };
      return {
        runId: request.runId,
        conversationId: request.conversationId,
        participantId: request.participant.id,
        status: "running"
      };
    },
    async pollDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    async cancelDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    registerDetachedRunContext(): void {}
  });

  await (service as any).runAutoWatchEvaluation(conversation.id, "test");
  await waitFor(() => remoteLaunch !== undefined);

  assert.equal(remoteLaunch?.participantId, manager.id);
  assert.match(remoteLaunch?.prompt ?? "", /Auto-watch trigger/);
  assert.equal(localRuns, 0);
});

test("directly targeted auto-watch participant does not reprocess the trigger user message", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const conversation = chatConversation([manager]);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true }],
    run: async (participant) => {
      runs.push(participant);
      return {
        participant,
        ok: true,
        content: "Direct response.",
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, content: "@codex please handle this." });
  await waitFor(() => runs.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const userMessage = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("please handle this")
  );
  assert.ok(userMessage);
  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.lastSeenMessageId, userMessage.id);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.autoWatchTrigger), false);
  assert.equal(runs.length, 1);
});

test("auto-watch does not reprocess consumed participant request replies", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Review complete."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply"
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Should not run.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runAutoWatchEvaluation(conversation.id, "run-idle");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.autoWatchTrigger), false);
});

test("auto-watch preserves unrelated messages while filtering consumed participant request replies", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const reviewer = { ...chatParticipant("claude-code"), id: "reviewer-participant", handle: "reviewer" };
  const conversation = chatConversation([manager, target, reviewer], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(reviewer, "reviewer-note", "Separate update."));
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Review complete."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply"
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["reviewer-note"]);
});

test("auto-watch still wakes for later messages after consumed participant request replies", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Review complete."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply"
  }));
  conversation.messages.push(participantReplyMessage(target, "later-reply", "New follow-up."));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["later-reply"]);
});

test("auto-watch does not filter participant request replies consumed by a different requester", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const otherRequester = { ...chatParticipant("codex-cli"), id: "other-requester", handle: "other" };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, otherRequester, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Reply for another requester."));
  conversation.messages.push(participantRequestCarrierMessage(otherRequester, target, {
    replyMessageId: "target-reply"
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["target-reply"]);
});

test("auto-watch does not filter participant request replies before requester auto-resume consumes them", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Review complete."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply",
    autoResumeMessageId: null,
    batchStatus: "answered"
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["target-reply"]);
});

test("auto-watch does not suppress inline completed participant request replies", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(participantReplyMessage(target, "target-reply", "Inline reply."));
  conversation.messages.push(participantRequestCarrierMessage(manager, target, {
    replyMessageId: "target-reply",
    autoResumeMessageId: null,
    resumeRequester: false,
    completedInToolCall: true
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runAutoWatchEvaluation(conversation.id, "run-idle");
  await waitFor(() => runs.length === 1);

  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["target-reply"]);
});

test("auto-watch filters replies completed through permission approval participant request resume", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const target = chatParticipant("claude-code");
  const requestMessage = participantRequestCarrierMessage(manager, target, {
    id: "permission-request",
    batchId: "permission-batch",
    autoResumeMessageId: null,
    batchStatus: "running",
    itemStatus: "running"
  });
  const reply = participantReplyMessage(target, "target-reply", "Permission-unblocked reply.");
  const conversation = chatConversation([manager, target], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(requestMessage, reply);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: installedChatAgents(),
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Should not run.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const resumeMessageId = (service as any).applyPermissionResumeToParticipantRequest(
    conversation,
    requestMessage.id,
    "permission-batch",
    target,
    [reply]
  );
  const updatedRequestMessage = conversation.messages.find((message) => message.id === requestMessage.id);
  const batch = updatedRequestMessage?.metadata?.participantRequest;
  assert.equal(resumeMessageId, requestMessage.id);
  assert.equal(batch?.completedInToolCall, false);
  assert.equal(batch?.items[0]?.replyMessageId, "target-reply");
  if (batch) {
    batch.status = "completed";
    batch.autoResumeMessageId = "manager-resume";
  }
  storage.current = clone(conversation);

  await (service as any).runAutoWatchEvaluation(conversation.id, "run-idle");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.autoWatchTrigger), false);
});

test("auto-watch wake limit pauses and toggle off-on clears pause state", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 1,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE], chatAutoWatchWakeLimit: 1 },
    run: async (participant) => {
      runs.push(participant);
      return {
        participant,
        ok: true,
        content: "Should not run while paused.",
        durationMs: 1
      };
    }
  });

  await (service as any).runAutoWatchEvaluation(conversation.id, "test");

  assert.equal(runs.length, 0);
  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.pausedReason, "wake-limit");

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: manager.id,
    autoWatch: false
  });
  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: manager.id,
    autoWatch: true
  });

  const watcher = storage.current.metadata.participantWatchers?.[manager.id];
  assert.equal(watcher?.pausedReason, undefined);
  assert.equal(watcher?.wakeChainDepth, 0);
});

test("auto-watch eligible scan excludes self, system, pending, and hidden messages", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  // All pushed after the cursor. Only the final worker reply is eligible;
  // the manager's own output, a system message, a pending (streaming) message,
  // and a hidden message must be excluded from the scan.
  conversation.messages.push(timelineMessage("manager-self", "Manager's own note.", {
    role: "participant",
    participantId: manager.id,
    participantLabel: `@${manager.handle}`,
    metadata: { threadId: "user-message" }
  }));
  conversation.messages.push(timelineMessage("system-note", "System notice.", {
    role: "system",
    metadata: { threadId: "user-message" }
  }));
  conversation.messages.push(timelineMessage("pending-reply", "Still streaming.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    status: "pending",
    metadata: { threadId: "user-message" }
  }));
  conversation.messages.push(timelineMessage("hidden-note", "Hidden housekeeping.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message", hiddenFromTimeline: true }
  }));
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: Array<{ participant: ParticipantConfig; prompt: string }> = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    run: async (participant, prompt) => {
      runs.push({ participant, prompt });
      return { participant, ok: true, content: "Manager evaluated.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await (service as any).runAutoWatchEvaluation(conversation.id, "test");
  await waitFor(() => runs.length === 1);

  assert.equal(runs[0].participant.id, manager.id);
  const trigger = storage.current.messages.find((message: ChatMessage) => message.metadata?.autoWatchTrigger);
  assert.ok(trigger);
  // Only the eligible worker reply is carried into the trigger; the excluded
  // messages would appear here if the scan let them through.
  assert.deepEqual(trigger.metadata?.autoWatchTrigger?.messageIds, ["worker-reply"]);
});

test("auto-watch depth resets when the user sends a new message", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const conversation = chatConversation([manager], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 4,
        updatedAt: NOW
      }
    }
  });
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [{ kind: "codex-cli", label: "Codex CLI", installed: true }],
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Handled.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;
  // Keep the assertion about depth-reset only: suppress the follow-on evaluation
  // so it cannot re-increment the counter we are checking.
  (service as any).scheduleAutoWatchEvaluation = () => {};

  await service.sendMessage({ conversationId: conversation.id, content: "@codex next step." });
  await waitFor(() => runs.length === 1);

  assert.equal(storage.current.metadata.participantWatchers?.[manager.id]?.wakeChainDepth, 0);
});

test("auto-watch does not wake a watcher after it is toggled off", async () => {
  const manager = { ...chatParticipant("codex-cli"), autoWatch: true };
  const worker = chatParticipant("claude-code");
  const conversation = chatConversation([manager, worker], {
    participantWatchers: {
      [manager.id]: {
        lastSeenMessageId: "user-message",
        wakeChainDepth: 0,
        updatedAt: NOW
      }
    }
  });
  conversation.messages.push(timelineMessage("worker-reply", "Worker is done.", {
    role: "participant",
    participantId: worker.id,
    participantLabel: `@${worker.handle}`,
    metadata: { threadId: "user-message" }
  }));
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex CLI", installed: true },
      { kind: "claude-code", label: "Claude Code", installed: true }
    ],
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "Should not run.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.updateParticipantRuntime({
    conversationId: conversation.id,
    participantId: manager.id,
    autoWatch: false
  });
  assert.equal(storage.current.metadata.participantWatchers, undefined);

  await (service as any).runAutoWatchEvaluation(conversation.id, "test");
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(runs.length, 0);
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.autoWatchTrigger), false);
});

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
  (service as any).ensureHistoryFiles = async () => tempRoot;

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

test("run location is editable only before a participant has durable run history", async () => {
  const participant = { ...chatParticipant("codex-cli"), remoteExecution: "local" as const };
  const freshConversation = chatConversation([participant]);
  const { service, storage } = testService({ conversation: freshConversation });

  await service.updateParticipantRuntime({
    conversationId: freshConversation.id,
    participantId: participant.id,
    remoteExecution: "remote"
  });

  assert.equal((storage.current.metadata.participants as ChatParticipant[])[0].remoteExecution, "remote");

  const usedConversation = chatConversation([{ ...participant, remoteExecution: "local" }], {
    participantSessions: [{
      participantId: participant.id,
      sessionId: "",
      roleConfigId: ROLE.id,
      roleConfigVersion: 1,
      roleLabel: ROLE.label,
      roleInstructions: ROLE.instructions,
      updatedAt: NOW
    }]
  });
  storage.current = usedConversation;

  await assert.rejects(
    () => service.updateParticipantRuntime({
      conversationId: usedConversation.id,
      participantId: participant.id,
      remoteExecution: "remote"
    }),
    /Run location is locked/
  );
});

test("explicit remote fails closed for cheap precondition failures", async () => {
  type TestSettings = {
    chatRoleConfigs: ChatRoleConfig[];
    chatBehaviorRules?: ChatBehaviorRuleConfig[];
    chatParticipantConfigs?: ChatParticipantConfig[];
    cloudRuns?: Partial<AppSettings["cloudRuns"]>;
  };
  const cases: Array<{
    name: string;
    participant: ChatParticipant;
    settings?: TestSettings;
    message: RegExp;
  }> = [
    {
      name: "disabled",
      participant: { ...chatParticipant("codex-cli"), remoteExecution: "remote" },
      settings: { chatRoleConfigs: [ROLE], cloudRuns: { enabled: false, worker: { host: "worker.example" } } },
      message: /Cloud Runs is disabled/
    },
    {
      name: "non-codex",
      participant: { ...chatParticipant("claude-code"), remoteExecution: "remote" },
      settings: { chatRoleConfigs: [ROLE], cloudRuns: { enabled: true, worker: { host: "worker.example" } } },
      message: /supports Codex members only/
    },
    {
      name: "no-host",
      participant: { ...chatParticipant("codex-cli"), remoteExecution: "remote" },
      settings: { chatRoleConfigs: [ROLE], cloudRuns: { enabled: true, worker: {} } },
      message: /worker host is not configured/
    },
    {
      name: "no-service",
      participant: { ...chatParticipant("codex-cli"), remoteExecution: "remote" },
      settings: { chatRoleConfigs: [ROLE], cloudRuns: { enabled: true, worker: { host: "worker.example" } } },
      message: /not available in this app session/
    }
  ];

  for (const item of cases) {
    let localRuns = 0;
    const conversation = chatConversation([item.participant]);
    const { service, storage, tempRoot } = testService({
      conversation,
      settings: item.settings,
      run: async () => {
        localRuns += 1;
        return { ok: true, content: "local", durationMs: 1 };
      }
    });
    (service as any).ensureHistoryFiles = async () => tempRoot;

    await service.sendMessage({ conversationId: conversation.id, content: `@${item.participant.handle} run remote`, runId: `run-${item.name}` });

    await waitFor(() => (storage.current.messages as ChatMessage[]).some((message) =>
      message.role === "participant" &&
      message.participantId === item.participant.id &&
      message.status === "error"
    ));
    const participantMessage = (storage.current.messages as ChatMessage[]).find((message) =>
      message.role === "participant" &&
      message.participantId === item.participant.id
    );
    assert.match(participantMessage?.content ?? "", item.message);
    assert.equal(localRuns, 0);
    assert.equal((storage.current.metadata.warnings ?? []).some((warning: string) => warning.includes("ran locally instead")), false);
  }
});

test("explicit remote launch rejection fails the participant bubble instead of falling back local", async () => {
  const participant = { ...chatParticipant("codex-cli"), remoteExecution: "remote" as const };
  const conversation = chatConversation([participant]);
  let localRuns = 0;
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE], cloudRuns: { enabled: true, worker: { host: "worker.example" } } },
    run: async () => {
      localRuns += 1;
      return { ok: true, content: "local", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;
  service.setRemoteRunService({
    async startDetachedRun(): Promise<any> {
      throw new Error("ssh connect failed");
    },
    async pollDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    async cancelDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    registerDetachedRunContext(): void {}
  });

  await service.sendMessage({ conversationId: conversation.id, content: "@codex run remote", runId: "remote-launch-fails" });

  await waitFor(() => (storage.current.messages as ChatMessage[]).some((message) =>
    message.role === "participant" &&
    message.participantId === participant.id &&
    message.status === "error"
  ));
  const participantMessage = (storage.current.messages as ChatMessage[]).find((message) =>
    message.role === "participant" &&
    message.participantId === participant.id
  );
  assert.match(participantMessage?.content ?? "", /remote run failed to start: ssh connect failed/);
  assert.equal(localRuns, 0);
});

test("remote chat launch passes user-reachable toolchain preflight skip flag", async () => {
  const participant = {
    ...chatParticipant("codex-cli"),
    remoteExecution: "remote" as const,
    skipToolchainPreflight: true
  };
  const conversation = chatConversation([participant]);
  let observedPreflight: any;
  let launchedRunId = "";
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE], cloudRuns: { enabled: true, worker: { host: "worker.example" } } }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;
  service.setRemoteRunService({
    async startDetachedRun(request): Promise<any> {
      if (!request.runId) {
        throw new Error("missing remote run id");
      }
      observedPreflight = request.toolchainPreflight;
      launchedRunId = request.runId;
      return {
        runId: request.runId,
        conversationId: request.conversationId,
        participantId: request.participant.id,
        status: "running"
      };
    },
    async pollDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    async cancelDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    registerDetachedRunContext(): void {}
  });

  await service.sendMessage({ conversationId: conversation.id, content: "@codex run remote", runId: "remote-skip-preflight" });

  await waitFor(() => observedPreflight?.skip === true);
  assert.equal(observedPreflight.skip, true);
  assert.equal((storage.current.metadata.remoteRunHandles as any)[launchedRunId]?.status, "running");
});

test("remote launch failure surfaces non-Java toolchain remediation", async () => {
  const participant = { ...chatParticipant("codex-cli"), remoteExecution: "remote" as const };
  const conversation = chatConversation([participant]);
  const goRequirement: ToolchainRequirement = {
    tool: "go",
    label: "Go",
    command: "go",
    severity: "required",
    sources: ["go.mod"],
    remediation: {
      kind: "worker_setup",
      message: "Install Go on the worker.",
      command: "sudo apt-get install -y golang-go"
    }
  };
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE], cloudRuns: { enabled: true, worker: { host: "worker.example" } } }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;
  service.setRemoteRunService({
    async startDetachedRun(): Promise<any> {
      throw new RemoteRunPreflightError([issueFromRequirement(goRequirement, "missing")]);
    },
    async pollDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    async cancelDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    registerDetachedRunContext(): void {}
  });

  await service.sendMessage({ conversationId: conversation.id, content: "@codex run remote", runId: "remote-go-preflight" });

  await waitFor(() => (storage.current.messages as ChatMessage[]).some((message) =>
    message.role === "participant" &&
    message.participantId === participant.id &&
    message.status === "error"
  ));
  const participantMessage = (storage.current.messages as ChatMessage[]).find((message) =>
    message.role === "participant" &&
    message.participantId === participant.id
  );
  assert.match(participantMessage?.content ?? "", /Go/);
  assert.match(participantMessage?.content ?? "", /Install Go on the worker/);
});

test("remote fail-closed is participant-scoped in mixed dispatch", async () => {
  const remote = { ...chatParticipant("codex-cli"), remoteExecution: "remote" as const };
  const local = { ...chatParticipant("claude-code"), remoteExecution: "local" as const };
  const conversation = chatConversation([remote, local]);
  let localRuns = 0;
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: { chatRoleConfigs: [ROLE], cloudRuns: { enabled: true, worker: { host: "worker.example" } } },
    run: async () => {
      localRuns += 1;
      return { ok: true, content: "local ok", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, content: "@codex @drew both answer", runId: "mixed-dispatch" });

  await waitFor(() => {
    const participantMessages = (storage.current.messages as ChatMessage[]).filter((message) => message.role === "participant");
    return participantMessages.some((message) => message.participantId === remote.id && message.status === "error") &&
      participantMessages.some((message) => message.participantId === local.id && message.status === "done");
  });

  assert.equal(localRuns, 1);
  const remoteMessage = (storage.current.messages as ChatMessage[]).find((message) =>
    message.role === "participant" &&
    message.participantId === remote.id
  );
  assert.match(remoteMessage?.content ?? "", /not available in this app session/);
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

test("verbose affirmative confirmations are delivered without retry or warning", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const verbose = [
    "Yes, I agree.",
    "",
    "- The plan is sound because it removes the retry gate.",
    "- The remaining concise-response guidance is independent."
  ].join("\n");
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runs.push(runParticipant);
      return {
        participant: runParticipant,
        ok: true,
        content: runs.length === 1 ? verbose : "Confirmed.",
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  const result = await service.sendMessage({
    conversationId: conversation.id,
    runId: "verbose-confirmation-run",
    content: "@codex Do you agree?"
  });
  await waitFor(() => storage.current.messages.some(
    (message: Conversation["messages"][number]) => message.role === "participant" && message.status === "done"
  ));

  assert.equal(runs.length, 1);
  assert.equal(result.warnings.some((warning) => /verbose affirmative|confirmation-brevity/i.test(warning)), false);
  const participantMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) => message.role === "participant"
  );
  assert.equal(participantMessage?.content, verbose);
  assert.equal(participantMessage?.status, "done");
  const storedWarnings = (storage.current.metadata.warnings ?? []) as string[];
  assert.equal(storedWarnings.some((warning) => /verbose affirmative|confirmation-brevity/i.test(warning)), false);
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

test("Claude prompt includes one-shot execution model on first and resumed turns only", () => {
  const { service } = testService();
  const permissions = normalizeChatAgentPermissions(defaultChatAgentPermissions());
  const promptFor = (kind: ChatProviderKind, includeRoleInstructions: boolean): string => {
    const participant = chatParticipant(kind);
    const conversation = chatConversation([participant]);
    const session: ChatParticipantSession = {
      participantId: participant.id,
      sessionId: includeRoleInstructions ? "" : "provider-session",
      roleConfigId: ROLE.id,
      roleConfigVersion: ROLE.version,
      roleLabel: ROLE.label,
      roleInstructions: ROLE.instructions,
      roleAppToolCapabilities: ROLE.appToolCapabilities,
      participantKind: kind,
      participantAgentMode: "default",
      participantPermissions: permissions,
      updatedAt: NOW
    };

    return (service as any).buildPromptParts(
      conversation,
      participant,
      session,
      conversation.messages[0],
      "/tmp/accordagents-history",
      false,
      {
        includeRoleInstructions,
        agentMode: "default",
        permissions
      }
    ).prompt as string;
  };

  const firstTurn = promptFor("claude-code", true);
  const resumedTurn = promptFor("claude-code", false);
  const codexTurn = promptFor("codex-cli", false);

  for (const prompt of [firstTurn, resumedTurn]) {
    assert.match(prompt, /Claude Code execution model in AccordAgents Chat/);
    assert.match(prompt, /This chat turn is one-shot/);
    assert.match(prompt, /Backgrounded Claude work is terminated at turn end/);
    assert.match(prompt, /Never end a turn by saying you are standing by, waiting, will wait, or will post/);
  }
  assert.doesNotMatch(codexTurn, /Claude Code execution model in AccordAgents Chat/);
  assert.doesNotMatch(codexTurn, /Backgrounded Claude work is terminated at turn end/);
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
    /Set up and sign in to at least one CLI provider/
  );
});

test("chat creation initializes the persisted default from the sole ready provider", async () => {
  const { service } = testService({
    agents: [{ kind: "gemini-cli", label: "Antigravity", installed: true }],
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const result = await service.createConversation({
    title: "Fresh chat",
    participants: [],
    skipDefaultParticipants: true
  });
  const assistant = (result.conversation.metadata.participants as ChatParticipant[])
    .find((participant) => participant.roleConfigId === ADMIN_ROLE.id);
  assert.equal(assistant?.kind, "gemini-cli");
});

test("chat creation uses the saved Assistant provider when multiple CLIs are ready", async () => {
  const agents: AgentHealth[] = [
    { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
    { kind: "claude-code", label: "Claude Code", installed: true, detection: "detected", runnable: "ready", authentication: "ready" }
  ];
  const { service } = testService({
    agents,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], assistantProviderKind: "codex-cli" }
  });

  const result = await service.createConversation({
    title: "Fresh chat",
    participants: [],
    skipDefaultParticipants: true
  });
  const assistant = (result.conversation.metadata.participants as ChatParticipant[])
    .find((participant) => participant.roleConfigId === ADMIN_ROLE.id);
  assert.equal(assistant?.kind, "codex-cli");
});

test("chat creation allows an unready provider only for remote participants", async () => {
  const agents: AgentHealth[] = [
    { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
    { kind: "claude-code", label: "Claude Code", installed: false, detection: "not-detected", runnable: "unknown", authentication: "unknown" }
  ];
  const remote = { ...chatParticipant("claude-code"), remoteExecution: "remote" as const };
  const { service } = testService({
    agents,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const created = await service.createConversation({
    title: "Remote member",
    participants: [remote]
  });
  const participants = created.conversation.metadata.participants as ChatParticipant[];
  assert.equal(participants.some((participant) => participant.handle === remote.handle && participant.remoteExecution === "remote"), true);

  await assert.rejects(
    () => service.createConversation({
      title: "Local member",
      participants: [{ ...remote, remoteExecution: "local" }]
    }),
    /Claude Code was not detected/
  );
});

test("existing chat submit attempts an unready local target and lets the provider run decide", async () => {
  const assistant = {
    ...chatParticipant("claude-code"),
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const runs: ParticipantConfig[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    agents: [
      { kind: "codex-cli", label: "Codex", installed: true, detection: "detected", runnable: "ready", authentication: "ready" },
      { kind: "claude-code", label: "Claude Code", installed: false, detection: "not-detected", runnable: "unknown", authentication: "unknown" }
    ],
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] },
    run: async (participant) => {
      runs.push(participant);
      return { participant, ok: true, content: "The actual provider run succeeded.", durationMs: 1 };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "unready-submit",
    content: "@assistant try the provider despite stale readiness."
  });
  await waitFor(() => runs.length === 1);

  assert.equal(runs[0].id, assistant.id);
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content.includes("despite stale readiness")));
  assert.ok(storage.current.messages.some((message: ChatMessage) => message.content === "The actual provider run succeeded."));
});

test("existing chat submit still rejects an explicitly disabled local provider", async () => {
  const assistant = {
    ...chatParticipant("claude-code"),
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const initialMessageCount = conversation.messages.length;
  const { service, storage } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ADMIN_ROLE, ROLE],
      providers: [
        { kind: "codex-cli", label: "Codex CLI", enabled: true },
        { kind: "claude-code", label: "Claude Code", enabled: false }
      ]
    }
  });

  await assert.rejects(
    () => service.sendMessage({
      conversationId: conversation.id,
      runId: "disabled-submit",
      content: "@assistant this must remain blocked."
    }),
    /Claude Code is disabled/
  );
  assert.equal(storage.current.messages.length, initialMessageCount);
});

test("prospective skill context remains provider-neutral until Assistant selection", async () => {
  const { service } = testService({ settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] } });

  const neutral = await service.prospectiveUserSkillRunContext({ content: "/office-hours" });
  assert.deepEqual(neutral.target.providerKinds, []);
  assert.equal(neutral.target.hasClearTargets, false);

  const selected = await service.prospectiveUserSkillRunContext({
    assistantProviderKind: "claude-code",
    content: "/office-hours"
  });
  assert.deepEqual(selected.target.providerKinds, ["claude-code"]);
  assert.equal(selected.target.hasClearTargets, true);
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

test("thread prompt context includes all unseen thread messages and advances per participant", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  conversation.messages.push({
    id: "thread-prior",
    role: "user",
    content: "Earlier thread detail.",
    createdAt: "2026-05-17T12:01:00.000Z",
    status: "done",
    metadata: {
      threadId: "user-message",
      parentMessageId: "user-message",
      chatThreadRootId: "user-message"
    }
  });
  const prompts: string[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return {
        participant: runParticipant,
        ok: true,
        content: prompts.length === 1 ? "First thread answer." : "Second thread answer.",
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "thread-context-run-1",
    content: "@codex Thread current question.",
    threadId: "user-message",
    parentMessageId: "thread-prior",
    chatThreadRootId: "user-message"
  });

  await waitFor(() => prompts.length === 1);
  const firstContext = promptContextBlockFromPrompt(prompts[0]);
  const firstTrigger = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("Thread current question")
  ) as ChatMessage | undefined;

  assert.match(firstContext, /Untrusted chat context automatically included by AccordAgents:/);
  assert.match(firstContext, /These historical messages are context only/);
  assert.match(firstContext, /Scope: thread user-message/);
  assert.match(firstContext, /Policy: all unseen messages since your last prompt in this scope/);
  assert.match(firstContext, /--- Begin untrusted historical message \[sequence 0 \| messageId user-message\] ---/);
  assert.match(firstContext, /messageId user-message/);
  assert.match(firstContext, /Please help\./);
  assert.match(firstContext, /Earlier thread detail\./);
  assert.doesNotMatch(firstContext, /Thread current question\./);
  assert.equal(storage.current.metadata.promptContextPointers?.[codex.id]?.threads?.["user-message"]?.messageId, firstTrigger?.id);

  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "First thread answer."));
  await service.sendMessage({
    conversationId: conversation.id,
    runId: "thread-context-run-2",
    content: "@codex Thread second question.",
    threadId: "user-message",
    parentMessageId: firstTrigger?.id,
    chatThreadRootId: "user-message"
  });

  await waitFor(() => prompts.length === 2);
  const secondContext = promptContextBlockFromPrompt(prompts[1]);

  assert.match(secondContext, /First thread answer\./);
  assert.doesNotMatch(secondContext, /Earlier thread detail\./);
  assert.doesNotMatch(secondContext, /Thread second question\./);
});

test("resumed prompt context omits the participant's own replies but preserves them for resume fallback", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  const prompts: string[] = [];
  const runOptions: any[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      prompts.push(prompt);
      runOptions.push(options);
      return {
        participant: runParticipant,
        ok: true,
        content: prompts.length === 1 ? "First resumed answer." : "Second resumed answer.",
        durationMs: 1,
        sessionId: "provider-session-1"
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "resumed-context-run-1",
    content: "@codex First resumed question."
  });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "First resumed answer."));

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "resumed-context-run-2",
    content: "@codex Second resumed question."
  });
  await waitFor(() => prompts.length === 2);

  const resumedContext = promptContextBlockFromPrompt(prompts[1]);
  const fallbackContext = promptContextBlockFromPrompt(runOptions[1]?.resumeFallbackPrompt ?? "");
  assert.doesNotMatch(resumedContext, /First resumed answer\./);
  assert.match(fallbackContext, /First resumed answer\./);
});

test("timeline prompt context defaults to latest three unseen messages", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  conversation.messages.push(
    timelineMessage("timeline-1", "Timeline one."),
    timelineMessage("timeline-2", "Timeline two."),
    timelineMessage("timeline-3", "Timeline three."),
    timelineMessage("timeline-4", "Timeline four."),
    timelineMessage("timeline-5", "Top-level participant with thread id.", {
      role: "participant",
      participantId: codex.id,
      participantLabel: "@codex",
      metadata: { threadId: "top-level-thread", parentMessageId: "timeline-4" }
    })
  );
  const prompts: string[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return {
        participant: runParticipant,
        ok: true,
        content: "Timeline answer.",
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "timeline-context-run",
    content: "@codex Timeline current question."
  });

  await waitFor(() => prompts.length === 1);
  const context = promptContextBlockFromPrompt(prompts[0]);
  const trigger = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("Timeline current question")
  ) as ChatMessage | undefined;

  assert.match(context, /Scope: main timeline/);
  assert.match(context, /Policy: latest 3 unseen messages since your last prompt in this scope/);
  assert.match(context, /Omitted 3 older unseen messages because timeline context is capped at 3/);
  assert.doesNotMatch(context, /Please help\./);
  assert.doesNotMatch(context, /Timeline one\./);
  assert.doesNotMatch(context, /Timeline two\./);
  assert.match(context, /Timeline three\./);
  assert.match(context, /Timeline four\./);
  assert.match(context, /Top-level participant with thread id\./);
  assert.doesNotMatch(context, /Timeline current question\./);
  assert.equal(storage.current.metadata.promptContextPointers?.[codex.id]?.timeline?.messageId, trigger?.id);
});

test("off and zero prompt context keep trigger-only prompt shape while advancing pointers", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  conversation.messages.push(timelineMessage("timeline-old", "Old timeline context."));
  const prompts: string[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ROLE],
      chatPromptContext: {
        thread: { mode: "off" },
        timeline: { mode: "latest_unseen", limit: 0 }
      }
    },
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return {
        participant: runParticipant,
        ok: true,
        content: "Zero context answer.",
        durationMs: 1
      };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "zero-context-run",
    content: "@codex Zero context question."
  });

  await waitFor(() => prompts.length === 1);
  const trigger = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("Zero context question")
  ) as ChatMessage | undefined;

  assert.equal(promptContextBlockFromPrompt(prompts[0]), "");
  assert.match(prompts[0], /Triggering message:/);
  assert.match(prompts[0], /Zero context question\./);
  assert.doesNotMatch(prompts[0], /Old timeline context\./);
  assert.equal(storage.current.metadata.promptContextPointers?.[codex.id]?.timeline?.messageId, trigger?.id);
});

test("failed prompt context run does not advance pointers and retries carryover", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  conversation.messages.push(timelineMessage("timeline-old", "Old timeline context."));
  const prompts: string[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return prompts.length === 1
        ? {
            participant: runParticipant,
            ok: false,
            content: "Provider failed.",
            durationMs: 1,
            error: "provider failed"
          }
        : {
            participant: runParticipant,
            ok: true,
            content: "Retry answer.",
            durationMs: 1
          };
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "failed-context-run",
    content: "@codex First question."
  });

  await waitFor(() => prompts.length === 1 && storage.current.messages.some((message: ChatMessage) =>
    message.role === "participant" && message.participantId === codex.id && message.status === "error"
  ));
  assert.equal(storage.current.metadata.promptContextPointers?.[codex.id]?.timeline, undefined);

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "retry-context-run",
    content: "@codex Retry question."
  });

  await waitFor(() => prompts.length === 2 && storage.current.metadata.promptContextPointers?.[codex.id]?.timeline);
  const retryContext = promptContextBlockFromPrompt(prompts[1]);
  const retryTrigger = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("Retry question")
  ) as ChatMessage | undefined;

  assert.match(retryContext, /Old timeline context\./);
  assert.match(retryContext, /First question\./);
  assert.doesNotMatch(retryContext, /Retry question\./);
  assert.equal(storage.current.metadata.promptContextPointers?.[codex.id]?.timeline?.messageId, retryTrigger?.id);
});

test("remote prompt context advances only after successful provider result replay", async () => {
  const codex = { ...chatParticipant("codex-cli"), remoteExecution: "remote" as const };
  const conversation = chatConversation([codex]);
  conversation.messages.push(timelineMessage("remote-old", "Remote old context."));
  let launchedPrompt = "";
  let launchedRunId = "";
  const { service, storage, tempRoot } = testService({
    conversation,
    settings: {
      chatRoleConfigs: [ROLE],
      cloudRuns: { enabled: true, worker: { host: "worker.example" } }
    }
  });
  (service as any).ensureHistoryFiles = async () => tempRoot;
  service.setRemoteRunService({
    async startDetachedRun(request): Promise<any> {
      if (!request.runId) {
        throw new Error("missing remote run id");
      }
      launchedPrompt = request.prompt;
      launchedRunId = request.runId;
      return {
        runId: request.runId,
        conversationId: request.conversationId,
        participantId: request.participant.id,
        status: "running"
      };
    },
    async pollDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    async cancelDetachedRun(): Promise<any> {
      throw new Error("not used");
    },
    registerDetachedRunContext(): void {}
  });

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "remote-context-run",
    content: "@codex Remote question."
  });

  await waitFor(() => Object.keys((storage.current.metadata.remoteRunHandles as any) ?? {}).length > 0);
  assert.match(promptContextBlockFromPrompt(launchedPrompt), /Remote old context\./);
  assert.equal(storage.current.metadata.promptContextPointers?.[codex.id]?.timeline, undefined);
  assert.ok((storage.current.metadata.remoteRunHandles as any)[launchedRunId].promptContextPointerAdvance);

  await service.applyRemoteRunReplayRecord({
    id: "remote-context-result",
    conversationId: conversation.id,
    runId: launchedRunId,
    seq: 1,
    createdAt: "2026-05-17T12:03:00.000Z",
    kind: "provider_result",
    participantId: codex.id,
    ok: true,
    content: "Remote answer.",
    sourceMessageId: storage.current.messages.find((message: ChatMessage) =>
      message.role === "user" && message.content.includes("Remote question")
    )?.id
  });
  await service.applyRemoteRunReplayRecord({
    id: "remote-context-terminal",
    conversationId: conversation.id,
    runId: launchedRunId,
    seq: 2,
    createdAt: "2026-05-17T12:03:01.000Z",
    kind: "terminal_state",
    status: "completed"
  });

  const remoteTrigger = storage.current.messages.find((message: ChatMessage) =>
    message.role === "user" && message.content.includes("Remote question")
  ) as ChatMessage | undefined;
  assert.equal(storage.current.metadata.promptContextPointers?.[codex.id]?.timeline?.messageId, remoteTrigger?.id);
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
      /last chat member/
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

test("participant app tool honors autoWatch for new participants and saved presets", async () => {
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
    reason: "Add a watcher and save the preset.",
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: true,
      participant: {
        handle: "watcher",
        roleConfigId: ROLE.id,
        kind: "codex-cli",
        autoWatch: true
      }
    }]
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId as string,
    approve: true
  });

  const added = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "watcher");
  assert.equal(added?.autoWatch, true);
  assert.equal(settingsState.chatParticipantConfigs[0]?.autoWatchEnabled, true);
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "approved");
});

test("existing participant overrides preserve preset auto-watch and execution defaults", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const savedPermissions = normalizeChatAgentPermissions({
    ...defaultChatAgentPermissions(),
    requestParticipants: "allow"
  });
  const savedParticipant: ChatParticipantConfig = {
    id: "saved-manager",
    handle: "saved-manager",
    roleConfigId: ROLE.id,
    behaviorRuleIds: [],
    kind: "codex-cli",
    model: "gpt-old",
    permissions: savedPermissions,
    remoteExecution: "remote",
    autoWatchEnabled: true,
    updatedAt: NOW
  };
  const conversation = chatConversation([assistant]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [savedParticipant] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const requested = await service.requestParticipantChangeFromTool(actor, {
    reason: "Add saved participant with model override only.",
    operations: [{
      type: "add_existing_participant_to_chat",
      participantConfigId: savedParticipant.id,
      overrides: {
        model: "gpt-new"
      }
    }]
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId as string,
    approve: true
  });

  const added = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "saved-manager");
  assert.equal(added?.model, "gpt-new");
  assert.equal(added?.autoWatch, true);
  assert.equal(added?.remoteExecution, "remote");
  assert.equal(added?.permissions?.requestParticipants, "allow");
});

test("adding saved auto-watch participant through app tool keeps the existing watcher", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const currentWatcher = {
    ...chatParticipant("claude-code"),
    id: "current-watcher",
    handle: "watcher",
    autoWatch: true
  };
  const savedParticipant: ChatParticipantConfig = {
    id: "saved-manager",
    handle: "saved-manager",
    roleConfigId: ROLE.id,
    behaviorRuleIds: [],
    kind: "codex-cli",
    autoWatchEnabled: true,
    updatedAt: NOW
  };
  const conversation = chatConversation([assistant, currentWatcher]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE], chatParticipantConfigs: [savedParticipant] }
  });
  const actor = participantManagerActor(conversation.id, assistant);

  const requested = await service.requestParticipantChangeFromTool(actor, {
    operations: [{
      type: "add_existing_participant_to_chat",
      participantConfigId: savedParticipant.id
    }]
  });

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId as string,
    approve: true
  });

  const participants = storage.current.metadata.participants as ChatParticipant[];
  assert.equal(participants.find((participant) => participant.id === currentWatcher.id)?.autoWatch, true);
  assert.equal(participants.find((participant) => participant.handle === "saved-manager")?.autoWatch, false);
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

test("role app tool approval preserves participant defaults for review and persistence", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const conversation = chatConversation([assistant]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const requested = await service.requestRoleChangeFromTool(participantManagerActor(conversation.id, assistant), {
    operations: [{
      type: "create_role",
      role: {
        label: "Workflow-like Manager",
        instructions: "Coordinate work.",
        participantDefaults: {
          autoWatch: true,
          requestParticipants: "allow",
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { approvalId: string };

  const pending = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  assert.equal((pending.request as any).operations[0].role.participantDefaults.autoWatch, true);
  assert.equal((pending.request as any).operations[0].role.participantDefaults.requestParticipants, "allow");
  assert.equal((pending.request as any).operations[0].role.participantDefaults.manageRolesParticipants, "allow");

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: requested.approvalId,
    approve: true
  });

  const role = settingsState.chatRoleConfigs.find((item) => item.label === "Workflow-like Manager");
  assert.equal(role?.participantDefaults?.autoWatch, true);
  assert.equal(role?.participantDefaults?.requestParticipants, "allow");
  assert.equal(role?.participantDefaults?.manageRolesParticipants, "allow");
});

test("existing Chat Assistant without persisted management permission still requests approval", async () => {
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id,
    permissions: normalizeChatAgentPermissions({
      repoRead: false,
      workspaceWrite: false,
      webAccess: false,
      requestParticipants: "ask",
      shell: {
        enabled: false,
        rules: []
      }
    })
  };
  assert.equal((assistant.permissions as unknown as Record<string, unknown>).manageRolesParticipants, undefined);
  const conversation = chatConversation([assistant]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, ROLE] }
  });

  const result = await service.requestRoleChangeFromTool(participantManagerActor(conversation.id, assistant), {
    operations: [{
      type: "create_role",
      role: {
        label: "Planning Reviewer",
        instructions: "Review plans."
      }
    }]
  }) as { status: string };

  assert.equal(result.status, "pending_user_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
});

test("role management deny rejects stale participant management tokens", async () => {
  const deniedRole: ChatRoleConfig = {
    ...ROLE,
    id: "denied-manager",
    label: "Denied Manager",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "denied-participant",
    handle: "denied",
    roleConfigId: deniedRole.id
  };
  const conversation = chatConversation([manager]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [deniedRole, ROLE] }
  });

  await assert.rejects(
    () => service.requestRoleChangeFromTool(participantManagerActor(conversation.id, manager), {
      operations: [{
        type: "create_role",
        role: {
          label: "Should Not Apply",
          instructions: "No access."
        }
      }]
    }),
    /not allowed to manage roles or participants/
  );
});

test("participant explicit management deny downscopes an allow role", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "downscoped-participant",
    handle: "downscoped",
    roleConfigId: allowingRole.id,
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      manageRolesParticipants: "deny"
    })
  };
  const conversation = chatConversation([manager]);
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, ROLE] }
  });

  await assert.rejects(
    () => service.requestParticipantChangeFromTool(participantManagerActor(conversation.id, manager), {
      operations: [{
        type: "add_new_participant_to_chat",
        participant: {
          handle: "helper",
          roleConfigId: ROLE.id,
          kind: "codex-cli"
        }
      }]
    }),
    /not allowed to manage roles or participants/
  );
});

test("custom role management ask creates approval cards", async () => {
  const askingRole: ChatRoleConfig = {
    ...ROLE,
    id: "asking-manager",
    label: "Asking Manager",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: "ask"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "asking-participant",
    handle: "asking",
    roleConfigId: askingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [askingRole, ROLE], chatParticipantConfigs: [] }
  });

  const result = await service.requestParticipantChangeFromTool(participantManagerActor(conversation.id, manager), {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "helper",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    }]
  }) as { status: string };

  assert.equal(result.status, "pending_user_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "pending");
});

test("custom role management allow auto-applies participant and role changes", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const editableRole: ChatRoleConfig = {
    ...ROLE,
    id: "editable-role",
    label: "Editable Role",
    instructions: "Original instructions.",
    participantDefaults: {
      autoWatch: false,
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "allowing-participant",
    handle: "allowing",
    roleConfigId: allowingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, editableRole, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, manager);

  const roleResult = await service.requestRoleChangeFromTool(actor, {
    operations: [{
      type: "edit_role",
      role: {
        roleConfigId: editableRole.id,
        label: "Edited Role",
        instructions: "Edited instructions."
      }
    }]
  }) as { status: string };

  assert.equal(roleResult.status, "auto_applied");
  assert.equal(settingsState.chatRoleConfigs.find((role) => role.id === editableRole.id)?.label, "Edited Role");
  assert.equal(settingsState.chatRoleConfigs.find((role) => role.id === editableRole.id)?.participantDefaults?.manageRolesParticipants, "deny");
  assert.equal(storage.current.metadata.pendingAppToolApprovals[0].status, "auto-applied");

  const participantResult = await service.requestParticipantChangeFromTool(actor, {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "automanaged",
        roleConfigId: ROLE.id,
        kind: "codex-cli"
      }
    }]
  }) as { status: string };

  assert.equal(participantResult.status, "auto_applied");
  assert.ok((storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "automanaged"));
  assert.equal(storage.current.metadata.pendingAppToolApprovals.at(-1).status, "auto-applied");
});

test("role default management escalation is never auto-applied by allow managers", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const editableRole: ChatRoleConfig = {
    ...ROLE,
    id: "editable-role",
    label: "Editable Role",
    instructions: "Original instructions.",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "allowing-participant",
    handle: "allowing",
    roleConfigId: allowingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, editableRole], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, manager);

  const editResult = await service.requestRoleChangeFromTool(actor, {
    operations: [{
      type: "edit_role",
      role: {
        roleConfigId: editableRole.id,
        label: "Escalating Role",
        instructions: "Raises management.",
        participantDefaults: {
          requestParticipants: "ask",
          manageRolesParticipants: "ask"
        }
      }
    }]
  }) as { status: string; approvalId: string };

  assert.equal(editResult.status, "pending_user_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals.at(-1).status, "pending");
  assert.equal(settingsState.chatRoleConfigs.find((role) => role.id === editableRole.id)?.participantDefaults?.manageRolesParticipants, "deny");

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: editResult.approvalId,
    approve: true
  });

  assert.equal(settingsState.chatRoleConfigs.find((role) => role.id === editableRole.id)?.participantDefaults?.manageRolesParticipants, "ask");

  const createResult = await service.requestRoleChangeFromTool(actor, {
    operations: [{
      type: "create_role",
      role: {
        label: "New Default Manager",
        instructions: "Starts with management.",
        participantDefaults: {
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { status: string };

  assert.equal(createResult.status, "pending_user_approval");
  assert.equal(settingsState.chatRoleConfigs.some((role) => role.label === "New Default Manager"), false);
});

test("participant management override above role default requires approval and then authorizes", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const deniedRole: ChatRoleConfig = {
    ...ROLE,
    id: "denied-role",
    label: "Denied Role",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "allowing-participant",
    handle: "allowing",
    roleConfigId: allowingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, deniedRole], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, manager);

  const result = await service.requestParticipantChangeFromTool(actor, {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: true,
      participant: {
        handle: "deniedmanager",
        roleConfigId: deniedRole.id,
        kind: "codex-cli",
        permissions: {
          ...defaultChatAgentPermissions(),
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { status: string; approvalId: string };

  assert.equal(result.status, "pending_user_approval");
  const pending = storage.current.metadata.pendingAppToolApprovals.at(-1);
  assert.equal(pending?.status, "pending");
  assert.equal((pending?.request as any).operations[0].participant.permissions.manageRolesParticipants, "allow");
  assert.ok(!(storage.current.metadata.participants as ChatParticipant[]).some((participant) => participant.handle === "deniedmanager"));

  await service.respondToAppToolApproval({
    conversationId: conversation.id,
    approvalId: result.approvalId,
    approve: true
  });

  const added = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "deniedmanager");
  assert.ok(added);
  assert.equal(added.permissions?.manageRolesParticipants, "allow");
  const saved = settingsState.chatParticipantConfigs.find((participant) => participant.handle === "deniedmanager");
  assert.ok(saved);
  assert.equal(saved.permissions?.manageRolesParticipants, "allow");

  const managerResult = await service.requestRoleChangeFromTool(participantManagerActor(conversation.id, added), {
    operations: [{
      type: "create_role",
      role: {
        label: "Approved Override Manager",
        instructions: "Can manage after explicit approval."
      }
    }]
  }) as { status: string };
  assert.equal(managerResult.status, "auto_applied");
});

test("participant management override from ask to allow requires approval", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const askingRole: ChatRoleConfig = {
    ...ROLE,
    id: "asking-target",
    label: "Asking Target",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "ask"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "allowing-participant",
    handle: "allowing",
    roleConfigId: allowingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, askingRole], chatParticipantConfigs: [] }
  });

  const result = await service.requestParticipantChangeFromTool(participantManagerActor(conversation.id, manager), {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "asktoallow",
        roleConfigId: askingRole.id,
        kind: "codex-cli",
        permissions: {
          ...defaultChatAgentPermissions(),
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { status: string };

  assert.equal(result.status, "pending_user_approval");
  assert.equal(storage.current.metadata.pendingAppToolApprovals.at(-1).status, "pending");
  assert.equal((storage.current.metadata.pendingAppToolApprovals.at(-1).request as any).operations[0].participant.permissions.manageRolesParticipants, "allow");
});

test("participant permission management escalation is visible in approval payload", async () => {
  const askingRole: ChatRoleConfig = {
    ...ROLE,
    id: "asking-manager",
    label: "Asking Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "ask"
    }
  };
  const deniedRole: ChatRoleConfig = {
    ...ROLE,
    id: "denied-role",
    label: "Denied Role",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "asking-participant",
    handle: "asking",
    roleConfigId: askingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage } = testService({
    conversation,
    settings: { chatRoleConfigs: [askingRole, deniedRole], chatParticipantConfigs: [] }
  });

  const result = await service.requestParticipantChangeFromTool(participantManagerActor(conversation.id, manager), {
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: false,
      participant: {
        handle: "sneaky",
        roleConfigId: deniedRole.id,
        kind: "codex-cli",
        permissions: {
          ...defaultChatAgentPermissions(),
          manageRolesParticipants: "allow"
        }
      }
    }]
  }) as { status: string };

  assert.equal(result.status, "pending_user_approval");
  const pending = storage.current.metadata.pendingAppToolApprovals[0] as ChatAppToolApproval;
  const participant = (pending.request as any).operations[0].participant;
  assert.equal(participant.handle, "sneaky");
  assert.equal(participant.permissions.manageRolesParticipants, "allow");
});

test("participant describe options expose role default explicit and effective management policy", async () => {
  const deniedRole: ChatRoleConfig = {
    ...ROLE,
    id: "denied-role",
    label: "Denied Role",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "deny"
    }
  };
  const assistant = {
    ...chatParticipant("codex-cli"),
    id: "assistant-participant",
    handle: "assistant",
    roleConfigId: ADMIN_ROLE.id
  };
  const currentOverride = {
    ...chatParticipant("codex-cli"),
    id: "override-participant",
    handle: "override",
    roleConfigId: deniedRole.id,
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      manageRolesParticipants: "allow"
    })
  };
  const conversation = chatConversation([assistant, currentOverride]);
  const savedOverride: ChatParticipantConfig = {
    id: "saved-override",
    handle: "savedoverride",
    roleConfigId: deniedRole.id,
    kind: "codex-cli",
    permissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      manageRolesParticipants: "ask"
    }),
    updatedAt: NOW
  };
  const { service } = testService({
    conversation,
    settings: { chatRoleConfigs: [ADMIN_ROLE, deniedRole], chatParticipantConfigs: [savedOverride] }
  });

  const options = await service.describeParticipantOptionsForTool(participantManagerActor(conversation.id, assistant)) as any;
  const current = options.currentParticipants.find((participant: { handle: string }) => participant.handle === "override");
  assert.equal(current.manageRolesParticipants.roleDefault, "deny");
  assert.equal(current.manageRolesParticipants.participantExplicit, "allow");
  assert.equal(current.manageRolesParticipants.effective, "allow");
  assert.equal(current.manageRolesParticipants.exceedsRoleDefault, true);
  const saved = options.savedParticipants.find((participant: { handle: string }) => participant.handle === "savedoverride");
  assert.equal(saved.manageRolesParticipants.roleDefault, "deny");
  assert.equal(saved.manageRolesParticipants.participantExplicit, "ask");
  assert.equal(saved.manageRolesParticipants.effective, "ask");
  assert.equal(saved.manageRolesParticipants.exceedsRoleDefault, true);
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

test("auto-applied role creation returns a persisted role id for participant follow-up", async () => {
  const allowingRole: ChatRoleConfig = {
    ...ROLE,
    id: "allowing-manager",
    label: "Allowing Manager",
    participantDefaults: {
      requestParticipants: "ask",
      manageRolesParticipants: "allow"
    }
  };
  const manager = {
    ...chatParticipant("codex-cli"),
    id: "allowing-participant",
    handle: "allowing",
    roleConfigId: allowingRole.id
  };
  const conversation = chatConversation([manager]);
  const { service, storage, settingsState } = testService({
    conversation,
    settings: { chatRoleConfigs: [allowingRole, ROLE], chatParticipantConfigs: [] }
  });
  const actor = participantManagerActor(conversation.id, manager);

  const roleResult = await service.requestRoleChangeFromTool(actor, {
    reason: "Need a specialized privacy role.",
    operations: [{
      type: "create_role",
      role: {
        label: "Privacy Threat Modeler",
        instructions: "Identify privacy threats and mitigation gaps."
      }
    }]
  }) as { status: string; createdRoleRefs: Array<{ roleConfigId?: string; draftRoleRef?: string }> };
  assert.equal(roleResult.status, "auto_applied");
  assert.equal(roleResult.createdRoleRefs[0].draftRoleRef, undefined);
  const roleConfigId = roleResult.createdRoleRefs[0].roleConfigId;
  assert.equal(roleConfigId, settingsState.chatRoleConfigs.find((role) => role.label === "Privacy Threat Modeler")?.id);

  const participantResult = await service.requestParticipantChangeFromTool(actor, {
    reason: "Add privacy reviewer and save it.",
    operations: [{
      type: "add_new_participant_to_chat",
      saveAsPreset: true,
      participant: {
        handle: "privacy",
        roleConfigId,
        kind: "claude-code"
      }
    }]
  }) as { status: string };

  assert.equal(participantResult.status, "auto_applied");
  assert.equal(settingsState.chatParticipantConfigs[0]?.roleConfigId, roleConfigId);
  const addedParticipant = (storage.current.metadata.participants as ChatParticipant[]).find((participant) => participant.handle === "privacy");
  assert.equal(addedParticipant?.roleConfigId, roleConfigId);
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

test("app_chat_send_message imports image attachments and exposes them in the same run", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(path.join(repoPath, "assets"), { recursive: true });
  const sourcePath = path.join(repoPath, "assets", "shot.png");
  await writeFile(sourcePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service, storage } = testService({ conversation });
  (service as any).attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-run-1",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };

  try {
    const sent = await service.sendChatMessageFromTool(actor, {
      content: "",
      parentMessageId: "user-message",
      attachments: [{
        kind: "image",
        sourcePath: "assets/shot.png",
        filename: "qa-shot.png",
        mimeType: "image/png"
      }]
    });

    assert.equal(sent.ok, true);
    assert.equal(sent.sequence, 1);
    assert.equal(actor.snapshotMaxSequence, 1);
    assert.equal((sent.imageAttachments as Array<{ sourceRoot: string }>)[0].sourceRoot, "repo");
    const message = storage.current.messages[1];
    const attachment = message.metadata.imageAttachments[0];
    assert.equal(message.role, "participant");
    assert.equal(message.content, "");
    assert.equal(attachment.filename, "qa-shot.png");
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.width, 1);
    assert.equal(attachment.height, 1);
    await stat(path.join(storageRoot, attachment.storageKey));

    const listed = await service.listChatAttachmentsForTool(actor, { messageId: sent.messageId });
    assert.deepEqual(
      (listed.attachments as Array<{ attachment: { id: string } }>).map((item) => item.attachment.id),
      [attachment.id]
    );
    const readBack = await service.readChatAttachmentForTool(actor, { attachmentId: attachment.id });
    assert.equal(readBack.dataBase64, ONE_BY_ONE_PNG_BASE64);

    const reacted = await service.reactToMessageFromTool(actor, {
      messageId: sent.messageId as string,
      emoji: "✅"
    });
    assert.equal(reacted.status, "added");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message rejects unsafe image import sources", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-denied-"));
  const repoPath = path.join(tempRoot, "repo");
  const outsidePath = path.join(tempRoot, "outside.png");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(path.join(repoPath, "assets"), { recursive: true });
  await writeFile(path.join(repoPath, "assets", "not-image.txt"), "not an image", "utf8");
  await writeFile(path.join(repoPath, "assets", "shot.png"), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  await writeFile(outsidePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  await symlink(outsidePath, path.join(repoPath, "assets", "outside-link.png"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service, storage } = testService({ conversation });
  (service as any).attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-denied-run",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };

  try {
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "outside",
        attachments: [{ kind: "image", sourcePath: outsidePath }]
      }),
      /outside allowed roots/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool({
        ...actor,
        runId: "send-image-denied-temp-run",
        runPermissions: normalizeChatAgentPermissions({
          ...defaultChatAgentPermissions(),
          repoRead: false,
          workspaceWrite: true,
          shell: { enabled: true, rules: [] }
        })
      }, {
        content: "temp root",
        attachments: [{ kind: "image", sourcePath: outsidePath }]
      }),
      /no allowed image import roots/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "symlink",
        attachments: [{ kind: "image", sourcePath: "assets/outside-link.png" }]
      }),
      /symlink/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "directory",
        attachments: [{ kind: "image", sourcePath: "assets" }]
      }),
      /directory/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "missing",
        attachments: [{ kind: "image", sourcePath: "assets/missing.png" }]
      }),
      /could not be inspected/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "not image",
        attachments: [{ kind: "image", sourcePath: "assets/not-image.txt" }]
      }),
      /UnsupportedImageType/
    );
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "mime mismatch",
        attachments: [{ kind: "image", sourcePath: "assets/shot.png", mimeType: "image/jpeg" }]
      }),
      /UnsupportedImageType/
    );

    assert.equal(storage.current.messages.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message pins imported image file identity while reading", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-identity-"));
  const repoPath = path.join(tempRoot, "repo");
  const sourcePath = path.join(repoPath, "shot.png");
  const outsidePath = path.join(tempRoot, "outside.png");
  await mkdir(repoPath, { recursive: true });
  await writeFile(sourcePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));
  await writeFile(outsidePath, Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service } = testService({ conversation });
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-identity-run",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };
  const serviceAny = service as any;

  try {
    const source = await serviceAny.resolveChatAttachmentImportSource(conversation, actor, "shot.png");
    await assert.rejects(
      () => serviceAny.readFileWithMaxBytes({ ...source, ino: source.ino + 1 }, 10 * 1024 * 1024),
      /changed during import/
    );

    await rm(sourcePath, { force: true });
    await symlink(outsidePath, sourcePath);
    await assert.rejects(
      () => serviceAny.readFileWithMaxBytes(source, 10 * 1024 * 1024),
      /could not be opened safely|changed during import/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message rolls back imported images on later validation failure", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-rollback-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, "shot.png"), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service } = testService({ conversation });
  (service as any).attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-rollback-run",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };

  try {
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "will fail",
        threadId: "ghost-thread",
        attachments: [{ kind: "image", sourcePath: "shot.png" }]
      }),
      /ChatSendMessageDenied/
    );
    const entries = await readdir(path.join(storageRoot, "attachments")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    assert.deepEqual(entries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("app_chat_send_message enforces a per-run imported image byte cap", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "accordagents-send-image-cap-"));
  const repoPath = path.join(tempRoot, "repo");
  const storageRoot = path.join(tempRoot, "storage");
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, "shot.png"), Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"));

  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  conversation.repoPath = repoPath;
  const { service, storage } = testService({ conversation });
  (service as any).attachmentPath = (_conversationId: string, storageKey: string) => path.join(storageRoot, storageKey);
  const actor = {
    conversationId: conversation.id,
    participantId: participant.id,
    roleConfigId: participant.roleConfigId,
    roleConfigVersion: 1,
    capabilities: [],
    snapshotMaxSequence: 0,
    runId: "send-image-cap-run",
    runPermissions: normalizeChatAgentPermissions({
      ...defaultChatAgentPermissions(),
      repoRead: true
    })
  };
  (service as any).appSendMessageImageBytesByRun.set(actor.runId, (5 * 10 * 1024 * 1024) - 1);

  try {
    await assert.rejects(
      () => service.sendChatMessageFromTool(actor, {
        content: "over cap",
        attachments: [{ kind: "image", sourcePath: "shot.png" }]
      }),
      /too many image bytes/
    );
    assert.equal(storage.current.messages.length, 1);
    const entries = await readdir(path.join(storageRoot, "attachments")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    assert.deepEqual(entries, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
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
    /runs on a single member/
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

test("recoverStaleChatRun preserves runs owned by another live app instance", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "external-live-run";
  const ownerPid = process.ppid > 0 ? process.ppid : 1;
  const fresh = new Date().toISOString();
  const conversation = chatConversation([participant], {
    activeRunIds: [runId],
    runId,
    running: true,
    activeRunOwnersByRunId: {
      [runId]: {
        processId: ownerPid,
        instanceId: "external-instance",
        startedAt: NOW,
        updatedAt: fresh
      }
    },
    activeRunParticipantIdsByRunId: {
      [runId]: participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-external", runId));
  const { service } = testService({ conversation });

  const changed = (service as any).recoverStaleChatRun(conversation);

  assert.equal(changed, false);
  assert.deepEqual(conversation.metadata.activeRunIds, [runId]);
  assert.equal(conversation.metadata.activeRunParticipantIdsByRunId?.[runId], participant.id);
  assert.equal(conversation.metadata.running, true);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-external")!.status, "pending");
});

test("recoverStaleChatRun interrupts old local run metadata without an owner", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "pre-owner-run";
  const conversation = chatConversation([participant], {
    activeRunIds: [runId],
    runId,
    running: true,
    activeRunParticipantIdsByRunId: {
      [runId]: participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-old", runId));
  const { service } = testService({ conversation });

  const changed = (service as any).recoverStaleChatRun(conversation);

  assert.equal(changed, true);
  assert.equal(conversation.metadata.activeRunIds, undefined);
  assert.equal(conversation.metadata.activeRunOwnersByRunId, undefined);
  assert.equal(conversation.metadata.activeRunParticipantIdsByRunId, undefined);
  assert.equal(conversation.metadata.running, false);
  const pending = conversation.messages.find((message: any) => message.id === "pending-old")!;
  assert.equal(pending.status, "error");
  assert.equal(pending.content, "Interrupted before completion.");
});

test("recoverStaleChatRun does not preserve stale heartbeat owners even if the pid is live", () => {
  const participant = chatParticipant("codex-cli");
  const runId = "stale-heartbeat-run";
  const ownerPid = process.ppid > 0 ? process.ppid : 1;
  const conversation = chatConversation([participant], {
    activeRunIds: [runId],
    runId,
    running: true,
    activeRunOwnersByRunId: {
      [runId]: {
        processId: ownerPid,
        instanceId: "external-instance",
        startedAt: NOW,
        updatedAt: "2000-01-01T00:00:00.000Z"
      }
    },
    activeRunParticipantIdsByRunId: {
      [runId]: participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-stale-owner", runId));
  const { service } = testService({ conversation });

  const changed = (service as any).recoverStaleChatRun(conversation);

  assert.equal(changed, true);
  assert.equal(conversation.metadata.activeRunIds, undefined);
  assert.equal(conversation.metadata.activeRunOwnersByRunId, undefined);
  assert.equal(conversation.metadata.activeRunParticipantIdsByRunId, undefined);
  assert.equal(conversation.metadata.running, false);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-stale-owner")!.status, "error");
});

test("recoverStaleChatRun clears dead local runs while preserving live remote runs", () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant], {
    activeRunIds: ["remote-run", "local-run"],
    runId: "remote-run",
    running: true,
    remoteRunHandles: {
      "remote-run": {
        runId: "remote-run",
        conversationId: "conversation-1",
        participantId: participant.id,
        participantHandle: participant.handle,
        worker: { host: "worker.example" },
        status: "running",
        startedAt: NOW,
        updatedAt: NOW
      }
    },
    activeRunOwnersByRunId: {
      "local-run": {
        processId: process.pid,
        startedAt: NOW,
        updatedAt: NOW
      }
    },
    activeRunParticipantIdsByRunId: {
      "local-run": participant.id
    }
  });
  conversation.messages.push(pendingParticipantMessage(participant, "pending-remote", "remote-run"));
  conversation.messages.push(pendingParticipantMessage(participant, "pending-local", "local-run"));
  const { service } = testService({ conversation });

  const changed = (service as any).recoverStaleChatRun(conversation);

  assert.equal(changed, true);
  assert.deepEqual(conversation.metadata.activeRunIds, ["remote-run"]);
  assert.equal(conversation.metadata.runId, "remote-run");
  assert.equal(conversation.metadata.running, true);
  assert.equal(conversation.metadata.activeRunOwnersByRunId, undefined);
  assert.equal(conversation.metadata.activeRunParticipantIdsByRunId, undefined);
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-remote")!.status, "pending");
  assert.equal(conversation.messages.find((message: any) => message.id === "pending-local")!.status, "error");
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

test("app MCP advertises attachment and reaction tools to chat participants", () => {
  const appMcp = new AppMcpService();
  const tools = (appMcp as any).toolsForActor({
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: []
  }) as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] }; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
  const listTool = tools.find((tool) => tool.name === APP_CHAT_LIST_ATTACHMENTS_TOOL);
  const readTool = tools.find((tool) => tool.name === APP_CHAT_READ_ATTACHMENT_TOOL);
  const reactionTool = tools.find((tool) => tool.name === APP_CHAT_REACT_TOOL);
  const exportTool = tools.find((tool) => tool.name === APP_CHAT_EXPORT_ATTACHMENT_TOOL);
  const titleTool = tools.find((tool) => tool.name === APP_CHAT_SET_TITLE_TOOL);

  assert.ok(listTool);
  assert.equal(listTool.annotations?.readOnlyHint, true);
  assert.equal(listTool.annotations?.destructiveHint, false);
  assert.ok(listTool.inputSchema?.properties?.messageId);
  assert.ok(listTool.inputSchema?.properties?.threadId);
  assert.ok(listTool.inputSchema?.properties?.limit);
  assert.ok(readTool);
  assert.equal(readTool.annotations?.readOnlyHint, true);
  assert.equal(readTool.annotations?.destructiveHint, false);
  assert.ok(readTool.inputSchema?.properties?.attachmentId);
  assert.deepEqual(readTool.inputSchema?.required, ["attachmentId"]);
  assert.ok(reactionTool);
  assert.ok(reactionTool.inputSchema?.properties?.messageId);
  assert.ok(reactionTool.inputSchema?.properties?.emoji);
  assert.ok(exportTool);
  assert.equal(exportTool.annotations?.readOnlyHint, false);
  assert.equal(exportTool.annotations?.destructiveHint, true);
  assert.ok(exportTool.inputSchema?.properties?.attachmentId);
  assert.ok(exportTool.inputSchema?.properties?.targetPath);
  assert.ok(titleTool);
  assert.equal(titleTool.annotations?.readOnlyHint, false);
  assert.ok(titleTool.inputSchema?.properties?.title);
  assert.ok(tools.find((tool) => tool.name === APP_TOOL_PERMISSION_TOOL));
});

test("appMcpToolNames exposes request tools only with their capabilities", () => {
  const { service } = testService();
  const defaultTools = (service as any).appMcpToolNames([]);
  const requestTools = (service as any).appMcpToolNames(["participants.request"]);
  const compactionTools = (service as any).appMcpToolNames(["compaction.request"]);

  assert.equal(defaultTools.includes(APP_CHAT_REQUEST_PARTICIPANTS_TOOL), false);
  assert.equal(defaultTools.includes(APP_CHAT_REQUEST_COMPACTION_TOOL), false);
  assert.ok(defaultTools.includes(APP_CHAT_LIST_ATTACHMENTS_TOOL));
  assert.ok(defaultTools.includes(APP_CHAT_READ_ATTACHMENT_TOOL));
  assert.ok(defaultTools.includes(APP_CHAT_SET_TITLE_TOOL));
  assert.ok(defaultTools.includes(APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL));
  assert.ok(requestTools.includes(APP_CHAT_REQUEST_PARTICIPANTS_TOOL));
  assert.ok(compactionTools.includes(APP_CHAT_REQUEST_COMPACTION_TOOL));
  assert.ok(requestTools.includes(APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL));
});

test("app MCP advertises self-compaction only with compaction permission", () => {
  const appMcp = new AppMcpService();
  const actor = {
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version
  };
  const without = (appMcp as any).toolsForActor({ ...actor, capabilities: [] }) as Array<{ name: string }>;
  const withCapability = (appMcp as any).toolsForActor({
    ...actor,
    capabilities: ["compaction.request"]
  }) as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;

  assert.equal(without.some((tool) => tool.name === APP_CHAT_REQUEST_COMPACTION_TOOL), false);
  const tool = withCapability.find((item) => item.name === APP_CHAT_REQUEST_COMPACTION_TOOL);
  assert.ok(tool);
  assert.ok(tool.inputSchema?.properties?.instructions);
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
  }) as Array<{
    name: string;
    annotations?: { destructiveHint?: boolean };
    inputSchema?: any;
  }>;
  const roleRequestTool = tools.find((tool) => tool.name === APP_ROLES_REQUEST_CHANGE_TOOL);

  assert.ok(roleRequestTool);
  assert.equal(roleRequestTool.annotations?.destructiveHint, false);
  const roleProperties = roleRequestTool.inputSchema.properties.operations.items.properties.role.properties;
  assert.deepEqual(roleProperties.participantDefaults.properties.manageRolesParticipants.enum, ["ask", "allow", "deny"]);
});

test("app MCP participant permissions schema exposes visible role management overrides", () => {
  const appMcp = new AppMcpService();
  const tools = (appMcp as any).toolsForActor({
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ADMIN_ROLE.id,
    roleConfigVersion: ADMIN_ROLE.version,
    capabilities: ["participants.manage"]
  }) as Array<{
    name: string;
    inputSchema?: any;
  }>;
  const participantRequestTool = tools.find((tool) => tool.name === APP_PARTICIPANTS_REQUEST_CHANGE_TOOL);

  assert.ok(participantRequestTool);
  const permissions = participantRequestTool.inputSchema.properties.operations.items.properties.participant.properties.permissions;
  assert.equal(permissions.additionalProperties, false);
  assert.deepEqual(permissions.properties.manageRolesParticipants.enum, ["ask", "allow", "deny"]);
  assert.deepEqual(permissions.properties.requestParticipants.enum, ["ask", "allow", "deny"]);
  const rosterRequestTool = tools.find((tool) => tool.name === APP_ROSTER_REQUEST_CHANGE_TOOL);
  const rosterPermissions = rosterRequestTool?.inputSchema.properties.operations.items.properties.participant.properties.permissions;
  assert.ok(rosterPermissions);
  assert.deepEqual(rosterPermissions.properties.manageRolesParticipants.enum, ["ask", "allow", "deny"]);
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
    timeoutMs: 5000,
    resumeRequester: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.approvalRequired, false);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, target.id);
  assert.equal(storage.current.metadata.pendingAppToolApprovals, undefined);
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
  (service as any).ensureHistoryFiles = async () => tempRoot;
  const sourceMessage = timelineMessage("@nikita-accord", "@drew-codex-engineer have an /accord on exact implementation plan with Taylor.", {
    role: "participant",
    participantId: manager.id,
    participantLabel: `@${manager.handle}`,
    metadata: {
      threadId: "@nikita-accord"
    }
  });
  conversation.messages.push(sourceMessage);

  await (service as any).createImplicitParticipantRequestApproval(conversation, manager, [sourceMessage]);
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
  (service as any).ensureHistoryFiles = async () => tempRoot;

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
  assert.equal(batch?.completedInToolCall, false);
  assert.equal(batch?.autoResumeMessageId !== undefined, true);
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

  const first = await serviceAny.prepareParticipantRequest(
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

  const sibling = await serviceAny.prepareParticipantRequest(
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
    () => serviceAny.prepareParticipantRequest(
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
    () => (service as any).prepareParticipantRequest(
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
    /participant request chain limit \(24\) reached/
  );
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
    chatParticipantRequestPromptMaxChars?: number;
    chatAutoWatchWakeLimit?: number;
    chatPromptContext?: AppSettings["chatPromptContext"];
    cloudRuns?: Partial<AppSettings["cloudRuns"]>;
    providers?: ProviderSettings[];
    assistantProviderKind?: ChatProviderKind;
    lastSuccessfulChatProviderKind?: ChatProviderKind;
  };
} = {}): { service: ChatService; storage: any; settingsState: {
  chatRoleConfigs: ChatRoleConfig[];
  chatBehaviorRules: ChatBehaviorRuleConfig[];
  chatParticipantConfigs: ChatParticipantConfig[];
  batchWriteCount: number;
  recordedSuccessfulProviders: ChatProviderKind[];
}; tempRoot: string } {
  const tempRoot = path.join(tmpdir(), "accordagents-chat-permissions-test");
  const storage = {
    current: options.conversation ? clone(options.conversation) : undefined,
    async listConversations(): Promise<Array<{ id: string; title: string; kind: Conversation["kind"]; createdAt: string; updatedAt: string; running?: boolean }>> {
      return this.current ? [{
        id: this.current.id,
        title: this.current.title,
        kind: this.current.kind,
        createdAt: this.current.createdAt,
        updatedAt: this.current.updatedAt,
        running: this.current.metadata.running === true || Array.isArray(this.current.metadata.activeRunIds)
      }] : [];
    },
    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.current?.id === id ? clone(this.current) : undefined;
    },
    async saveConversation(conversation: Conversation): Promise<void> {
      this.current = clone(conversation);
    },
    cancelRequests: new Map<string, string>(),
    async requestRunCancel(conversationId: string, runId: string): Promise<void> {
      this.cancelRequests.set(runId, conversationId);
    },
    async takeRunCancelRequests(runIds: string[]): Promise<string[]> {
      const matched = runIds.filter((runId) => this.cancelRequests.has(runId));
      for (const runId of matched) {
        this.cancelRequests.delete(runId);
      }
      return matched;
    }
  };
  const settingsState = {
    chatRoleConfigs: clone(options.settings?.chatRoleConfigs ?? [ROLE]),
    chatBehaviorRules: clone(options.settings?.chatBehaviorRules ?? []),
    chatParticipantConfigs: clone(options.settings?.chatParticipantConfigs ?? []),
    batchWriteCount: 0,
    recordedSuccessfulProviders: [] as ChatProviderKind[]
  };
  let assistantProviderKind = options.settings?.assistantProviderKind;
  const publicSettings = (): AppSettings => ({
    roundLimitDefault: 1,
    cliAgentRunTimeoutMs: 24 * 60 * 60_000,
    chatAutoWatchWakeLimit: options.settings?.chatAutoWatchWakeLimit
      ?? CHAT_AUTO_WATCH_WAKE_LIMIT_DEFAULT,
    chatParticipantRequestMaxDepth: options.settings?.chatParticipantRequestMaxDepth
      ?? CHAT_PARTICIPANT_REQUEST_MAX_DEPTH_DEFAULT,
    chatParticipantRequestPromptMaxChars: options.settings?.chatParticipantRequestPromptMaxChars
      ?? CHAT_PARTICIPANT_REQUEST_PROMPT_MAX_CHARS_DEFAULT,
    chatPromptContext: options.settings?.chatPromptContext ?? DEFAULT_CHAT_PROMPT_CONTEXT,
    cloudRuns: {
      enabled: options.settings?.cloudRuns?.enabled ?? false,
      mode: options.settings?.cloudRuns?.mode ?? "ssh",
      worker: options.settings?.cloudRuns?.worker ?? {},
      hasAwsCredentials: options.settings?.cloudRuns?.hasAwsCredentials ?? false,
      awsInstanceType: options.settings?.cloudRuns?.awsInstanceType ?? "t3.small",
      awsRootVolumeSizeGb: options.settings?.cloudRuns?.awsRootVolumeSizeGb ?? 8,
      maxRuntimeMs: options.settings?.cloudRuns?.maxRuntimeMs ?? 24 * 60 * 60_000,
      pollIntervalMs: options.settings?.cloudRuns?.pollIntervalMs ?? 2_500
    },
    providers: clone(options.settings?.providers ?? [
      { kind: "codex-cli", label: "Codex CLI", enabled: true },
      { kind: "claude-code", label: "Claude Code", enabled: true }
    ]),
    chatRoleConfigs: clone(settingsState.chatRoleConfigs),
    chatBehaviorRules: clone(settingsState.chatBehaviorRules),
    chatSavedPrompts: [],
    chatParticipantConfigs: clone(settingsState.chatParticipantConfigs),
    chatParticipantSeedState: {},
    assistantProviderKind,
    lastSuccessfulChatProviderKind: options.settings?.lastSuccessfulChatProviderKind
  });
  const roleIdFromLabel = (label: string): string =>
    `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "role"}-test`;
  const settings = {
    async getPublicSettings(): Promise<AppSettings> {
      return publicSettings();
    },
    async ensureAssistantProviderDefault(agents: AgentHealth[]): Promise<AppSettings> {
      assistantProviderKind = assistantProviderKind
        ?? options.settings?.lastSuccessfulChatProviderKind
        ?? preferredReadyAssistantProviderKind(agents, publicSettings().providers);
      return publicSettings();
    },
    async ensureGenericChatParticipantSeeds(): Promise<AppSettings> {
      return publicSettings();
    },
    async recordSuccessfulChatProvider(kind: ChatProviderKind): Promise<void> {
      settingsState.recordedSuccessfulProviders.push(kind);
    },
    async getChatParticipantRequestMaxDepth(): Promise<number> {
      return publicSettings().chatParticipantRequestMaxDepth;
    },
    async getChatParticipantRequestPromptMaxChars(): Promise<number> {
      return publicSettings().chatParticipantRequestPromptMaxChars;
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
                participantDefaults: update.participantDefaults ?? role.participantDefaults,
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
          participantDefaults: update.participantDefaults,
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
        remoteExecution: update.remoteExecution,
        autoWatchEnabled: update.autoWatchEnabled,
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
            participantDefaults: operation.role.participantDefaults,
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
                  participantDefaults: operation.role.participantDefaults ?? role.participantDefaults,
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

function timelineMessage(
  id: string,
  content: string,
  patch: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id,
    role: patch.role ?? "user",
    participantId: patch.participantId,
    participantLabel: patch.participantLabel,
    content,
    createdAt: patch.createdAt ?? NOW,
    status: patch.status ?? "done",
    metadata: patch.metadata
  };
}

function participantReplyMessage(participant: ChatParticipant, id: string, content: string): ChatMessage {
  return timelineMessage(id, content, {
    role: "participant",
    participantId: participant.id,
    participantLabel: `@${participant.handle}`,
    metadata: { threadId: "user-message" }
  });
}

function participantRequestCarrierMessage(
  requester: ChatParticipant,
  target: ChatParticipant,
  options: {
    id?: string;
    batchId?: string;
    replyMessageId?: string;
    autoResumeMessageId?: string | null;
    resumeRequester?: boolean;
    completedInToolCall?: boolean;
    batchStatus?: ChatParticipantRequestStatus;
    itemStatus?: ChatParticipantRequestStatus;
  } = {}
): ChatMessage {
  const autoResumeMessageId = options.autoResumeMessageId === undefined ? "requester-resume" : options.autoResumeMessageId;
  const batch: ChatParticipantRequestBatch = {
    id: options.batchId ?? `${options.id ?? "request-message"}-batch`,
    requesterParticipantId: requester.id,
    requesterHandle: requester.handle,
    source: "mcp",
    resumeRequester: options.resumeRequester ?? true,
    status: options.batchStatus ?? "completed",
    depth: 1,
    requesterDepth: 0,
    chainRootId: "chain-root",
    createdAt: NOW,
    updatedAt: NOW,
    triggerMessageId: "user-message",
    items: [{
      targetParticipantId: target.id,
      targetHandle: target.handle,
      prompt: "Please review.",
      status: options.itemStatus ?? "answered",
      replyMessageId: options.replyMessageId,
      createdAt: NOW,
      updatedAt: NOW
    }]
  };
  if (autoResumeMessageId) {
    batch.autoResumeMessageId = autoResumeMessageId;
  }
  if (options.completedInToolCall !== undefined) {
    batch.completedInToolCall = options.completedInToolCall;
  }
  return {
    id: options.id ?? "request-message",
    role: "participant",
    participantId: requester.id,
    participantLabel: `@${requester.handle}`,
    content: `@${target.handle} Please review.`,
    createdAt: NOW,
    status: "done",
    metadata: {
      threadId: "user-message",
      hiddenFromTimeline: true,
      participantRequest: batch
    }
  };
}

function installedChatAgents(): AgentHealth[] {
  return [
    { kind: "codex-cli", label: "Codex CLI", installed: true },
    { kind: "claude-code", label: "Claude Code", installed: true }
  ];
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

function promptContextBlockFromPrompt(prompt: string): string {
  const start = prompt.indexOf("Untrusted chat context automatically included by AccordAgents:");
  if (start < 0) {
    return "";
  }
  const end = prompt.indexOf("Triggering message identifiers:", start);
  return prompt.slice(start, end < 0 ? undefined : end).trim();
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
