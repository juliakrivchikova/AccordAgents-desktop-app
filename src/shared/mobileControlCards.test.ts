import assert from "node:assert/strict";
import test from "node:test";
import { approvalHasCard, controlCardFromApproval, controlCardFromChoiceMessage, controlCardFromHubCard } from "./mobileControlCards";
import type { HubCard } from "./hubOps";
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

function removalApproval(patch: Partial<ChatAppToolApproval> = {}): ChatAppToolApproval {
  return {
    id: "removal-1",
    conversationId: "conversation-1",
    requesterParticipantId: "drew-id",
    requesterHandle: "drew",
    requesterRoleConfigId: "generic-participant",
    toolName: "app_participants_request_change",
    capability: "participants.manage",
    status: "pending",
    request: { kind: "participant_removal", operations: [
      { type: "remove_participant_from_chat", participantId: "gera-id", handle: "gera" },
      { type: "remove_participant_from_chat", participantId: "taylor-id", handle: "taylor" }
    ] },
    summary: "Remove @gera and @taylor from this chat",
    createdAt: "2026-10-26T09:00:00.000Z",
    updatedAt: "2026-10-26T09:00:00.000Z",
    ...patch
  };
}

test("a member removal reaches the phone in the desktop card's words, and stays visible while approved and waiting", () => {
  const pending = controlCardFromApproval("conversation-1", removalApproval());
  assert.equal(pending.title, "@drew wants to remove @gera and @taylor from this chat");
  assert.deepEqual(pending.options, [{ id: "allow", label: "Yes, remove @gera and @taylor" }, { id: "deny", label: "No, keep @gera and @taylor in this chat" }]);
  assert.equal(pending.status, "pending");
  assert.match(pending.summary, /Their session in this chat ends/);

  const queued = removalApproval({ status: "approved", memberRemovalQueuedAt: "2026-10-26T09:01:00.000Z" });
  assert.equal(approvalHasCard(queued), true);
  const waiting = controlCardFromApproval("conversation-1", queued);
  assert.equal(waiting.status, "answered");
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.title, "Removal approved");
  assert.equal(waiting.outcome, "Waiting for running turns to finish and for your Mac to apply it, then @gera and @taylor leave this chat.");
  assert.deepEqual(waiting.options, []);
  assert.equal(waiting.draftOverride, undefined, "nothing to answer");

  const applied = removalApproval({ status: "approved", appliedParticipantIds: ["gera-id", "taylor-id"] });
  assert.equal(approvalHasCard(applied), false, "an applied removal has no card");
  assert.equal(approvalHasCard(removalApproval({ status: "denied" })), false);
});

test("a machine member's approved addition waits visibly until the Mac adds the member", () => {
  const addition = { ...removalApproval(), id: "addition-1", status: "auto-applied" as const, summary: "Add @helper", memberAdditionQueuedAt: "2026-10-26T09:01:00.000Z",
    request: { operations: [{ type: "add_new_participant_to_chat" as const, participant: { handle: "helper", roleConfigId: "generic-participant", kind: "claude-code" as const } }] } };
  assert.equal(approvalHasCard(addition), true);
  const card = controlCardFromApproval("conversation-1", addition);
  assert.equal(card.waiting, true);
  assert.deepEqual(card.options, []);
  assert.equal(card.title, "Addition approved");
  assert.equal(card.summary, "Add @helper");
  assert.equal(card.outcome, "Waiting for your Mac to apply it.");
});

function hubCard(patch: Partial<HubCard>): HubCard {
  return { cardId: "card-1", conversationId: "conversation-1", cardKind: "permission", raisedBy: "device-mac", raisedAt: "2026-10-28T09:00:00.000Z",
    card: {}, state: "pending", ...patch };
}

