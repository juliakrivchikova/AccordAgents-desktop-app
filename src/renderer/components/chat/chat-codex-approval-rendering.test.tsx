import assert from "node:assert/strict";
import test from "node:test";
import { create } from "react-test-renderer";

import type { ChatActivityItem, ChatAppToolApproval, ChatCodexApprovalRequest, ChatMessage } from "../../../shared/types";
import {
  chatActivityShowsGenericCancel,
  chatApprovalKeyboardAction,
  chatApprovalPlacement,
  chatApprovalShowsGenericSkip,
  chatCodexApprovalShowsCancel,
  chatCodexApprovalShowsCompactResult,
  chatCodexApprovalRequest
} from "./chat-codex-approval-presentation";
import { ChatCodexApprovalOperation } from "./chat-codex-approval-operation";
import { ChatCodexApprovalResult } from "./chat-codex-approval-result";
import { chatToolPermissionAllowsChatScope, chatToolPermissionRequest } from "./chat-app-tool-data";
import { formatChatTime } from "./chat-format";

const NOW = "2026-08-01T05:00:00.000Z";

test("concurrent Codex cards anchor by participant and run while the shared slot keeps other approvals", () => {
  const messages: ChatMessage[] = [
    participantMessage("message-a", "participant-a", "run-a"),
    participantMessage("message-b", "participant-b", "run-b")
  ];
  const approvalA = codexApproval("approval-a", "participant-a", "run-a");
  const approvalB = codexApproval("approval-b", "participant-b", "run-b");
  const wrongParticipant = codexApproval("approval-wrong", "participant-b", "run-a");
  const ordinaryApproval: ChatAppToolApproval = {
    ...approvalA,
    id: "ordinary",
    requesterParticipantId: "participant-a",
    toolName: "app_chat_request_compaction",
    capability: "compaction.request",
    request: { type: "self_compaction" },
    summary: "Compact context"
  };

  const placement = chatApprovalPlacement(
    [approvalA, approvalB, wrongParticipant, ordinaryApproval],
    messages
  );

  assert.deepEqual(placement.byMessageId.get("message-a")?.map((item) => item.id), ["approval-a"]);
  assert.deepEqual(placement.byMessageId.get("message-b")?.map((item) => item.id), ["approval-b"]);
  assert.deepEqual(placement.unanchored.map((item) => item.id), ["approval-wrong", "ordinary"]);
});

test("Standard Codex presentation exposes only provider decisions and never adds generic controls", () => {
  const approval = codexApproval("approval", "participant", "run");
  const request = chatCodexApprovalRequest(approval);
  assert.ok(request);
  assert.deepEqual(request.options.map((option) => option.label), ["Allow once", "Deny"]);
  assert.equal(chatApprovalShowsGenericSkip(request), false);
  assert.match(request.options[0].detail ?? "", /policy/i);
});

test("Guardian denial offers a card-only Cancel action", () => {
  const approval = codexApproval("guardian", "participant", "run");
  approval.request = {
    ...(approval.request as ChatCodexApprovalRequest),
    method: "item/autoApprovalReview/denied",
    options: [
      { id: "approveRetry", label: "Approve one retry", outcome: "approve" },
      { id: "keepDenied", label: "Keep denied", outcome: "deny" }
    ]
  };
  assert.equal(chatCodexApprovalShowsCancel(chatCodexApprovalRequest(approval)), true);
});

test("cancelled Guardian denial is one line without the blocked command", () => {
  const approval = codexApproval("guardian-cancelled", "participant", "run");
  approval.status = "cancelled";
  approval.summary = `Codex Auto Review denied: ${"very-long-command ".repeat(80)}`;
  approval.request = {
    ...(approval.request as ChatCodexApprovalRequest),
    method: "item/autoApprovalReview/denied",
    options: [
      { id: "approveRetry", label: "Approve one retry", outcome: "approve" },
      { id: "keepDenied", label: "Keep denied", outcome: "deny" }
    ]
  };
  const renderer = create(<ChatCodexApprovalResult approval={approval} />);
  const text = textContent(renderer.toJSON());
  const row = renderer.root.find((instance) => instance.props?.className === "chat-card-row");
  assert.match(text, /Cancelled/);
  assert.match(String(row.props.title), /Closed without retrying/, "why, on hover");
  assert.doesNotMatch(`${text}\n${row.props.title}`, /very-long-command/);
  renderer.unmount();
});

