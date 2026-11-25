import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { APP_SCRIPTS_REQUEST_CHANGE_TOOL } from "../../shared/appMcpToolContracts";
import { choiceCardId } from "../../shared/hubCards";
import type { HubCard, HubFeedResponse } from "../../shared/hubOps";
import { buildChatActivityItems } from "../../shared/chatActivity";
import { controlCardFromChoiceMessage, controlCardFromHubCard } from "../../shared/mobileControlCards";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant, Conversation } from "../../shared/types";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import {
  appliers, approvalOf, at, callWaitsOn, chat, chatService, desk, linkedDesktop, remote, save, scriptApproval, serverTurn, setup,
  toolApproval, type Turn, until
} from "./chat/test/cardFixtures";

test("a machine member's choice answered on the desktop is applied once on the machine; the desktop never writes the machine's message", async (t) => {
  const h = await linkedDesktop(t, chat("cards-d"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-d"), (item) => Boolean(item));
  // The machine's member asks the User a choice in its reply.
  const machineCopy = (await h.machineStorage.getConversation("cards-d"))!;
  const asking: ChatMessage = {
    id: "choice-message", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "Which store?", createdAt: new Date().toISOString(),
    status: "done", metadata: { pendingChoice: { id: "choice-1", title: "Store", question: "Which store?", status: "pending",
      options: [{ id: "sqlite", label: "SQLite" }, { id: "files", label: "Files" }] } }
  } as ChatMessage;
  machineCopy.messages.push(asking);
  await save(h.machineChat, machineCopy);
  const cardId = choiceCardId("choice-message");
  const raised = await until(() => h.card(cardId), (item) => item?.state === "pending");
  assert.equal(raised!.raisedBy, h.machineIdentity.originId, "raised by the machine its member runs on");
  // The desktop shows the choice and answers it through its card.
  await until(() => h.desktopStorage.getConversation("cards-d"), (item) => item?.messages.some((message) => message.metadata?.pendingChoice?.status === "pending") ?? false);
  await h.desktopChat.answerChoiceCard({ conversationId: "cards-d", sourceMessageId: "choice-message", choiceId: "choice-1", selectedOptionId: "files" });
  // Returned once the server took it and this copy shows it: never asked again meanwhile.
  const shownRight = (await h.desktopStorage.getConversation("cards-d"))?.messages.find((message) => message.id === "choice-message");
  assert.ok(shownRight?.metadata?.serverCard?.state === "answered" || shownRight?.metadata?.pendingChoice?.status === "selected",
    "the desktop shows its answer as soon as the answer returns");
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  assert.equal(settled!.answeredBy, h.desktopIdentity.originId);
  await until(async () => h.turns, (turns) => turns.length === 1);
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.participantId]), [["machine", remote.id]], "the member continued once, on its machine");
  // Only the machine changed its member's message, on the server.
  const feed = await h.call<HubFeedResponse>(h.desktopIdentity, "GET", "/v3/feed?after=0");
  const writes = feed.entries.filter((entry) => (entry.effect.kind === "message.create" || entry.effect.kind === "message.update") &&
    entry.effect.message.id === "choice-message");
  assert.ok(writes.length >= 2, "written and then answered");
  assert.ok(writes.every((entry) => entry.deviceId === h.machineIdentity.originId), "never written by the desktop");
  const page = await h.call<{ messages: ChatMessage[] }>(h.desktopIdentity, "GET", "/v3/chat?conversationId=cards-d");
  const answeredChoice = page.messages.find((message) => message.id === "choice-message")?.metadata?.pendingChoice;
  assert.deepEqual([answeredChoice?.status, answeredChoice?.selectedOptionId], ["selected", "files"]);
  // The desktop shows what the machine wrote, and nothing waits.
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-d"), (item) => {
    const message = item?.messages.find((entry) => entry.id === "choice-message");
    return message?.metadata?.pendingChoice?.status === "selected" && !message.metadata.serverCard;
  });
  assert.ok(desktopCopy);
  // A second answer (from the phone) is refused by the server.
  const late = await h.phoneAnswers("cards-d", cardId, { selectedOptionId: "sqlite" });
  assert.equal(late.result.status, "rejected");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.turns.length, 1, "continued once");
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
});

