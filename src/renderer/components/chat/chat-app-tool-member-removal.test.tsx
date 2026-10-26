import assert from "node:assert/strict";
import test from "node:test";

import type { ChatAppToolApproval, ChatParticipantRemovalRequest } from "../../../shared/types";
import { chatAppToolApprovals, chatParticipantRemovalRequest } from "./chat-app-tool-data";
import {
  memberRemovalConsequence,
  memberRemovalOptions,
  memberRemovalQuestion,
  memberRemovalResultSummary
} from "./chat-app-tool-member-removal";
import { reviewResultSummary } from "./chat-app-tool-approval-review";

const NOW = "2026-10-22T07:00:00.000Z";

function removal(handles: string[]): ChatParticipantRemovalRequest {
  return {
    kind: "participant_removal",
    operations: handles.map((handle) => ({ type: "remove_participant_from_chat", participantId: `${handle}-id`, handle }))
  };
}

function approval(request: ChatParticipantRemovalRequest, patch: Partial<ChatAppToolApproval> = {}): ChatAppToolApproval {
  return {
    id: "removal-1",
    conversationId: "chat-1",
    requesterParticipantId: "alpha-id",
    requesterHandle: "alpha",
    requesterRoleConfigId: "generic-participant",
    toolName: "app_participants_request_change",
    capability: "participants.manage",
    status: "pending",
    request,
    summary: "Remove members",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  };
}

test("a member removal card is recognised and asks in removal terms", () => {
  const request = removal(["beta"]);
  const card = approval(request);
  assert.deepEqual(chatParticipantRemovalRequest(card), { ...request, reason: undefined });
  assert.equal(chatAppToolApprovals({ metadata: { pendingAppToolApprovals: [card] } } as never).length, 1);
  assert.equal(memberRemovalQuestion(card, request), "@alpha wants to remove @beta from this chat");
  assert.deepEqual(memberRemovalOptions(request).map((option) => [option.label, option.approve, option.scope]), [
    ["Yes, remove @beta", true, "once"],
    ["No, keep @beta in this chat", false, undefined]
  ]);
  assert.match(memberRemovalConsequence(card, request), /once @alpha's turn has ended and no member is running/);
});

test("a removal card states each outcome the User can see", () => {
  const two = removal(["beta", "gamma"]);
  const states: Array<[Partial<ChatAppToolApproval>, string, string, string]> = [
    [{ status: "approved", memberRemovalQueuedAt: NOW }, "waiting", "Removal approved", "Waiting for running turns to finish, then @beta and @gamma leave this chat."],
    [{ status: "approved", appliedParticipantIds: ["beta-id", "gamma-id"] }, "done", "Members removed", "@beta and @gamma left this chat."],
    [{ status: "approved", appliedParticipantIds: ["beta-id"] }, "done", "Member removed", "@beta left this chat. @gamma had already left."],
    [{ status: "approved", appliedParticipantIds: [] }, "done", "Nothing to remove", "@beta and @gamma had already left this chat."],
    [{ status: "denied" }, "refused", "Removal declined", "@beta and @gamma stay in this chat."],
    [{ status: "denied", error: "Member was removed from this chat." }, "refused", "Removal not applied", "Member was removed from this chat."],
    [{ status: "cancelled", error: "Chat Assistant cannot be removed from the chat." }, "refused", "Removal not applied", "Chat Assistant cannot be removed from the chat."]
  ];
  for (const [patch, tone, title, detail] of states) {
    assert.deepEqual(memberRemovalResultSummary(approval(two, patch), two), { tone, title, detail }, JSON.stringify(patch));
  }
});

test("an addition card is not mistaken for a removal", () => {
  const addition = approval(removal(["beta"]), {
    request: { operations: [{ type: "add_existing_participant_to_chat", participantConfigId: "preset-1" }] }
  });
  assert.equal(chatParticipantRemovalRequest(addition), undefined);
});

test("a member addition card says it waits while a machine member's addition is not applied, and never 'added' once it was not", () => {
  const addition: ChatAppToolApproval = {
    id: "addition-1", conversationId: "chat-1", requesterParticipantId: "alpha-id", requesterHandle: "alpha", requesterRoleConfigId: "generic-participant",
    toolName: "app_participants_request_change", capability: "participants.manage", status: "auto-applied",
    request: { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "generic-participant", kind: "claude-code" } }] },
    summary: "Add @helper", createdAt: NOW, updatedAt: NOW
  };
  const change = addition.request as Parameters<typeof reviewResultSummary>[2];
  assert.deepEqual(reviewResultSummary({ ...addition, memberAdditionQueuedAt: NOW }, undefined, change, undefined, []),
    { title: "Addition approved", detail: "Waiting to be applied in this chat.", tone: "waiting" });
  for (const status of ["cancelled", "expired"] as const) {
    assert.deepEqual(reviewResultSummary({ ...addition, status, error: "Duplicate member name." }, undefined, change, undefined, []),
      { title: "Not applied", detail: "No role or member changes were made.", tone: "refused" });
  }
  assert.equal(reviewResultSummary(addition, undefined, change, undefined, []).tone, "done");
  assert.equal(reviewResultSummary(addition, undefined, change, undefined, []).title, "Member added");
});