test("a decided Codex card is one line: a long command is cut off there and whole on hover, with nothing to press", () => {
  const approval = codexApproval("guardian-approved-long", "participant", "run");
  approval.status = "approved";
  approval.summary = `Codex Auto Review denied: ${"very-long-command ".repeat(80)}`;
  approval.request = {
    ...(approval.request as ChatCodexApprovalRequest),
    method: "item/autoApprovalReview/denied",
    options: [
      { id: "approveRetry", label: "Approve one retry", outcome: "approve" },
      { id: "keepDenied", label: "Keep denied", outcome: "deny" }
    ]
  };
  const renderer = create(<ChatCodexApprovalResult approval={approval} />);
  const row = renderer.root.find((instance) => instance.props?.className === "chat-card-row");
  assert.match(String(row.props.title), /very-long-command/, "the whole command on hover");
  assert.equal(renderer.root.findAllByType("button").length, 0);
  renderer.unmount();
});

test("a decided Codex card with a short summary says who asked, how it ended and when", () => {
  const approval = codexApproval("approved-short", "participant", "run");
  approval.status = "approved";
  const renderer = create(<ChatCodexApprovalResult approval={approval} />);
  assert.equal(renderer.root.findAllByType("button").length, 0);
  assert.match(textContent(renderer.toJSON()), /Codex approval/);
  assert.match(textContent(renderer.toJSON()), new RegExp(`@participant · Approved ${formatChatTime(approval.updatedAt)}`));
  renderer.unmount();
});

test("Claude Auto permission prompts cannot offer chat-wide scope", () => {
  const toolRequest = { kind: "toolPermission" as const, agentMode: "auto" as const, toolName: "Write" };
  const folder = { kind: "folder" as const, path: "/repo/src" };
  assert.equal(chatToolPermissionAllowsChatScope({ ...toolRequest, chatScope: folder }), false, "Auto never offers it");
  // A file edit is scoped (6d5b15fa): "for this chat" covers the folder the
  // request names, and one with no folder to cover is asked each time.
  assert.equal(chatToolPermissionAllowsChatScope({ ...toolRequest, agentMode: "default", chatScope: folder }), true);
  assert.equal(chatToolPermissionAllowsChatScope({ ...toolRequest, agentMode: "default" }), false);

  const legacyApproval: ChatAppToolApproval = {
    ...codexApproval("legacy-auto", "participant", "run"),
    toolName: "app_tool_permission",
    request: { kind: "toolPermission", toolName: "Write" }
  };
  const legacyToolRequest = chatToolPermissionRequest(legacyApproval, "auto");
  assert.ok(legacyToolRequest);
  assert.equal(chatToolPermissionAllowsChatScope(legacyToolRequest), false);
});

test("Codex approval keyboard selection stays within exact options and Enter submits", () => {
  assert.deepEqual(chatApprovalKeyboardAction("2", 0, 2), { type: "select", index: 1 });
  assert.deepEqual(chatApprovalKeyboardAction("ArrowDown", 1, 2), { type: "select", index: 1 });
  assert.deepEqual(chatApprovalKeyboardAction("ArrowUp", 1, 2), { type: "select", index: 0 });
  assert.deepEqual(chatApprovalKeyboardAction("Enter", 1, 2), { type: "submit" });
  assert.equal(chatApprovalKeyboardAction("3", 0, 2), undefined);
});