test("a machine member's approval is shown on the desktop as its card, answered from the phone, applied on the machine, and closed on the desktop", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-e"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-e"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-e"))!;
  machineCopy.metadata = { ...machineCopy.metadata, pendingAppToolApprovals: [toolApproval(approvalId, remote, "cards-e")] } as Conversation["metadata"];
  callWaitsOn(h.machineChat, approvalId);
  await save(h.machineChat, machineCopy);
  await until(() => h.card(approvalId), (item) => item?.state === "pending" && item.raisedBy === h.machineIdentity.originId);
  // The desktop shows the machine member's card as its own kind of card.
  const mirror = await until(() => approvalOf(h.desktopStorage, "cards-e", approvalId), (item) => item?.status === "pending");
  assert.equal(mirror?.homeMachineId, "box");
  // A copy never raises another device's member's card.
  assert.equal((await h.card(approvalId))?.raisedBy, h.machineIdentity.originId);
  assert.equal((await h.phoneAnswers("cards-e", approvalId, { approve: true })).result.status, "accepted");
  await until(() => h.card(approvalId), (item) => item?.state === "settled");
  assert.equal((await approvalOf(h.machineStorage, "cards-e", approvalId))?.status, "approved", "applied on the machine");
  const lines = (await h.machineStorage.getConversation("cards-e"))?.messages.filter((message) => message.content.startsWith("Allowed @drew to use Bash")).length;
  assert.equal(lines, 1, "once");
  const closed = await until(() => approvalOf(h.desktopStorage, "cards-e", approvalId), (item) => item?.status === "approved" && !item.machineDecisionPending);
  assert.ok(closed, "the desktop's card closes with the machine's outcome");
  // The desktop's own answer to a card already answered is refused by the server.
  await assert.rejects(h.desktopChat.answerAppToolApprovalCard({ conversationId: "cards-e", approvalId, approve: false }), /already been answered/);
});

test("a machine member's request to remove a member is raised by its machine, approved on the phone, made and settled by that machine (Д2), and the desktop only reads it", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-f"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-f"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-f"))!;
  const removal = {
    id: approvalId, conversationId: "cards-f", requesterParticipantId: remote.id, requesterHandle: remote.handle, requesterRoleConfigId: remote.roleConfigId,
    toolName: "app_participants_request_change", capability: "participants.manage", status: "pending",
    request: { kind: "participant_removal", reason: "Done here.", operations: [{ type: "remove_participant_from_chat", participantId: desk.id, handle: desk.handle }] },
    summary: "Remove @taylor from this chat", createdAt: at, updatedAt: at
  } as unknown as ChatAppToolApproval;
  machineCopy.metadata = { ...machineCopy.metadata, pendingAppToolApprovals: [removal] } as Conversation["metadata"];
  await save(h.machineChat, machineCopy);
  const raised = await until(() => h.card(approvalId), (item) => item?.state === "pending");
  assert.equal(raised!.cardKind, "roster");
  assert.equal(raised!.raisedBy, h.machineIdentity.originId);
  await until(() => approvalOf(h.desktopStorage, "cards-f", approvalId), (item) => item?.status === "pending" && item.homeMachineId === "box");
  assert.equal((await h.phoneAnswers("cards-f", approvalId, { approve: true })).result.status, "accepted");
  // The phone shows it approved and waiting while it is made.
  const answered = await h.card(approvalId);
  assert.equal(controlCardFromHubCard(answered!)?.title, "Removal approved");
  // The machine makes it; the desktop reads it from the server.
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-f"), (item) =>
    !((item?.metadata.participants ?? []) as ChatParticipant[]).some((member) => member.id === desk.id));
  const said = desktopCopy!.messages.filter((message) => message.content === "Removed @taylor from this chat at @drew's request.");
  assert.equal(said.length, 1);
  assert.equal(said[0].metadata?.serverWriter, h.machineIdentity.originId, "written by the machine, once");
  // The machine applied the answer and settles its card.
  const settled = await until(() => h.card(approvalId), (item) => item?.state === "settled");
  const outcome = settled!.outcome as { result?: string; approval?: ChatAppToolApproval };
  assert.equal(outcome.result, "applied");
  assert.deepEqual(outcome.approval?.appliedParticipantIds, [desk.id]);
  const onMachine = await approvalOf(h.machineStorage, "cards-f", approvalId);
  assert.equal(onMachine?.status, "approved");
  assert.equal(onMachine?.memberRemovalQueuedAt, undefined);
  const serverChat = await h.call<{ conversation: { metadata: { participants: ChatParticipant[] } } }>(h.desktopIdentity, "GET", "/v3/chat?conversationId=cards-f");
  assert.deepEqual(serverChat.conversation.metadata.participants.map((member) => member.id), [remote.id], "the member list on the server");
});

