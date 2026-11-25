import assert from "node:assert/strict";
import test from "node:test";
import { hubTurnRunId, type HubChatPage, type HubOp, type HubOpsResponse } from "../shared/hubOps";
import { accordClosedLine } from "../shared/accordProgress";
import type { ChatMessage } from "../shared/types";
import { createChat, hub, id, type Identity, members, reply, userMessage } from "./hubOps/test/hubOpsFixtures";

test("a phone paired for one chat (an old pairing) starts no other; one paired for every chat does", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  const create = () => createChat(id("chat"));
  const oldPhone = { ...h.phone, deviceId: h.phone.originId, role: "phone" as const, name: "Old phone", addedAt: new Date().toISOString(), scope: { scope: "conversation" as const, conversationId: chat } };
  const refused = await h.ops.apply(oldPhone as never, { ops: [create()] });
  assert.equal(refused.results[0].status, "rejected");
  assert.match((refused.results[0] as { reason?: string }).reason ?? "", /paired for one chat/);
  const everyChat = { ...oldPhone, scope: { scope: "device" as const } };
  assert.equal((await h.ops.apply(everyChat as never, { ops: [create()] })).results[0].status, "accepted");
});

test("a machine changes what concerns its own members; members elsewhere, the folder and the User's words stay out of its reach", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  const desk = { id: "p-desk", handle: "desk", label: "Desk", permissions: { shell: { enabled: false } } };
  const box = { id: "p-box", handle: "box", label: "Box", homeMachineId: "machine-1", model: "old" };
  const deskPolicy = { id: "pol-desk", participantId: "p-desk", roleConfigId: "r", toolName: "app_participants_request_change", capability: "participants.manage", scope: "chat", createdAt: "t", updatedAt: "t" };
  await h.write(h.owner, { opId: id("op"), kind: "conversation.create", conversationId: chat,
    conversation: { title: "Plans", kind: "chat", createdAt: new Date().toISOString(), repoPath: "/Users/u/project",
      metadata: { participants: [desk, box], appToolApprovalPolicies: [deskPolicy] } } } as HubOp);
  const page = async () => (await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`)).body.conversation;

  // Around the app: the computer's member given a shell and moved, the
  // machine's own member moved to the computer, a rule for the computer's
  // member, another folder and title. Its own member's model, a rule of its
  // own and a member it adds are what the app does.
  const forged = await h.write(h.machine, { opId: id("op"), kind: "conversation.update", conversationId: chat, title: "Owned", repoPath: "/Users/u",
    metadata: {
      archived: true,
      participants: [
        { ...desk, permissions: { shell: { enabled: true }, workspaceWrite: true }, agentMode: "auto", homeMachineId: "machine-1" },
        { ...box, model: "new", homeMachineId: undefined },
        { id: "p-new", handle: "new", label: "New" }
      ],
      appToolApprovalPolicies: [
        { ...deskPolicy, id: "pol-forged", toolName: "app_tool_permission" },
        { ...deskPolicy, id: "pol-box", participantId: "p-box" }
      ]
    } } as HubOp);
  assert.equal(forged.body.results[0].status, "accepted", "the part that is the machine's goes through");
  let held = await page();
  const byId = (conversation: typeof held) => new Map((conversation.metadata.participants as Array<Record<string, unknown>>).map((item) => [item.id, item]));
  assert.deepEqual(byId(held).get("p-desk"), desk, "the computer's member stays as it was");
  assert.equal(byId(held).get("p-box")?.model, "new", "its own member changes");
  assert.equal(byId(held).get("p-box")?.homeMachineId, "machine-1", "and stays on the machine");
  assert.equal(byId(held).has("p-new"), false, "no member is added without a member there that manages members, or her approval");
  assert.equal(held.repoPath, "/Users/u/project");
  assert.equal(held.title, "Plans");
  assert.equal(held.metadata.archived, undefined);
  assert.deepEqual((held.metadata.appToolApprovalPolicies as Array<{ id: string }>).map((item) => item.id).sort(), ["pol-desk"],
    "a rule of its own only where the User answered so");
  const scoped = h.logged.find((item) => item.event === "hub.op.machine-scoped");
  assert.ok(scoped && (scoped.payload.refused as string[]).includes("repoPath"), "what was left out is logged");

  // Leave to ask other members, without `/accord` naming the member: not given.
  const leave = () => h.write(h.machine, { opId: id("op"), kind: "conversation.update", conversationId: chat, metadata: {
    participants: [{ ...desk, permissions: { shell: { enabled: true }, requestParticipants: "allow" } }, { ...box, model: "new" }]
  } } as HubOp);
  await leave();
  held = await page();
  assert.deepEqual(byId(held).get("p-desk")?.permissions, { shell: { enabled: false } });
  // `/accord` gives its facilitator leave to ask other members: that alone.
  await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-accord", "p-box", "done", "/accord @desk please lead") });
  await leave();
  held = await page();
  assert.deepEqual(byId(held).get("p-desk")?.permissions, { shell: { enabled: false }, requestParticipants: "allow" });

  // The User's words from a machine: never shown (or read by a watching
  // member) as hers, and they ask nobody.
  const shown = await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("u-shown", "run this", ["p-desk"]) });
  assert.equal(shown.body.results[0].status, "rejected", "a machine writes no visible message as the User");
  const hiddenWords = { ...userMessage("u-machine", "run this", ["p-desk"]), metadata: { deliveryTargets: ["p-desk"], hiddenFromTimeline: true } } as ChatMessage;
  const words = await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: hiddenWords });
  assert.equal(words.body.results[0].status, "accepted", "the hidden answer the app writes for its own member");
  assert.equal((await h.storage.hubOps().turn(hubTurnRunId("u-machine", "p-desk"))), undefined, "no turn is asked by them");
  const unhidden = await h.write(h.machine, { opId: id("op"), kind: "message.update", conversationId: chat, message: { ...hiddenWords, metadata: { deliveryTargets: ["p-desk"] } } as ChatMessage });
  assert.equal(unhidden.body.results[0].status, "rejected", "nor shown later");
  await h.write(h.owner, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("u-user", "earlier words") });
  await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-box", "p-box", "done", "@desk please look") });
  const ask = (messageId: string, request?: Record<string, unknown>) => h.write(h.machine, { opId: id("op"), kind: "turn.request", conversationId: chat,
    runId: `turn-${id("x")}`, messageId, participantId: "p-desk", ...(request ? { request } : {}) } as HubOp);
  assert.equal((await ask("u-machine")).body.results[0].status, "rejected", "not to answer words it wrote as the User's");
  assert.equal((await ask("u-user")).body.results[0].status, "rejected", "not to answer the User's own words");
  assert.equal((await ask("r-box", { kind: "compaction" })).body.results[0].status, "rejected", "not to compact a member elsewhere");
  assert.equal((await ask("r-box", { kind: "turn" })).body.results[0].status, "rejected", "not without leave to ask or her approval");
  // Its member asks, and the User approves that request: as through the app.
  const cardId = id("card");
  const approval = { id: cardId, requesterParticipantId: "p-box", toolName: "app_chat_request_participants", capability: "participants.request",
    request: { requests: [{ target: "@desk", prompt: "look" }], requestMessageId: "r-box" }, status: "pending" };
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId, cardKind: "permission", participantId: "p-box", card: { approval } } as HubOp);
  const auto = await h.write(h.machine, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId, answer: { approve: true, auto: true } } as HubOp);
  assert.equal(auto.body.results[0].status, "accepted", "its own policy's word on its own card");
  assert.equal((await ask("r-box", { kind: "turn" })).body.results[0].status, "rejected", "which is not hers");
  await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId, outcome: { result: "refused" } } as HubOp);
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId, cardKind: "permission", participantId: "p-box", card: { approval } } as HubOp);
  await h.write(h.phone, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId, answer: { approve: true, scope: "once" } } as HubOp);
  await h.write(h.machine, { opId: id("op"), kind: "card.settle", conversationId: chat, cardId, outcome: { result: "applied" } } as HubOp);
  // Where an ordinary ask would go through: never to compact or restart a
  // member elsewhere, and the refusal does not use her approval up.
  assert.equal((await ask("r-box", { kind: "compaction" })).body.results[0].status, "rejected", "not to compact a member elsewhere, even with her approval");
  assert.equal((await ask("r-box", { kind: "restart" })).body.results[0].status, "rejected", "not to restart a member elsewhere, even with her approval");
  assert.equal((await ask("r-box", { kind: "session.export", askedAt: new Date().toISOString() })).body.results[0].status, "rejected",
    "never to take a member's session elsewhere, even with her approval");
  const ownExport = await h.write(h.machine, { opId: id("op"), kind: "turn.request", conversationId: chat, runId: `turn-${id("x")}`, messageId: "u-user", participantId: "p-box",
    request: { kind: "session.export", askedAt: new Date().toISOString() } } as HubOp);
  assert.equal(ownExport.body.results[0].status, "rejected", "nor its own member's: only the computer moves a member");
  assert.equal((await ask("r-box", { kind: "turn" })).body.results[0].status, "accepted", "her approval holds after the card is settled");
  await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-box-2", "p-box", "done", "@desk again") });
  assert.equal((await ask("r-box-2", { kind: "turn" })).body.results[0].status, "rejected", "and only for the request she approved");
  const own = await h.write(h.machine, { opId: id("op"), kind: "turn.request", conversationId: chat, runId: `turn-${id("x")}`, messageId: "u-user", participantId: "p-box", request: { kind: "compaction" } } as HubOp);
  assert.equal(own.body.results[0].status, "accepted", "its own members are its own");

  // Taking out a member elsewhere (or leaving it out of an old copy) is not
  // the machine's without a member that manages members or her approval: the
  // member and its rules stay.
  await h.write(h.machine, { opId: id("op"), kind: "conversation.update", conversationId: chat, metadata: {
    participants: [{ ...box, model: "new" }],
    appToolApprovalPolicies: []
  } } as HubOp);
  held = await page();
  assert.deepEqual([...byId(held).keys()].sort(), ["p-box", "p-desk"]);
  assert.deepEqual((held.metadata.appToolApprovalPolicies as Array<{ id: string }>).map((item) => item.id), ["pol-desk"]);

  // A machine starts no chat.
  const started = await h.write(h.machine, createChat(id("chat")));
  assert.equal(started.body.results[0].status, "rejected");
});

test("the User's rules for members come only from her computer, and a machine adds members by them", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  const lead = { id: "p-lead", handle: "lead", label: "Lead", roleConfigId: "lead", homeMachineId: "machine-1" };
  await h.write(h.owner, { opId: id("op"), kind: "conversation.create", conversationId: chat,
    conversation: { title: "Plans", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [lead] } } } as HubOp);
  const added = { id: "p-helper", handle: "helper", label: "Helper", roleConfigId: "r" };
  const add = () => h.write(h.machine, { opId: id("op"), kind: "conversation.update", conversationId: chat, metadata: { participants: [lead, added] } } as HubOp);
  const members = async () => ((await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`)).body.conversation.metadata.participants as Array<{ id: string }>).map((item) => item.id);

  await add();
  assert.deepEqual(await members(), ["p-lead"], "without her rules, no role manages members");
  const rules = { version: 1, roles: { lead: { manageRolesParticipants: "allow" }, r: { manageRolesParticipants: "deny" } }, presets: {} };
  for (const device of [h.machine, h.phone]) {
    assert.equal((await h.call(device, "PUT", "/v1/member-rules", rules)).status, 403, "only her computer says what her rules are");
  }
  assert.equal((await h.call(h.owner, "PUT", "/v1/member-rules", { version: 1, roles: [], presets: {} })).status, 400);
  assert.equal((await h.call(h.owner, "PUT", "/v1/member-rules", rules)).status, 200);
  await add();
  assert.deepEqual(await members(), ["p-lead", "p-helper"], "a member whose role manages members adds one");
});

