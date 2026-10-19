import assert from "node:assert/strict";
import test from "node:test";
import { controlCardFromApproval, controlCardFromChoiceMessage } from "./mobileControlCards";
import type { ChatAppToolApproval, ChatMessage } from "./types";

function choiceMessage(recommendedOptionId?: string): ChatMessage {
  return {
    id: "message-1",
    role: "participant",
    participantLabel: "@taylor",
    content: "Which one?",
    createdAt: "2026-09-22T19:00:00.000Z",
    metadata: {
      pendingChoice: {
        id: "choice-1",
        title: "Artifacts in search",
        question: "Should search also match text inside artifacts?",
        options: [
          { id: "both", label: "Searchable and readable", description: "Search finds text inside artifacts." },
          { id: "read", label: "Readable only", description: "Agents open artifacts they already found." }
        ],
        ...(recommendedOptionId ? { recommendedOptionId } : {}),
        status: "pending"
      }
    }
  } as unknown as ChatMessage;
}

// The phone showed a member's choice without its recommendation (the User,
// 2026-09-22): the card it is sent never carried one.
test("a choice card carries the member's recommendation and each option's description", () => {
  const card = controlCardFromChoiceMessage("conversation-1", choiceMessage("both"));
  assert.equal(card?.recommendedOptionId, "both");
  assert.deepEqual(card?.options.map((option) => option.description), [
    "Search finds text inside artifacts.",
    "Agents open artifacts they already found."
  ]);
});

test("a recommendation that names no option of the choice is left off", () => {
  assert.equal(controlCardFromChoiceMessage("conversation-1", choiceMessage("gone"))?.recommendedOptionId, undefined);
  assert.equal(controlCardFromChoiceMessage("conversation-1", choiceMessage())?.recommendedOptionId, undefined);
});

// A refused answer left the phone that sent it showing it on its way for an
// hour (the User, 2026-10-01): the card now names them while the choice waits.
test("refused answers travel with their card while the choice still waits, and not after", () => {
  const message = choiceMessage();
  const choice = message.metadata!.pendingChoice!;
  choice.refusals = [
    { operationId: "choice:choice-1:read", reason: "Selected option was not found.", at: "2026-10-01T07:47:30.450Z" },
    { operationId: "choice:choice-1:__custom__:abc", reason: "Unarchive the chat before starting a member.", at: "2026-10-01T07:48:00.000Z" }
  ];
  assert.deepEqual(controlCardFromChoiceMessage("conversation-1", message)?.refusedAnswers, [
    { operationId: "choice:choice-1:read", reason: "Selected option was not found." },
    { operationId: "choice:choice-1:__custom__:abc", reason: "Unarchive the chat before starting a member." }
  ]);
  choice.status = "selected";
  choice.selectedOptionId = "both";
  assert.equal(controlCardFromChoiceMessage("conversation-1", message)?.refusedAnswers, undefined);
});

// The phone cannot show a script's code yet, so a script that installs code is
// approved on the desktop: the phone may only decline it.
test("a scheduled script that installs code reaches the phone as decline-only", () => {
  const approval = (op: string) => ({
    id: `approval-${op}`,
    conversationId: "chat-1",
    requesterParticipantId: "p-taylor",
    requesterHandle: "taylor",
    requesterRoleConfigId: "software-engineer",
    toolName: "app_scripts_request_change",
    capability: "scripts.request",
    status: "pending",
    summary: "Add the scheduled script \"QA ping\"",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    request: {
      kind: "script-change", op, scriptId: "script-0000-test", name: "QA ping", description: "d",
      hostId: "desktop", hostLabel: "This Mac", hostPhrase: "this Mac", runtime: "node", entry: "w.mjs",
      schedule: { kind: "interval", everySeconds: 60 }, scheduleText: "Every minute", timeoutSeconds: 300,
      secretNames: [], permissions: { chatIds: ["chat-1"], participantIds: [], maxWakeupsPerHour: 6 },
      chatLabels: {}, participantLabels: {}, fileCount: 1, totalBytes: 10
    }
  }) as unknown as ChatAppToolApproval;
  const create = controlCardFromApproval("chat-1", approval("create"));
  assert.deepEqual(create.options.map((option) => option.id), ["deny"]);
  assert.match(create.title, /^Approve on the desktop/);
  const disable = controlCardFromApproval("chat-1", approval("disable"));
  assert.deepEqual(disable.options.map((option) => option.id), ["allow", "deny"], "switching off installs nothing, so the phone may approve it");
});