test("a machine member whose Manage members setting allows it removes a member without a card: its machine decides, makes and settles it, the phone shows it waiting, and nobody is asked", async (t) => {
  const allowing: ChatParticipant = { ...remote, permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), manageRolesParticipants: "allow" }) };
  const h = await linkedDesktop(t, chat("cards-allow", { participants: [desk, allowing] }));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-allow"), (item) => Boolean(item));
  // The asking member's turn is running on the machine, as when it calls the tool.
  const machineCopy = (await h.machineStorage.getConversation("cards-allow"))!;
  const machineRuns = chatParts(h.machineChat).activeRuns as unknown as { beginChatRun(c: Conversation, runId: string): Promise<void>; endChatRun(c: Conversation, runId: string): Promise<void> };
  await machineRuns.beginChatRun(machineCopy, "drew-run");
  const result = await h.machineChat.requestParticipantChangeFromTool(
    { conversationId: "cards-allow", participantId: allowing.id, roleConfigId: allowing.roleConfigId, roleConfigVersion: 1, capabilities: ["participants.manage"] } as never,
    { reason: "Done here.", operations: [{ type: "remove_participant_from_chat", handle: desk.handle }] }
  ) as { status: string; approvalId: string };
  assert.equal(result.status, "auto_approved");
  // Raised and answered by the machine itself while the turn runs: nobody is
  // asked, and the phone shows it waiting.
  const answered = await until(() => h.card(result.approvalId), (item) => item?.state === "answered");
  assert.equal(answered!.answeredBy, h.machineIdentity.originId);
  const onPhone = controlCardFromHubCard(answered!);
  assert.deepEqual([onPhone?.status, onPhone?.title, onPhone?.waiting, onPhone?.options], ["answered", "Removal approved", true, []], "never a question");
  const waitingOnDesktop = await until(() => approvalOf(h.desktopStorage, "cards-allow", result.approvalId), (item) => Boolean(item?.machineDecisionPending));
  assert.equal(waitingOnDesktop!.machineDecisionPending!.approve, true);
  assert.ok(((await h.desktopStorage.getConversation("cards-allow"))!.metadata.participants as ChatParticipant[]).some((member) => member.id === desk.id),
    "nothing is made while the turn runs");
  await machineRuns.endChatRun(machineCopy, "drew-run");
  const removedLine = "Removed @taylor from this chat at @drew's request.";
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-allow"), (item) =>
    !((item?.metadata.participants ?? []) as ChatParticipant[]).some((member) => member.id === desk.id) &&
    Boolean(item?.messages.some((message) => message.content === removedLine)));
  const said = desktopCopy!.messages.filter((message) => message.content === removedLine);
  assert.equal(said.length, 1);
  assert.equal(said[0].metadata?.serverWriter, h.machineIdentity.originId, "written by the machine, once");
  assert.equal(desktopCopy!.messages.some((message) => message.content.includes("approval needed")), false);
  const settled = await until(() => h.card(result.approvalId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  const onMachine = await approvalOf(h.machineStorage, "cards-allow", result.approvalId);
  assert.equal(onMachine?.status, "auto-applied");
  assert.equal(onMachine?.memberRemovalQueuedAt, undefined);
  // The desktop never asks and never makes it a second time.
  const onDesktop = await until(() => approvalOf(h.desktopStorage, "cards-allow", result.approvalId), (item) => Boolean(item) && !item!.machineDecisionPending);
  assert.equal(onDesktop!.status, "auto-applied");
  assert.equal(onDesktop!.memberRemovalQueuedAt, undefined);
});