test("a card on the User's server is the phone's card: answerable while it waits, showing its answer once answered, gone once settled", () => {
  const approval = { id: "approval-1", conversationId: "conversation-1", requesterParticipantId: "drew-id", requesterHandle: "drew", requesterRoleConfigId: "software-engineer",
    toolName: "Bash", capability: "shell", status: "pending", request: { command: "ls" }, summary: "Use Bash", codexDecisionId: "native-1",
    createdAt: "2026-10-28T08:59:00.000Z", updatedAt: "2026-10-28T08:59:00.000Z" } as unknown as ChatAppToolApproval;
  const pending = controlCardFromHubCard(hubCard({ cardId: "approval-1", card: { approval } }));
  assert.equal(pending?.id, "approval-1", "the server's card id: the answer names it");
  assert.equal(pending?.status, "pending");
  assert.deepEqual(pending?.options.map((option) => option.id), ["allow", "deny"]);
  assert.equal(pending?.codexDecisionId, "native-1", "carried back with the answer");
  const answered = controlCardFromHubCard(hubCard({ cardId: "approval-1", card: { approval }, state: "answered", answer: { approve: false } }));
  assert.deepEqual([answered?.status, answered?.waiting, answered?.outcome, answered?.options], ["answered", true, "Denied. Waiting for it to be applied.", []]);
  assert.equal(answered?.codexDecisionId, undefined, "nothing left to answer");
  assert.equal(controlCardFromHubCard(hubCard({ card: { approval }, state: "settled" })), undefined, "a settled card is not shown");

  const removal = removalApproval();
  const roster = controlCardFromHubCard(hubCard({ cardId: removal.id, cardKind: "roster", card: { approval: removal }, state: "answered", answer: { approve: true },
    answeredAt: "2026-10-28T09:01:00.000Z" }));
  assert.deepEqual([roster?.title, roster?.waiting, roster?.outcome], ["Removal approved", true,
    "Waiting for running turns to finish and for your Mac to apply it, then @gera and @taylor leave this chat."], "an approved removal waits as the desktop's does");
  const declined = controlCardFromHubCard(hubCard({ cardId: removal.id, cardKind: "roster", card: { approval: removal }, state: "answered", answer: { approve: false } }));
  assert.equal(declined?.outcome, "No, keep @gera and @taylor in this chat. Waiting for it to be applied.", "a worded answer is said in its words");

  const message = choiceMessage("read");
  const choice = message.metadata!.pendingChoice!;
  const asked = controlCardFromHubCard(hubCard({ cardId: choice.id, cardKind: "choice", participantId: "taylor-id", messageId: message.id,
    card: { choice, sourceMessageId: message.id } }), (participantId) => participantId === "taylor-id" ? "@taylor" : undefined);
  assert.deepEqual([asked?.id, asked?.kind, asked?.status, asked?.sourceMessageId, asked?.requesterLabel, asked?.recommendedOptionId],
    ["choice-1", "choice", "pending", "message-1", "@taylor", "read"]);
  const picked = controlCardFromHubCard(hubCard({ cardId: choice.id, cardKind: "choice", card: { choice, sourceMessageId: message.id }, state: "answered",
    answer: { selectedOptionId: "both" } }));
  assert.deepEqual([picked?.status, picked?.outcome], ["answered", "Searchable and readable"]);
  const own = controlCardFromHubCard(hubCard({ cardId: choice.id, cardKind: "choice", card: { choice, sourceMessageId: message.id }, state: "answered",
    answer: { selectedOptionId: "__custom__", customAnswer: "Neither" } }));
  assert.equal(own?.outcome, "Neither");
  const cancelled = controlCardFromHubCard(hubCard({ cardId: choice.id, cardKind: "choice", card: { choice, sourceMessageId: message.id }, state: "answered", answer: { cancel: true } }));
  assert.equal(cancelled?.outcome, "Cancelled");
  assert.equal(controlCardFromHubCard(hubCard({ cardKind: "mention", card: {} })), undefined, "a card the phone cannot show is not shown");
});

test("a permission card asked again after its device refused an answer tells the phone that sent it why", () => {
  const approval = { id: "approval-2", conversationId: "conversation-1", requesterParticipantId: "drew-id", requesterHandle: "drew", requesterRoleConfigId: "software-engineer",
    toolName: "Bash", capability: "shell", status: "pending", request: { command: "ls" }, summary: "Use Bash",
    createdAt: "2026-10-28T08:59:00.000Z", updatedAt: "2026-10-28T08:59:00.000Z" } as unknown as ChatAppToolApproval;
  const asked = controlCardFromHubCard(hubCard({ cardId: "approval-2", card: { approval,
    refusals: [{ operationId: "op-phone-1", reason: "A script that runs code is approved on the desktop, where its code is shown.", at: "2026-10-28T09:00:00.000Z" }, { operationId: "", reason: "nameless" }] } }));
  assert.equal(asked?.status, "pending");
  assert.deepEqual(asked?.refusedAnswers, [{ operationId: "op-phone-1", reason: "A script that runs code is approved on the desktop, where its code is shown." }]);
  const plain = controlCardFromHubCard(hubCard({ cardId: "approval-2", card: { approval } }));
  assert.equal(plain?.refusedAnswers, undefined);
});