test("terminal Guardian timeout requests survive renderer validation with no decision controls", () => {
  const approval = codexApproval("guardian-timeout", "participant", "run");
  approval.status = "expired";
  approval.request = {
    ...(approval.request as ChatCodexApprovalRequest),
    method: "item/autoApprovalReview/timedOut",
    options: []
  };
  assert.deepEqual(chatCodexApprovalRequest(approval)?.options, []);
});

test("Codex operation renders parsed command actions and protected context", () => {
  const request = codexApproval("approval", "participant", "run").request as ChatCodexApprovalRequest;
  const renderer = create(<ChatCodexApprovalOperation request={{
    ...request,
    command: "git push origin scratch",
    cwd: "/tmp/scratch",
    commandActions: [{ type: "read", command: "cat policy", name: "cat", path: "/tmp/policy" }],
    networkTarget: "example.com",
    networkProtocol: "https"
  }} />);
  const text = textContent(renderer.toJSON());
  assert.match(text, /git push origin scratch/);
  assert.match(text, /cat/);
  assert.match(text, /\/tmp\/policy/);
  assert.match(text, /example.com/);
  renderer.unmount();
});

test("Activity hides generic cancellation for Codex while preserving ordinary approval cancellation", () => {
  const codexItem = activityApproval("activity-codex", "approval-codex", "codex");
  const ordinaryItem = activityApproval("activity-ordinary", "approval-ordinary");
  assert.equal(chatActivityShowsGenericCancel(codexItem), false);
  assert.equal(chatActivityShowsGenericCancel(ordinaryItem), true);
});

test("submitted Codex decisions are one line with no controls", () => {
  for (const status of ["approved", "denied"] as const) {
    const approval = codexApproval(`approval-${status}`, "participant", "run");
    approval.status = status;
    assert.equal(chatCodexApprovalShowsCompactResult(approval), true);
    const renderer = create(<ChatCodexApprovalResult approval={approval} />);
    const text = textContent(renderer.toJSON());
    assert.equal(renderer.root.findAll((instance) => instance.props?.className === "chat-card-row").length, 1);
    assert.match(text, status === "approved" ? /Approved/ : /Denied/);
    assert.doesNotMatch(text, /Submit|Approve one retry|Keep denied/);
    renderer.unmount();
  }
});

function participantMessage(id: string, participantId: string, runId: string): ChatMessage {
  return {
    id,
    role: "participant",
    participantId,
    participantLabel: `@${participantId}`,
    content: "",
    createdAt: NOW,
    status: "pending",
    metadata: { runId }
  };
}

function codexApproval(id: string, participantId: string, runId: string): ChatAppToolApproval {
  return {
    id,
    conversationId: "conversation",
    requesterParticipantId: participantId,
    requesterHandle: participantId,
    requesterRoleConfigId: "engineer",
    toolName: "codex_auto_review_approval",
    capability: "permissions.request",
    status: "pending",
    request: {
      kind: "codexApproval",
      method: "item/commandExecution/requestApproval",
      requestId: id,
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      action: "command",
      options: [
        { id: "accept", label: "Allow once", detail: "Apply the proposed command policy.", outcome: "approve" },
        { id: "decline", label: "Deny", outcome: "deny" }
      ]
    },
    summary: "Codex approval",
    createdAt: NOW,
    updatedAt: NOW,
    resumeContext: { runId, triggerMessageId: "trigger" }
  };
}

function activityApproval(id: string, approvalId: string, approvalKind?: "codex"): ChatActivityItem {
  return {
    id,
    conversationId: "conversation",
    conversationTitle: "Approval chat",
    status: "pending",
    kind: "approval",
    title: "Approval required",
    preview: "Pending approval",
    createdAt: NOW,
    updatedAt: NOW,
    target: {
      approvalId,
      messageId: "message",
      ...(approvalKind ? { approvalKind } : {})
    }
  };
}

function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  const record = node as { children?: unknown[] };
  return Array.isArray(record.children) ? record.children.map(textContent).join("") : "";
}