test("a machine member's choice answered while its machine was stopped is applied once when the machine starts again", async (t) => {
  const h = await linkedDesktop(t, chat("cards-g"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-g"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-g"))!;
  machineCopy.messages.push({
    id: "choice-g", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "Ship now?", createdAt: new Date().toISOString(),
    status: "done", metadata: { pendingChoice: { id: "choice-g1", title: "Ship", question: "Ship now?", status: "pending",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } }
  } as ChatMessage);
  await save(h.machineChat, machineCopy);
  const cardId = choiceCardId("choice-g");
  await until(() => h.card(cardId), (item) => item?.state === "pending");
  // The machine stops; the User answers on the phone meanwhile.
  await h.machineLink.stop();
  const answer = await h.phoneAnswers("cards-g", cardId, { selectedOptionId: "yes" });
  assert.equal(answer.result.status, "accepted");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await h.card(cardId))?.state, "answered", "the answer waits on the server for the machine");
  assert.deepEqual(h.turns, [], "nobody else applies it");
  // The desktop shows it answered and waiting for the machine; it never
  // writes the machine member's message.
  await until(() => h.desktopStorage.getConversation("cards-g"), (item) =>
    item?.messages.find((message) => message.id === "choice-g")?.metadata?.serverCard?.state === "answered");
  // The machine starts again: a new process, the same storage.
  const restartedTurns: Turn[] = [];
  const restarted = chatService(h.machineStorage, restartedTurns, "machine");
  restarted.setHostMachineId("box");
  const restartedAppliers = appliers(h.machineStorage, restarted, h.desktopIdentity.originId, "machine-2");
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.machineStorage, restarted, h.machineEvents, "machine-2", false);
  h.links.push(link);
  await link.start();
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  await until(async () => restartedTurns, (turns) => turns.length === 1);
  assert.deepEqual(restartedTurns.map((turn) => [turn.device, turn.participantId]), [["machine", remote.id]], "continued once, on its machine");
  // Read again (a reconnect): nothing is applied twice.
  await restarted.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(restartedTurns.length + h.turns.length, 1);
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-g"), (item) => {
    const message = item?.messages.find((entry) => entry.id === "choice-g");
    return message?.metadata?.pendingChoice?.status === "selected" && !message.metadata.serverCard;
  });
  assert.ok(desktopCopy, "the desktop shows the machine's answered choice, and nothing waits");
  await until(async () => restarted.liveRunIds().length, (count) => count === 0);
});

test("a task a machine's member creates without a card asks nobody, and every device shows it", async (t) => {
  const maker: ChatParticipant = { ...remote, permissions: { ...normalizeChatAgentPermissions(remote.permissions), scheduleWithoutAsking: true } };
  const h = await linkedDesktop(t, chat("cards-made", { participants: [desk, maker] } as never));
  let applied = 0;
  const { request } = scriptApproval("x", "cards-made");
  h.machineChat.setScriptHost({
    async proposeChange() { return { kind: "approval", request, summary: "Add the scheduled task", missingSecretNames: [] }; },
    async attachApproval() { return undefined; },
    async assertApprovable() { return undefined; },
    async applyApproved() { applied += 1; return "Added the scheduled task \"Watcher\"."; },
    async rejectPending() { return undefined; }
  } as never);
  const settings = (chatDependencies(h.machineChat) as unknown as { settings: { getPublicSettings(): Promise<Record<string, unknown>> } }).settings;
  const read = settings.getPublicSettings.bind(settings);
  settings.getPublicSettings = async () => ({ ...await read(), newChatDefaults: { compactWithoutAsking: true, scheduleWithoutAsking: true } });
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-made"), (item) => Boolean(item));
  const result = await h.machineChat.scriptToolFromApp({ conversationId: "cards-made", participantId: maker.id, roleConfigId: maker.roleConfigId, roleConfigVersion: 1, capabilities: [] } as never,
    APP_SCRIPTS_REQUEST_CHANGE_TOOL, { op: "create" });
  assert.equal(result.status, "created");
  const approvalId = String(result.approvalId);
  const settled = await until(() => h.card(approvalId), (item) => item?.state === "settled");
  assert.deepEqual([settled!.answer?.auto, settled!.answeredBy], [true, h.machineIdentity.originId], "its machine answered it, nobody was asked");
  const shown = await until(() => approvalOf(h.desktopStorage, "cards-made", approvalId), (item) => item?.status === "auto-applied" && !item.machineDecisionPending);
  assert.equal(shown!.taskCreatedAt, undefined);
  assert.equal(controlCardFromHubCard(settled!), undefined);
  assert.equal(applied, 1, "installed once");
});

