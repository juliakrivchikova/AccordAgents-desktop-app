import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { APP_PERMISSIONS_REQUEST_CHANGE_TOOL } from "../../shared/appMcpToolContracts";
import { mentionCardId, type HubMentionCardPayload } from "../../shared/hubCards";
import type { HubCard, HubFeedResponse, HubOp } from "../../shared/hubOps";
import { controlCardFromHubCard } from "../../shared/mobileControlCards";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import type { ChatAppToolApproval, ChatMessage, ChatParticipant } from "../../shared/types";
import { SCRIPT_CODE_APPROVED_ON_DESKTOP, cardAnswerKey } from "./machineApprovalExecutor";
import { StorageService } from "./storage";
import {
  appliers, approvalOf, at, callWaitsOn, chat, chatService, desk, linkedDesktop, remote, scriptApproval, serverTurn, toolApproval,
  type Turn, until
} from "./chat/test/cardFixtures";

/** A permission change the member asked for (web access): its answer still
 *  applies after its computer restarted, unlike a tool permission, whose
 *  answer goes to a call that ended with it. */
function grantApproval(id: string, requester: ChatParticipant, conversationId: string): ChatAppToolApproval {
  return {
    id, conversationId, requesterParticipantId: requester.id, requesterHandle: requester.handle, requesterRoleConfigId: requester.roleConfigId,
    toolName: APP_PERMISSIONS_REQUEST_CHANGE_TOOL, capability: "permissions.request", status: "pending",
    request: { kind: "portable", permissions: ["webAccess"], reason: "To read the docs." }, summary: "Grant @taylor web access", createdAt: at, updatedAt: at
  } as unknown as ChatAppToolApproval;
}

const allowedLines = async (storage: StorageService, conversationId: string) =>
  (await storage.getConversation(conversationId))?.messages.filter((message) => message.role === "system" && message.content.startsWith("Allowed @taylor to use Bash")).length ?? 0;

const grantedLines = async (storage: StorageService, conversationId: string) =>
  (await storage.getConversation(conversationId))?.messages.filter((message) => message.role === "system" && message.content.startsWith("Granted @taylor web access")).length ?? 0;

test("a desktop member's approval is raised on the server, answered from the phone and applied once on the desktop; a second answer is refused", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-a", { pendingAppToolApprovals: [toolApproval(approvalId, desk, "cards-a")] } as never),
    (setupH) => callWaitsOn(setupH.desktopChat, approvalId));
  const raised = await until(() => h.card(approvalId), (item) => item?.state === "pending");
  assert.equal(raised!.raisedBy, h.desktopIdentity.originId, "raised by the device its member runs on");
  assert.equal(raised!.cardKind, "permission");
  assert.equal(raised!.participantId, desk.id);
  assert.equal(controlCardFromHubCard(raised!)?.status, "pending", "the phone shows it to answer");

  const answered = await h.phoneAnswers("cards-a", approvalId, { approve: true });
  assert.equal(answered.result.status, "accepted");
  const settled = await until(() => h.card(approvalId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  assert.equal((await approvalOf(h.desktopStorage, "cards-a", approvalId))?.status, "approved");
  assert.equal(await allowedLines(h.desktopStorage, "cards-a"), 1, "applied once");
  const claim = await h.desktopStorage.nativeCommands().approvalEffect("cards-a", approvalId);
  assert.equal(claim?.eventId, cardAnswerKey(settled!), "claimed once, by that answer");

  const second = await h.phoneAnswers("cards-a", approvalId, { approve: false });
  assert.equal(second.result.status, "rejected", "the first answer is the one");
  assert.match((second.result as { reason: string }).reason, /already answered/);
  // Read again (a reconnect): nothing is applied twice.
  await h.desktopChat.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await allowedLines(h.desktopStorage, "cards-a"), 1);
  // The desktop's own card answered again is refused with the server's (or
  // its own) word, never applied.
  await assert.rejects(h.desktopChat.answerAppToolApprovalCard({ conversationId: "cards-a", approvalId, approve: true }), /already been answered/);
});