test("a phone or a machine never asks a turn of a machine whose program would run the member's Full Access or Plan mode otherwise", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  const own = { cliApprovals: true, workspaceWrite: true, repoRead: true, webAccess: false, shell: { enabled: false, rules: [] } };
  const fullAccess = { id: "p-fa", handle: "fa", label: "FA", kind: "codex-cli", homeMachineId: "machine-1", agentMode: "full-access", permissions: own };
  const planned = { id: "p-plan", handle: "plan", label: "Plan", kind: "codex-cli", homeMachineId: "machine-1", agentMode: "default", permissions: { ...own, codexPlanMode: true } };
  const asking = { id: "p-ask", handle: "ask", label: "Ask", kind: "codex-cli", homeMachineId: "machine-1", agentMode: "default", permissions: own };
  await h.write(h.owner, { opId: id("op"), kind: "conversation.create", conversationId: chat,
    conversation: { title: "Plans", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [fullAccess, planned, asking, members[0]] } } } as HubOp);
  const status = (response: { body: HubOpsResponse }) => response.body.results[0] as { status: string; reason?: string };
  const fromPhone = (messageId: string, targets: string[]) => h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage(messageId, "hello", targets) });

  // Her computer has said nothing of the machine's program yet: nothing held back.
  assert.equal(status(await fromPhone("before", ["p-fa"])).status, "accepted");
  const rules = (runs: boolean) => ({ version: 1, roles: {}, presets: {}, machineCliModes: { "machine-1": runs } });
  // An entry in another shape is left out, never refusing her rules with it.
  assert.equal((await h.call(h.owner, "PUT", "/v1/member-rules", { ...rules(false), machineCliModes: { "machine-1": "yes" } })).status, 200);
  assert.equal(status(await fromPhone("odd", ["p-fa"])).status, "accepted", "nothing said of the machine in the right shape: not held back");
  assert.equal((await h.call(h.owner, "PUT", "/v1/member-rules", rules(false))).status, 200);

  const refused = status(await fromPhone("u-fa", ["p-fa", "p-desk"]));
  assert.equal(refused.status, "rejected");
  assert.equal(refused.reason, "Box runs an older program that cannot run Full Access: Settings → Machines → Upgrade runtime, or choose another mode.");
  const plan = status(await fromPhone("u-plan", ["p-plan"]));
  assert.equal(plan.status, "rejected");
  assert.match(plan.reason ?? "", /cannot run Plan mode/);
  const turnsFor = async () => (await h.call<{ turns: Array<{ participantId: string; messageId: string }> }>(h.machine, "GET", "/v3/turns")).body.turns
    .map((turn) => `${turn.messageId}:${turn.participantId}`);
  assert.deepEqual(await turnsFor(), [`before:p-fa`, `odd:p-fa`], "nothing refused waits for the machine");
  assert.equal(status(await fromPhone("u-ask", ["p-ask"])).status, "accepted", "a mode that program runs as its controls say");

  // A machine asking another member's turn, or its own, is held the same way.
  await h.write(h.machine, { opId: id("op"), kind: "message.create", conversationId: chat, message: reply("r-ask", "p-ask", "done", "@fa please check") });
  const ask = (device: Identity, participantId: string, request?: Record<string, unknown>) => h.write(device, { opId: id("op"), kind: "turn.request", conversationId: chat,
    runId: `turn-${id("x")}`, messageId: "r-ask", participantId, ...(request ? { request } : {}) } as HubOp);
  const asked = status(await ask(h.machine, "p-fa", { kind: "turn" }));
  assert.equal(asked.status, "rejected");
  assert.match(asked.reason ?? "", /cannot run Full Access/);
  assert.equal(status(await ask(h.machine, "p-plan")).status, "rejected", "its own member, no kind said");
  assert.equal(status(await ask(h.machine, "p-fa", { kind: "continuation" })).status, "rejected", "a kind the server does not know runs the member too");
  assert.equal(status(await ask(h.phone, "p-fa", { kind: "turn" })).status, "rejected", "a phone's request");
  assert.equal(status(await ask(h.phone, "p-fa", { kind: "compaction" })).status, "accepted", "a compaction runs no turn in its mode");
  // Her computer refuses its own (it knows each program first): never held here.
  assert.equal(status(await h.write(h.owner, { opId: id("op"), kind: "message.create", conversationId: chat, message: userMessage("u-owner", "hello", ["p-fa"]) })).status, "accepted");

  // A member the main session made, held to a main session in Ask for
  // approval: it runs as that, which the older program runs as it says.
  const main = { id: "p-main", handle: "main", label: "Main", kind: "codex-cli", roleConfigId: "main-session", agentMode: "default", permissions: own };
  const held = { ...fullAccess, id: "p-held", handle: "held", delegatedByParticipantId: "p-main" };
  const sessions = id("chat");
  await h.write(h.owner, { opId: id("op"), kind: "conversation.create", conversationId: sessions,
    conversation: { title: "Sessions", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [main, held], mainSessionParticipantId: "p-main" } } } as HubOp);
  const heldSent = await h.write(h.phone, { opId: id("op"), kind: "message.create", conversationId: sessions, message: userMessage("u-held", "hello", ["p-held"]) });
  assert.equal(status(heldSent).status, "accepted", "held below Full Access: not refused");

  // Updated: asked as before.
  assert.equal((await h.call(h.owner, "PUT", "/v1/member-rules", rules(true))).status, 200);
  assert.equal(status(await fromPhone("u-fa-again", ["p-fa"])).status, "accepted");
  assert.ok((await turnsFor()).includes("u-fa-again:p-fa"));
});