/** The machine starts again: a new process on the same storage. */
async function restartMachine(h: Awaited<ReturnType<typeof setup>>, name: string) {
  const turns: Turn[] = [];
  const restarted = chatService(h.machineStorage, turns, "machine");
  restarted.setHostMachineId("box");
  const restartedAppliers = appliers(h.machineStorage, restarted, h.desktopIdentity.originId, name);
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.machineStorage, restarted, h.machineEvents, name, false);
  h.links.push(link);
  await link.start();
  return { chat: restarted, link, turns };
}

function removalOf(approvalId: string, conversationId: string): ChatAppToolApproval {
  return {
    id: approvalId, conversationId, requesterParticipantId: remote.id, requesterHandle: remote.handle, requesterRoleConfigId: remote.roleConfigId,
    toolName: "app_participants_request_change", capability: "participants.manage", status: "pending",
    request: { kind: "participant_removal", reason: "Done here.", operations: [{ type: "remove_participant_from_chat", participantId: desk.id, handle: desk.handle }] },
    summary: "Remove @taylor from this chat", createdAt: at, updatedAt: at
  } as unknown as ChatAppToolApproval;
}

test("a machine makes the removal its member asked for itself once the User approves, also with the desktop off, and never asks again after a restart (Д2)", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-k"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-k"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-k"))!;
  machineCopy.metadata = { ...machineCopy.metadata, pendingAppToolApprovals: [removalOf(approvalId, "cards-k")] } as Conversation["metadata"];
  await save(h.machineChat, machineCopy);
  await until(() => h.card(approvalId), (item) => item?.state === "pending");
  // The desktop is off; the User approves on the phone; the machine makes the
  // change itself: no device has a special right to a chat's members.
  await h.desktopLink.stop();
  assert.equal((await h.phoneAnswers("cards-k", approvalId, { approve: true })).result.status, "accepted");
  const settled = await until(() => h.card(approvalId), (item) => item?.state === "settled", 20_000);
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  // The machine restarts (an idle stop, an upgrade): nothing is asked or made again.
  await h.machineLink.stop();
  const machine = await restartMachine(h, "machine-k");
  await machine.chat.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const feed = await h.call<HubFeedResponse>(h.desktopIdentity, "GET", "/v3/feed?after=0");
  const settledAt = feed.entries.find((entry) => entry.effect.kind === "card.settle" && entry.effect.card.cardId === approvalId)!.seq;
  assert.deepEqual(feed.entries.filter((entry) => entry.seq > settledAt && entry.effect.kind.startsWith("card.") && "card" in entry.effect &&
    (entry.effect as { card: HubCard }).card.cardId === approvalId).map((entry) => entry.effect.kind), [], "nothing raised or settled after it");
  // The desktop comes back and reads the chat as the machine left it.
  const desktopAgain = h.link(h.desktopStorage, h.desktopChat, h.desktopEvents, "desktop-k", true);
  h.links.push(desktopAgain);
  await desktopAgain.start();
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-k"), (item) =>
    ((item?.metadata.participants ?? []) as ChatParticipant[]).every((member) => member.id !== desk.id));
  assert.deepEqual((desktopCopy!.metadata.participants as ChatParticipant[]).map((member) => member.id), [remote.id]);
  const page = await h.call<{ messages: ChatMessage[] }>(h.desktopIdentity, "GET", "/v3/chat?conversationId=cards-k");
  assert.equal(page.messages.filter((message) => message.content === "Removed @taylor from this chat at @drew's request.").length, 1, "made once");
  assert.equal(page.messages.filter((message) => message.content.startsWith("Could not remove")).length, 0, "nothing says it failed");
});