test("an answer given while the member's computer was off is applied once when it starts again; one that crossed its point of no return is not repeated", async (t) => {
  const first = randomUUID();
  const second = randomUUID();
  const h = await linkedDesktop(t, chat("cards-b", { pendingAppToolApprovals: [grantApproval(first, desk, "cards-b"), grantApproval(second, desk, "cards-b")] } as never));
  await until(() => Promise.all([h.card(first), h.card(second)]), (cards) => cards.every((item) => item?.state === "pending"));
  // The computer stops; the User answers both on the phone meanwhile.
  await h.desktopLink.stop();
  assert.equal((await h.phoneAnswers("cards-b", first, { approve: true })).result.status, "accepted");
  assert.equal((await h.phoneAnswers("cards-b", second, { approve: true })).result.status, "accepted");
  // The runtime that stopped had taken the second answer to the provider
  // already, and never confirmed it: its claim is on disk.
  const secondCard = await h.card(second);
  await h.desktopStorage.nativeCommands().claimApproval({ conversationId: "cards-b", approvalId: second, participantId: desk.id,
    eventId: cardAnswerKey(secondCard!), runtimeId: "the-runtime-that-stopped", pid: 1, startedAt: "earlier" });
  // It starts again: a new process, the same storage.
  const turns: Turn[] = [];
  const restarted = chatService(h.desktopStorage, turns, "desktop");
  const restartedAppliers = appliers(h.desktopStorage, restarted, h.desktopIdentity.originId, "desktop-2");
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.desktopStorage, restarted, h.desktopEvents, "desktop-2", true);
  h.links.push(link);
  await link.start();
  const done = await until(() => Promise.all([h.card(first), h.card(second)]), (cards) => cards.every((item) => item?.state === "settled"));
  assert.equal((done[0]!.outcome as { result?: string }).result, "applied");
  assert.equal((await approvalOf(h.desktopStorage, "cards-b", first))?.status, "approved");
  assert.equal((done[1]!.outcome as { result?: string }).result, "uncertain", "said as not confirmed");
  const stuck = await approvalOf(h.desktopStorage, "cards-b", second);
  assert.equal(stuck?.status, "cancelled", "closed, never asked again");
  assert.match(stuck?.error ?? "", /not repeated/);
  assert.equal(await grantedLines(h.desktopStorage, "cards-b"), 1, "only the first was applied, once");
  // Started again: nothing more.
  await restarted.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await grantedLines(h.desktopStorage, "cards-b"), 1);
  assert.deepEqual((await h.call<{ cards: HubCard[] }>(h.desktopIdentity, "GET", "/v3/cards?conversationId=cards-b")).cards, [], "nothing left open");
});

test("a tool permission card whose call ended with the computer is expired when it starts again; an answer given meanwhile is not applied", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-tp", { pendingAppToolApprovals: [toolApproval(approvalId, desk, "cards-tp")] } as never),
    (setupH) => callWaitsOn(setupH.desktopChat, approvalId));
  await until(() => h.card(approvalId), (item) => item?.state === "pending");
  await h.desktopLink.stop();
  assert.equal((await h.phoneAnswers("cards-tp", approvalId, { approve: true })).result.status, "accepted");
  // A new process: Claude Code's call that waited on the card is gone.
  const restarted = chatService(h.desktopStorage, [], "desktop");
  const restartedAppliers = appliers(h.desktopStorage, restarted, h.desktopIdentity.originId, "desktop-2");
  restarted.setCardAppliers(async () => restartedAppliers);
  const link = h.link(h.desktopStorage, restarted, h.desktopEvents, "desktop-2", true);
  h.links.push(link);
  await link.start();
  await until(() => h.card(approvalId), (item) => item?.state === "settled");
  const after = await approvalOf(h.desktopStorage, "cards-tp", approvalId);
  assert.equal(after?.status, "expired", "said as expired, never as allowed");
  assert.equal(await allowedLines(h.desktopStorage, "cards-tp"), 0, "nothing was allowed into a call that ended");
});