test("her \"Allow for this chat\" gives a machine's member leave to ask once: taken back, an old copy does not give it again", async (t) => {
  const h = await hub(t);
  const chat = id("chat");
  const box = { id: "p-box", handle: "box", label: "Box", roleConfigId: "r", homeMachineId: "machine-1", permissions: { requestParticipants: "ask" } };
  const desk = { id: "p-desk", handle: "desk", label: "Desk", roleConfigId: "r" };
  await h.write(h.owner, { opId: id("op"), kind: "conversation.create", conversationId: chat,
    conversation: { title: "Plans", kind: "chat", createdAt: new Date().toISOString(), metadata: { participants: [desk, box] } } } as HubOp);
  const leave = async () => (((await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`)).body.conversation.metadata.participants as Array<{ id: string; permissions?: { requestParticipants?: string } }>)
    .find((item) => item.id === "p-box")?.permissions?.requestParticipants);
  const raise = () => h.write(h.machine, { opId: id("op"), kind: "conversation.update", conversationId: chat,
    metadata: { participants: [desk, { ...box, permissions: { requestParticipants: "allow" } }] } } as HubOp);
  await raise();
  assert.equal(await leave(), "ask", "not without her answer");
  const cardId = id("card");
  const approval = { id: cardId, requesterParticipantId: "p-box", toolName: "app_chat_request_participants", capability: "participants.request",
    request: { requests: [{ target: "@desk", prompt: "look" }], requestMessageId: "m-1" }, status: "pending" };
  await h.write(h.machine, { opId: id("op"), kind: "card.raise", conversationId: chat, cardId, cardKind: "permission", participantId: "p-box", card: { approval } } as HubOp);
  await h.write(h.owner, { opId: id("op"), kind: "card.answer", conversationId: chat, cardId, answer: { approve: true, scope: "chat" } } as HubOp);
  await raise();
  assert.equal(await leave(), "allow", "her \"Allow for this chat\"");
  await h.write(h.owner, { opId: id("op"), kind: "conversation.update", conversationId: chat, metadata: { participants: [desk, box] } } as HubOp);
  assert.equal(await leave(), "ask", "she takes it back");
  await raise();
  assert.equal(await leave(), "ask", "the same answer does not give it again");
});

test("a closed Accord's line comes only from the User's devices, once per Accord of the chat, and keeps the chat's time", async (t) => {
  // Her view of the chat (the User, 2026-11-16): a machine cannot fold her
  // Accord, nor can any device name an Accord the chat does not have.
  const h = await hub(t);
  const chat = id("chat");
  await h.write(h.owner, createChat(chat));
  const write = (device: typeof h.owner, message: ChatMessage) =>
    h.write(device, { opId: id("op"), kind: "message.create", conversationId: chat, message });
  await write(h.owner, userMessage("launch-1", "@taylor /accord"));
  await write(h.owner, { id: "note-2", role: "system", content: "@taylor created draft collection [Other](#artifact:a-2) · Drafts 0/2", status: "done",
    createdAt: new Date().toISOString(), metadata: { appMessageSource: "app_artifact_note", accordLaunchMessageId: "launch-2" } } as ChatMessage);
  const before = await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`);
  const line = (messageId: string, launchMessageId: string) =>
    accordClosedLine({ id: messageId, launchMessageId, title: "Ship or wait", createdAt: new Date().toISOString() }) as ChatMessage;
  assert.equal((await write(h.machine, line("l-box", "launch-1"))).body.results[0].status, "rejected", "a machine does not fold her Accord");
  assert.equal((await write(h.owner, line("l-none", "launch-9"))).body.results[0].status, "rejected", "no such Accord in this chat");
  assert.equal((await write(h.owner, line("l-long", "x".repeat(201)))).body.results[0].status, "rejected");
  assert.equal((await write(h.owner, line("l-desk", "launch-1"))).body.results[0].status, "accepted", "her computer, for an Accord launched here");
  assert.equal((await write(h.phone, line("l-again", "launch-1"))).body.results[0].status, "rejected", "once per Accord");
  assert.equal((await write(h.phone, line("l-phone", "launch-2"))).body.results[0].status, "accepted", "her phone, for an Accord known by its notes");
  const page = await h.call<HubChatPage>(h.owner, "GET", `/v3/chat?conversationId=${chat}`);
  assert.deepEqual(page.body.messages.map((message) => message.id), ["launch-1", "note-2", "l-desk", "l-phone"]);
  assert.equal(page.body.conversation.updatedAt, before.body.conversation.updatedAt, "the chat keeps its place in her list");
  assert.deepEqual((await h.storage.getConversation(chat))?.metadata.accordClosedLaunchIds, ["launch-1", "launch-2"], "the server's own record, for the phone's list");
});