// The User, 2026-11-01: a member's choice expires an hour after it was asked
// once she went on with that member; it leaves Pending on every device.
test("a machine member's choice expires on its machine once the User went on with it: settled on the server, gone from the phone and the desktop, shown as expired", async (t) => {
  const askedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const wentOnAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const h = await linkedDesktop(t, chat("cards-expiry"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-expiry"), (item) => Boolean(item));
  // On the machine: its member asked a choice, then the User wrote to it again
  // and it answered her.
  const machineCopy = (await h.machineStorage.getConversation("cards-expiry"))!;
  machineCopy.messages.push(
    { id: "expiring-choice", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "Which store?", createdAt: askedAt, status: "done",
      metadata: { pendingChoice: { id: "choice-x", title: "Store", question: "Which store?", status: "pending", askedAt,
        options: [{ id: "sqlite", label: "SQLite" }, { id: "files", label: "Files" }] } } } as ChatMessage,
    { id: "went-on", role: "user", content: "@drew never mind, look at the tests first", createdAt: wentOnAt, status: "done" } as ChatMessage,
    { id: "went-on-reply", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "Looking.", createdAt: wentOnAt, status: "done",
      metadata: { sourceMessageId: "went-on", parentMessageId: "went-on" } } as ChatMessage
  );
  await save(h.machineChat, machineCopy);
  const cardId = choiceCardId("expiring-choice");
  await until(() => h.card(cardId), (item) => item?.state === "pending" && item.raisedBy === h.machineIdentity.originId);
  // The machine starts again (a new process, the same storage): at its start,
  // once the server's open cards are read, it closes what expired meanwhile.
  await h.machineLink.stop();
  const restarted = chatService(h.machineStorage, [], "machine");
  restarted.setHostMachineId("box");
  const restartedAppliers = appliers(h.machineStorage, restarted, h.desktopIdentity.originId, "machine-expiry");
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.machineStorage, restarted, h.machineEvents, "machine-expiry", false);
  h.links.push(link);
  await link.start();
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  const outcome = settled!.outcome as { result?: string; choice?: { status?: string; expiredAt?: string } };
  assert.equal(outcome.result, "closed", "closed without an answer");
  assert.equal(outcome.choice?.status, "cancelled");
  assert.ok(outcome.choice?.expiredAt);
  assert.equal(controlCardFromHubCard(settled!), undefined, "the phone asks nothing");
  assert.deepEqual((await h.call<{ cards: HubCard[] }>(h.desktopIdentity, "GET", "/v3/cards?conversationId=cards-expiry")).cards, [], "nothing open on the server");
  // The phone's chat shows the card under its message as expired.
  const page = await until(() => h.call<{ messages: ChatMessage[] }>(h.desktopIdentity, "GET", "/v3/chat?conversationId=cards-expiry"),
    (read) => Boolean(read.messages?.find((message) => message.id === "expiring-choice")?.metadata?.pendingChoice?.expiredAt));
  const shown = controlCardFromChoiceMessage("cards-expiry", page.messages.find((message) => message.id === "expiring-choice")!);
  assert.deepEqual([shown?.status, shown?.outcome], ["answered", "Expired"]);
  // The desktop: the card is expired and Pending lists nothing.
  const desktopCopy = await until(() => h.desktopStorage.getConversation("cards-expiry"),
    (item) => Boolean(item?.messages.find((message) => message.id === "expiring-choice")?.metadata?.pendingChoice?.expiredAt));
  assert.deepEqual(buildChatActivityItems(desktopCopy).filter((item) => item.kind === "choice" && item.status === "pending"), []);
  // An answer from the phone that crossed the expiry is refused by the server.
  const late = await h.phoneAnswers("cards-expiry", cardId, { selectedOptionId: "files" });
  assert.equal(late.result.status, "rejected");
  assert.equal(h.turns.length, 0, "the member was not started");
});

test("an answer the User gave on the phone while the machine was stopped wins over the choice's expiry when the machine starts again", async (t) => {
  const askedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const wentOnAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const h = await linkedDesktop(t, chat("cards-expiry-answered"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-expiry-answered"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-expiry-answered"))!;
  machineCopy.messages.push(
    { id: "due-choice", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "Ship now?", createdAt: askedAt, status: "done",
      metadata: { pendingChoice: { id: "choice-due", title: "Ship", question: "Ship now?", status: "pending", askedAt,
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } } } as ChatMessage,
    { id: "went-on-2", role: "user", content: "@drew first the tests", createdAt: wentOnAt, status: "done" } as ChatMessage,
    { id: "went-on-2-reply", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "On it.", createdAt: wentOnAt, status: "done",
      metadata: { sourceMessageId: "went-on-2", parentMessageId: "went-on-2" } } as ChatMessage
  );
  await save(h.machineChat, machineCopy);
  const cardId = choiceCardId("due-choice");
  await until(() => h.card(cardId), (item) => item?.state === "pending");
  // The machine stops before it looked; the User answers on the phone meanwhile.
  await h.machineLink.stop();
  assert.equal((await h.phoneAnswers("cards-expiry-answered", cardId, { selectedOptionId: "yes" })).result.status, "accepted");
  // It starts again: the choice is due to expire, and an answer waits for it.
  const restartedTurns: Turn[] = [];
  const restarted = chatService(h.machineStorage, restartedTurns, "machine");
  restarted.setHostMachineId("box");
  const restartedAppliers = appliers(h.machineStorage, restarted, h.desktopIdentity.originId, "machine-3");
  // Her answer is held at the point it is being applied, while the machine
  // looks for choices to expire.
  let entered!: () => void;
  const applying = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const apply = restartedAppliers.choice.apply.bind(restartedAppliers.choice);
  restartedAppliers.choice.apply = async (card, answerOpId) => { entered(); await released; return apply(card, answerOpId); };
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.machineStorage, restarted, h.machineEvents, "machine-3", false);
  h.links.push(link);
  await link.start();
  await applying;
  await restarted.resumeChoiceExpiry(["cards-expiry-answered"]);
  await (chatParts(restarted).choiceExpiry as unknown as { sweepChoiceExpiry(id: string): Promise<void> }).sweepChoiceExpiry("cards-expiry-answered");
  const meanwhile = (await h.machineStorage.getConversation("cards-expiry-answered"))?.messages.find((message) => message.id === "due-choice")?.metadata?.pendingChoice;
  assert.deepEqual([meanwhile?.status, meanwhile?.expiredAt], ["pending", undefined], "left to her answer");
  release();
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied", "her answer is applied");
  const choice = (await h.machineStorage.getConversation("cards-expiry-answered"))?.messages.find((message) => message.id === "due-choice")?.metadata?.pendingChoice;
  assert.deepEqual([choice?.status, choice?.selectedOptionId, choice?.expiredAt], ["selected", "yes", undefined], "not expired over her answer");
  await until(async () => restartedTurns, (turns) => turns.length === 1);
  await until(async () => restarted.liveRunIds().length, (count) => count === 0);
});