test("the phone's approval of a script that installs code is refused, the card asked again with why; the desktop's approval applies it once", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-c", { pendingAppToolApprovals: [scriptApproval(approvalId, "cards-c")] } as never));
  await until(() => h.card(approvalId), (item) => item?.state === "pending");
  const phoneAnswer = await h.phoneAnswers("cards-c", approvalId, { approve: true });
  assert.equal(phoneAnswer.result.status, "accepted", "the server takes any device's answer");
  // Refused where the member runs: settled with why, then asked again.
  const again = await until(() => h.card(approvalId), (item) => item?.state === "pending" && Array.isArray((item.card as { refusals?: unknown[] }).refusals));
  const refusals = (again!.card as { refusals: Array<{ operationId: string; reason: string }> }).refusals;
  assert.deepEqual(refusals.map((item) => [item.operationId, item.reason]), [[phoneAnswer.opId, SCRIPT_CODE_APPROVED_ON_DESKTOP]]);
  assert.equal(again!.answer, undefined);
  const shown = controlCardFromHubCard(again!);
  assert.deepEqual(shown?.refusedAnswers, [{ operationId: phoneAnswer.opId, reason: SCRIPT_CODE_APPROVED_ON_DESKTOP }], "the phone that sent it says why");
  assert.equal(h.scripts.applied, 0, "nothing was installed");
  const feed = await h.call<HubFeedResponse>(h.desktopIdentity, "GET", "/v3/feed?after=0");
  const refusedSettle = feed.entries.find((entry) => entry.effect.kind === "card.settle" && entry.effect.card.cardId === approvalId);
  assert.equal(((refusedSettle?.effect as { card: HubCard }).card.outcome as { result?: string; answerOpId?: string }).result, "refused");
  const local = await approvalOf(h.desktopStorage, "cards-c", approvalId);
  assert.equal(local?.status, "pending", "still waiting for the desktop");
  assert.equal(local?.cardRefusals?.[0].reason, SCRIPT_CODE_APPROVED_ON_DESKTOP, "the desktop card says why too");
  // The desktop approves it, where the code is shown.
  await h.desktopChat.answerAppToolApprovalCard({ conversationId: "cards-c", approvalId, approve: true });
  assert.equal(h.scripts.applied, 1, "applied once, before the answer returned");
  assert.equal((await approvalOf(h.desktopStorage, "cards-c", approvalId))?.status, "approved");
  await until(() => h.card(approvalId), (item) => item?.state === "settled");
  assert.equal(h.scripts.applied, 1);
});

test("a desktop member's mentions waiting for approval are a card: approved on the desktop, the members it names are asked once", async (t) => {
  const asking: ChatMessage = {
    id: "mention-h", role: "participant", participantId: desk.id, participantLabel: "@taylor", content: "@drew please check this.", createdAt: at,
    status: "done", metadata: { mentions: ["drew"], pendingMentions: [{ targetParticipantId: remote.id, targetHandle: "drew", status: "pending" }] }
  } as ChatMessage;
  const h = await linkedDesktop(t, chat("cards-h", {}, [asking]));
  await h.startMachine();
  const cardId = mentionCardId("mention-h");
  const raised = await until(() => h.card(cardId), (item) => item?.state === "pending");
  assert.equal(raised!.cardKind, "mention");
  assert.equal(raised!.participantId, desk.id);
  assert.equal(raised!.messageId, "mention-h");
  assert.deepEqual((raised!.card as unknown as HubMentionCardPayload).mentions.map((mention) => mention.targetParticipantId), [remote.id]);
  assert.equal(controlCardFromHubCard(raised!), undefined, "the phone does not show mention approvals");
  await h.desktopChat.answerMentionsCard({ conversationId: "cards-h", sourceMessageId: "mention-h", targetParticipantIds: [remote.id], approve: true });
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  const message = (await h.desktopStorage.getConversation("cards-h"))?.messages.find((item) => item.id === "mention-h");
  assert.deepEqual(message?.metadata?.pendingMentions?.map((mention) => mention.status), ["approved"]);
  const claim = await h.desktopStorage.nativeCommands().targetEffect("cards-h", `${cardId}:${remote.id}`);
  assert.equal(claim?.eventId, cardAnswerKey(settled!), "claimed once, by that answer");
  await assert.rejects(h.desktopChat.answerMentionsCard({ conversationId: "cards-h", sourceMessageId: "mention-h", targetParticipantIds: [remote.id], approve: true }),
    /already answered/);
  // The member it names was asked once, where it runs.
  await until(async () => h.turns, (turns) => turns.length === 1);
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.participantId]), [["machine", remote.id]]);
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
  assert.equal(h.turns.length, 1);
});

test("an answer refused after a restart still says why to the device that gave it", async (t) => {
  const approvalId = randomUUID();
  const h = await linkedDesktop(t, chat("cards-i", { pendingAppToolApprovals: [scriptApproval(approvalId, "cards-i")] } as never));
  await until(() => h.card(approvalId), (item) => item?.state === "pending");
  await h.desktopLink.stop();
  const phoneAnswer = await h.phoneAnswers("cards-i", approvalId, { approve: true });
  assert.equal(phoneAnswer.result.status, "accepted");
  assert.equal((await h.card(approvalId))?.answerOpId, phoneAnswer.opId, "the server keeps the operation the answer came in");
  // The computer starts again and reads the answered card from the server
  // (not from the feed): its refusal names the phone's operation.
  const restarted = chatService(h.desktopStorage, [], "desktop");
  const restartedAppliers = appliers(h.desktopStorage, restarted, h.desktopIdentity.originId, "desktop-3");
  restarted.setCardAppliers(async () => restartedAppliers);
  restarted.setScriptHost({ async assertApprovable() { return undefined; }, async applyApproved() { h.scripts.applied += 1; return "Saved."; },
    async rejectPending() { h.scripts.rejected += 1; } } as never);
  const link = h.link(h.desktopStorage, restarted, h.desktopEvents, "desktop-3", true);
  h.links.push(link);
  await link.start();
  const again = await until(() => h.card(approvalId), (item) => item?.state === "pending" && Array.isArray((item.card as { refusals?: unknown[] }).refusals));
  assert.deepEqual((again!.card as { refusals: Array<{ operationId: string; reason: string }> }).refusals.map((item) => [item.operationId, item.reason]),
    [[phoneAnswer.opId, SCRIPT_CODE_APPROVED_ON_DESKTOP]]);
  assert.equal(again!.answerOpId, undefined, "asked again from the start");
  assert.equal(h.scripts.applied, 0);
});

