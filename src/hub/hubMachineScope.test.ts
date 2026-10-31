import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "../shared/types";
import { scopeMachineConversationUpdate } from "./hubMachineScope";

const desk = { id: "p-desk", handle: "desk", label: "Desk", permissions: { shell: { enabled: false } } };
const box = { id: "p-box", handle: "box", label: "Box", homeMachineId: "machine-1" };
const policy = (id: string, participantId: string, targetParticipantId?: string) => ({
  id, participantId, roleConfigId: "r", toolName: "app_participants_request_change", capability: "participants.manage", scope: "chat",
  createdAt: "t", updatedAt: "t", ...(targetParticipantId ? { targetParticipantId } : {})
});

function chat(): Conversation {
  return {
    id: "c", title: "Plans", kind: "chat", createdAt: "t", updatedAt: "t", repoPath: "/p", messages: [], findings: [],
    metadata: { participants: [desk, box], appToolApprovalPolicies: [policy("pol-desk", "p-desk"), policy("pol-box", "p-box"), policy("pol-at-desk", "p-box", "p-desk")] }
  } as unknown as Conversation;
}

test("a member removed without its rules in the same write takes its rules with it", () => {
  const scoped = scopeMachineConversationUpdate(chat(), { metadata: { participants: [box] } }, "machine-1");
  assert.deepEqual((scoped.update.metadata?.appToolApprovalPolicies as Array<{ id: string }>).map((item) => item.id), ["pol-box"]);
});

test("taking away a key: the machine's own rules go, nothing else is taken away", () => {
  const scoped = scopeMachineConversationUpdate(chat(), { removedMetadataKeys: ["appToolApprovalPolicies", "participants"] }, "machine-1");
  assert.deepEqual((scoped.update.metadata?.appToolApprovalPolicies as Array<{ id: string }>).map((item) => item.id).sort(), ["pol-desk"]);
  assert.equal(scoped.update.removedMetadataKeys, undefined);
  assert.ok(scoped.refused.includes("-participants"));
});

test("a machine the roster names no machine for owns no member", () => {
  const scoped = scopeMachineConversationUpdate(chat(), { metadata: { participants: [{ ...desk, agentMode: "auto" }, { ...box, model: "x" }] } }, undefined);
  assert.deepEqual(scoped.update.metadata?.participants, [desk, box], "nothing changes for anyone");
});

test("the folder, the title and other shared fields are left out and said", () => {
  const scoped = scopeMachineConversationUpdate(chat(), { title: "Owned", repoPath: "/Users/u", metadata: { archived: true } }, "machine-1");
  assert.deepEqual(scoped.update, {});
  assert.deepEqual(scoped.refused.sort(), ["archived", "repoPath", "title"]);
});