test("an answer from the phone that crosses the expiry is applied: the server refuses to close the answered card, and its machine opens it again and applies the answer", async (t) => {
  const askedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
  const wentOnAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const h = await linkedDesktop(t, chat("cards-crossed"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-crossed"), (item) => Boolean(item));
  const machineCopy = (await h.machineStorage.getConversation("cards-crossed"))!;
  machineCopy.messages.push(
    { id: "crossed-choice", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "Ship now?", createdAt: askedAt, status: "done",
      metadata: { pendingChoice: { id: "choice-crossed", title: "Ship", question: "Ship now?", status: "pending", askedAt,
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } } } as ChatMessage,
    { id: "went-on-3", role: "user", content: "@drew first the tests", createdAt: wentOnAt, status: "done" } as ChatMessage,
    { id: "went-on-3-reply", role: "participant", participantId: remote.id, participantLabel: "@drew", content: "On it.", createdAt: wentOnAt, status: "done",
      metadata: { sourceMessageId: "went-on-3", parentMessageId: "went-on-3" } } as ChatMessage
  );
  await save(h.machineChat, machineCopy);
  const cardId = choiceCardId("crossed-choice");
  await until(() => h.card(cardId), (item) => item?.state === "pending");
  const { serverCards, serverLink, choiceExpiry } = chatParts(h.machineChat);
  const link = serverLink.current as { openCards(conversationId?: string): Promise<unknown> };
  await until(async () => serverCards.book.reconciled as boolean, (done) => done);
  // The machine read the open cards just before her answer reached the server,
  // and the feed has not brought it here yet.
  const stale = await link.openCards("cards-crossed");
  const openCards = link.openCards;
  const noteEntries = serverCards.noteServerCardEntries;
  link.openCards = async () => stale;
  serverCards.noteServerCardEntries = () => undefined;
  assert.equal((await h.phoneAnswers("cards-crossed", cardId, { selectedOptionId: "yes" })).result.status, "accepted");
  await choiceExpiry.sweepChoiceExpiry("cards-crossed");
  link.openCards = openCards;
  serverCards.noteServerCardEntries = noteEntries;
  // Closed here for a moment; the server keeps her answer and refuses the close.
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied", "her answer is applied");
  assert.equal((settled!.outcome as { choice?: { status?: string } }).choice?.status, "selected", "and said so, as the choice it answered");
  const choice = (await until(() => h.machineStorage.getConversation("cards-crossed"), (item) =>
    item?.messages.find((message) => message.id === "crossed-choice")?.metadata?.pendingChoice?.status !== "pending", 5_000))
    ?.messages.find((message) => message.id === "crossed-choice")?.metadata?.pendingChoice;
  assert.deepEqual([choice?.status, choice?.selectedOptionId, choice?.expiredAt], ["selected", "yes", undefined]);
  await until(async () => h.turns, (turns) => turns.length === 1);
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.participantId]), [["machine", remote.id]], "the member went on with her answer, once");
  await until(async () => h.machineChat.liveRunIds().length, (count) => count === 0);
});