test("mentions approved one member at a time: each answer is applied once and the card is asked again for the rest", async (t) => {
  const third: ChatParticipant = { id: "33333333-3333-4333-8333-333333333333", handle: "morgan", roleConfigId: "software-engineer", kind: "claude-code",
    permissions: normalizeChatAgentPermissions(defaultChatAgentPermissions()) };
  const asking: ChatMessage = {
    id: "mention-j", role: "participant", participantId: desk.id, participantLabel: "@taylor", content: "@drew and @morgan please check this.", createdAt: at,
    status: "done", metadata: { mentions: ["drew", "morgan"], pendingMentions: [
      { targetParticipantId: remote.id, targetHandle: "drew", status: "pending" },
      { targetParticipantId: third.id, targetHandle: "morgan", status: "pending" }
    ] }
  } as ChatMessage;
  const h = await linkedDesktop(t, chat("cards-j", { participants: [desk, remote, third] } as never, [asking]));
  await h.startMachine();
  const cardId = mentionCardId("mention-j");
  await until(() => h.card(cardId), (item) => item?.state === "pending");
  // "Ask @morgan" on the desktop: morgan is asked; the card asks again for @drew.
  await h.desktopChat.answerMentionsCard({ conversationId: "cards-j", sourceMessageId: "mention-j", targetParticipantIds: [third.id], approve: true });
  const again = await until(() => h.card(cardId), (item) => item?.state === "pending" &&
    (item.card as unknown as HubMentionCardPayload).mentions.length === 1);
  assert.deepEqual((again!.card as unknown as HubMentionCardPayload).mentions.map((mention) => mention.targetParticipantId), [remote.id], "asked again for the rest");
  // "Ask @drew" from the phone this time.
  assert.equal((await h.phoneAnswers("cards-j", cardId, { approve: true, targetParticipantIds: [remote.id] })).result.status, "accepted");
  const settled = await until(() => h.card(cardId), (item) => item?.state === "settled");
  assert.equal((settled!.outcome as { result?: string }).result, "applied");
  const message = (await h.desktopStorage.getConversation("cards-j"))?.messages.find((item) => item.id === "mention-j");
  assert.deepEqual(message?.metadata?.pendingMentions?.map((mention) => [mention.targetParticipantId, mention.status]),
    [[remote.id, "approved"], [third.id, "approved"]]);
  await until(async () => h.turns, (turns) => turns.length === 2);
  assert.deepEqual(h.turns.map((turn) => [turn.device, turn.participantId]).sort(), [["desktop", third.id], ["machine", remote.id]].sort(),
    "each member asked once, where it runs");
  await until(async () => h.desktopChat.liveRunIds().length + h.machineChat.liveRunIds().length, (count) => count === 0);
  assert.equal(h.turns.length, 2);
});

/** The User asks a desktop member to run a shell command it may not run yet;
 *  during that turn its CLI asks for the permission through the app's tool, as
 *  a member does. Resolves with that turn and the card it raised. */