test("a cloud member's permission request allowed on the phone continues it once on its machine, and Stop on the computer stops that turn", async (t) => {
  const h = await linkedDesktop(t, chat("cards-perm-box"));
  await h.startMachine();
  await until(() => h.machineStorage.getConversation("cards-perm-box"), (item) => Boolean(item));
  let approvalId: string | undefined;
  h.machineControl.showPending = true;
  h.machineControl.during = async (turn) => {
    if (turn.participantId !== remote.id) return;
    if (!approvalId) {
      // During its turn the member asks for the permission through the app's tool, on its machine.
      const result = await h.machineChat.requestPermissionChangeFromTool({
        conversationId: "cards-perm-box", participantId: remote.id, roleConfigId: remote.roleConfigId, roleConfigVersion: 1, capabilities: ["permissions.request"],
        triggerMessageId: turn.triggerId, runId: turn.runId
      } as never, { kind: "shellRules", rules: [{ action: "allow", match: "exact", pattern: "sleep 3 && echo done" }], reason: "The User asked me to run it." });
      assert.equal(result.status, "pending_user_approval");
      approvalId = result.approvalId;
      return;
    }
    // The continued turn runs until it is stopped.
    await new Promise<void>((resolve) => {
      if (turn.signal?.aborted) return resolve();
      turn.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  await h.desktopChat.sendMessage({ conversationId: "cards-perm-box", content: "@drew run `sleep 3 && echo done` in the shell" } as never);
  const [asked] = await until(async () => h.turns, (turns) => turns.length === 1);
  assert.equal(asked.device, "machine");
  await until(async () => approvalId, (id) => Boolean(id));
  await until(() => h.card(approvalId!), (item) => item?.state === "pending" && item.raisedBy === h.machineIdentity.originId);

  assert.equal((await h.phoneAnswers("cards-perm-box", approvalId!, { approve: true })).result.status, "accepted");
  const [, resumed] = await until(async () => h.turns, (turns) => turns.length === 2);
  assert.deepEqual([resumed.device, resumed.participantId, resumed.triggerId], ["machine", remote.id, asked.triggerId], "continued once, on its machine");
  assert.notEqual(resumed.runId, asked.runId);
  const claimed = await until(() => serverTurn(h, "cards-perm-box", resumed.runId), (item) => item?.state === "claimed");
  assert.equal(claimed!.executorDeviceId, h.machineIdentity.originId, "named on the server as on its machine");

  // Stop on the computer, on the member's bubble as the computer has it.
  await until(() => h.desktopStorage.getConversation("cards-perm-box"), (item) =>
    Boolean(item?.messages.some((message) => message.metadata?.runId === resumed.runId && message.status === "pending")));
  h.desktopChat.cancelRun(resumed.runId);
  await until(async () => resumed.signal?.aborted ?? false, (aborted) => aborted);
  const stopped = await until(() => serverTurn(h, "cards-perm-box", resumed.runId), (item) => item?.state === "finished");
  assert.equal(stopped!.outcome, "stopped");
  await until(async () => h.machineChat.liveRunIds().length, (count) => count === 0);
  assert.equal(h.turns.length, 2);
});