async function memberAsksForShell(h: Awaited<ReturnType<typeof linkedDesktop>>, conversationId: string) {
  let approvalId: string | undefined;
  h.desktopControl.during = async (turn) => {
    if (turn.participantId !== desk.id || approvalId) return;
    const result = await h.desktopChat.requestPermissionChangeFromTool({
      conversationId, participantId: desk.id, roleConfigId: desk.roleConfigId, roleConfigVersion: 1, capabilities: ["permissions.request"],
      triggerMessageId: turn.triggerId, runId: turn.runId
    } as never, { kind: "shellRules", rules: [{ action: "allow", match: "exact", pattern: "sleep 3 && echo done" }], reason: "The User asked me to run it." });
    assert.equal(result.status, "pending_user_approval");
    approvalId = result.approvalId;
  };
  await h.desktopChat.sendMessage({ conversationId, content: "@taylor run `sleep 3 && echo done` in the shell" } as never);
  const [asked] = await until(async () => h.turns, (turns) => turns.length === 1);
  await until(() => h.call<{ turns?: Array<{ runId: string; state: string }> }>(h.desktopIdentity, "GET", `/v3/chat?conversationId=${conversationId}`),
    (page) => Boolean(page.turns?.some((item) => item.runId === asked.runId && item.state === "finished")));
  assert.ok(approvalId, "the member asked for the permission during its turn");
  await until(() => h.card(approvalId!), (item) => item?.state === "pending");
  h.desktopControl.during = undefined;
  return { asked, approvalId: approvalId! };
}

test("Allow on a desktop member's permission request continues the member in a new turn on the server, and it runs to its end", async (t) => {
  const h = await linkedDesktop(t, chat("cards-perm-desk"));
  const { asked, approvalId } = await memberAsksForShell(h, "cards-perm-desk");

  await h.desktopChat.respondToAppToolApproval({ conversationId: "cards-perm-desk", approvalId, approve: true });
  const [, resumed] = await until(async () => h.turns, (turns) => turns.length === 2);
  assert.deepEqual([resumed.device, resumed.participantId, resumed.triggerId], ["desktop", desk.id, asked.triggerId], "the member continues from the message that asked it");
  assert.notEqual(resumed.runId, asked.runId, "not the turn that asked for the permission, which is over");
  // Named here as on the server, so every device names it the same way.
  const finished = await until(() => serverTurn(h, "cards-perm-desk", resumed.runId), (item) => item?.state === "finished");
  assert.deepEqual([finished!.outcome, finished!.executorDeviceId, finished!.messageId], ["done", h.desktopIdentity.originId, asked.triggerId]);
  const replies = await until(() => h.desktopStorage.getConversation("cards-perm-desk"), (item) =>
    (item?.messages.filter((message) => message.role === "participant" && message.status === "done").length ?? 0) === 2);
  assert.equal(replies!.messages.filter((message) => message.content === "Auto-resumed @taylor after permission approval.").length, 1);
  await until(async () => h.desktopChat.liveRunIds().length, (count) => count === 0);
  assert.equal(h.turns.length, 2, "continued once");
});

test("Allow on the phone continues a desktop member once in its own turn, which a Stop from the phone stops", async (t) => {
  const h = await linkedDesktop(t, chat("cards-perm-phone"));
  const { asked, approvalId } = await memberAsksForShell(h, "cards-perm-phone");
  // The continued turn runs until it is stopped.
  h.desktopControl.during = (turn) => new Promise<void>((resolve) => {
    if (turn.signal?.aborted) return resolve();
    turn.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

  assert.equal((await h.phoneAnswers("cards-perm-phone", approvalId, { approve: true })).result.status, "accepted");
  const [, resumed] = await until(async () => h.turns, (turns) => turns.length === 2);
  assert.deepEqual([resumed.device, resumed.participantId, resumed.triggerId], ["desktop", desk.id, asked.triggerId]);
  const serverRunId = resumed.runId;
  const claimed = await until(() => serverTurn(h, "cards-perm-phone", serverRunId), (item) => item?.state === "claimed");
  assert.equal(claimed!.executorDeviceId, h.desktopIdentity.originId, "every device sees it running on the computer");

  // The answer read again (a reconnect, a second answer) starts nothing more.
  assert.equal((await h.phoneAnswers("cards-perm-phone", approvalId, { approve: true })).result.status, "rejected");
  await h.desktopChat.resumeServerCards();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.turns.length, 2, "continued once");

  // The phone names the run as its row does (turnOfRun), with the message it
  // answers and its member.
  const stop: HubOp = { opId: `op-${randomUUID()}`, kind: "turn.stop", conversationId: "cards-perm-phone", runId: serverRunId, messageId: asked.triggerId, participantId: desk.id };
  assert.equal((await h.phoneHub.writeOps([stop])).results[0].status, "accepted");
  await until(async () => resumed.signal?.aborted ?? false, (aborted) => aborted);
  const stopped = await until(() => serverTurn(h, "cards-perm-phone", serverRunId), (item) => item?.state === "finished");
  assert.equal(stopped!.outcome, "stopped");
  await until(async () => h.desktopChat.liveRunIds().length, (count) => count === 0);
  assert.equal(h.turns.length, 2);
});
