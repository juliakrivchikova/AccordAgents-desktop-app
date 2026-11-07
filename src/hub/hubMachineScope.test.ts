import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { HubCard } from "../shared/hubOps";
import type { HubMemberRules } from "../shared/hubProtocol";
import type { ChatMessage, Conversation } from "../shared/types";
import { approvalGrantKey, machineMayAsk, scopeMachineConversationUpdate } from "./hubMachineScope";

const hashOf = (content: string) => createHash("sha256").update(content).digest("hex");

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
  // Taken out by a member there that manages members, as the app does it.
  const manager = { ...box, permissions: { manageRolesParticipants: "allow" } };
  const managed = chat();
  managed.metadata.participants = [desk, manager];
  const scoped = scopeMachineConversationUpdate(managed, { metadata: { participants: [manager] } }, "machine-1");
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

// --- held to the User's rules and answers -------------------------------------

const rules: HubMemberRules = {
  version: 1,
  roles: { r: { manageRolesParticipants: "deny" }, lead: { manageRolesParticipants: "allow" }, helper: { manageRolesParticipants: "ask" }, asker: { manageRolesParticipants: "deny", requestParticipants: "allow" } },
  presets: { "preset-qa": { handle: "qa", roleConfigId: "r", permissions: { repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "ask", requestCompaction: "ask", shell: { enabled: false, rules: [] } } } }
};
let cards = 0;
function approved(participantId: string, toolName: string, request: Record<string, unknown>, answer: Record<string, unknown> = { approve: true }, cardKind: HubCard["cardKind"] = "permission"): HubCard {
  const cardId = `card-${++cards}`;
  return {
    cardId, conversationId: "c", cardKind, participantId, raisedBy: "dev-machine", raisedAt: "t", state: "answered",
    card: { approval: { id: cardId, requesterParticipantId: participantId, requesterRoleConfigId: "r", toolName, request, status: "pending",
      capability: toolName === "app_chat_request_participants" ? "participants.request" : toolName.includes("participants") || toolName.includes("roster") ? "participants.manage" : "tools" } },
    answer, answeredBy: "dev-owner", answeredAt: "t", answerOpId: `op-${cards}`
  } as unknown as HubCard;
}
const boxR = { ...box, roleConfigId: "r", permissions: { requestParticipants: "ask" } };
const deskR = { ...desk, roleConfigId: "r" };
function chatWith(participants: unknown[], messages: unknown[] = []): Conversation {
  return { id: "c", title: "", kind: "chat", createdAt: "t", updatedAt: "t", messages, findings: [], metadata: { participants } } as unknown as Conversation;
}
const members = (scoped: ReturnType<typeof scopeMachineConversationUpdate>) => new Map((scoped.update.metadata?.participants as Array<Record<string, unknown>>).map((item) => [item.id, item]));
const added = { id: "p-new", handle: "helper", label: "Helper", roleConfigId: "r", permissions: { requestParticipants: "ask" } };

test("its own member keeps the role and rights the User gave it; leave to ask comes only as the app gives it", () => {
  const forged = { ...boxR, roleConfigId: "lead", permissions: { requestParticipants: "allow", manageRolesParticipants: "allow" } };
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, forged] } }, "machine-1", { rules });
  assert.deepEqual(members(scoped).get("p-box"), boxR, "role, managing and leave to ask stay as they were");
  assert.ok(scoped.refused.includes("participants.p-box.rights"));

  // "Allow for this chat" on its request to ask members: leave to ask.
  const allowForChat = approved("p-box", "app_chat_request_participants", { requests: [{ target: "@desk" }], requestMessageId: "m1" }, { approve: true, scope: "chat" });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, { ...boxR, permissions: { requestParticipants: "allow" } }] } }, "machine-1", { rules, approvals: [allowForChat] });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).requestParticipants, "allow");
  // Approved once, or for a request inferred from its reply: no leave.
  for (const answer of [approved("p-box", "app_chat_request_participants", { requests: [], requestMessageId: "m1" }, { approve: true, scope: "once" }),
    approved("p-box", "app_chat_request_participants", { requests: [], requestMessageId: "m1", source: "inferred" }, { approve: true, scope: "chat" }),
    approved("p-box", "app_chat_request_participants", { requests: [], requestMessageId: "m1" }, { approve: true, scope: "chat", auto: true })]) {
    scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, { ...boxR, permissions: { requestParticipants: "allow" } }] } }, "machine-1", { rules, approvals: [answer] });
    assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).requestParticipants, "ask");
  }
  // `/accord` naming it, from anyone (the app's facilitator): leave.
  const accord = { id: "m-acc", role: "participant", participantId: "p-desk", content: "/accord @box please run it", createdAt: "t" };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR], [accord]), { metadata: { participants: [deskR, { ...boxR, permissions: { requestParticipants: "allow" } }] } }, "machine-1", { rules });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).requestParticipants, "allow");
  // Quoted as code it is not `/accord`.
  const quoted = { ...accord, content: "`/accord @box`" };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR], [quoted]), { metadata: { participants: [deskR, { ...boxR, permissions: { requestParticipants: "allow" } }] } }, "machine-1", { rules });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).requestParticipants, "ask");
  // Less is always fine.
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, { ...boxR, permissions: { requestParticipants: "deny" } }] } }, "machine-1", { rules });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).requestParticipants, "deny");
  assert.deepEqual(scoped.refused, []);
});

test("a member elsewhere gets leave to ask only from `/accord` naming it", () => {
  const leave = { ...deskR, permissions: { ...deskR.permissions, requestParticipants: "allow" } };
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [leave, boxR] } }, "machine-1", { rules });
  assert.deepEqual(members(scoped).get("p-desk"), deskR);
  const accord = { id: "m-acc", role: "participant", participantId: "p-box", content: "Starting /accord with @desk as facilitator", createdAt: "t" };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR], [accord]), { metadata: { participants: [leave, boxR] } }, "machine-1", { rules });
  assert.equal((members(scoped).get("p-desk")?.permissions as Record<string, unknown>).requestParticipants, "allow");
});

test("a member is added as the app adds one: by a member that manages members, or as the User approved it", () => {
  // Nobody there manages members and nothing was approved: not added.
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, added] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), false);
  assert.ok(scoped.refused.includes("participants.p-new.added"));
  // Without her rules the server knows no role that manages members.
  scoped = scopeMachineConversationUpdate(chatWith([deskR, { ...boxR, roleConfigId: "lead" }]), { metadata: { participants: [deskR, { ...boxR, roleConfigId: "lead" }, added] } }, "machine-1", {});
  assert.equal(members(scoped).has("p-new"), false);

  // A member there whose role manages members adds without a card.
  const lead = { ...boxR, roleConfigId: "lead" };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, lead]), { metadata: { participants: [deskR, lead, added] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), true);
  // ...but not one that would manage members beyond its role (a card).
  scoped = scopeMachineConversationUpdate(chatWith([deskR, lead]), { metadata: { participants: [deskR, lead, { ...added, permissions: { manageRolesParticipants: "allow" } }] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), false);
  // Her "Allow for this chat" on the member requests of one that asks her.
  const helper = { ...boxR, roleConfigId: "helper" };
  const policy = { id: "pol", participantId: "p-box", roleConfigId: "helper", toolName: "app_roster_request_change", capability: "participants.manage", scope: "chat", createdAt: "t", updatedAt: "t" };
  const withPolicy = { ...chatWith([deskR, helper]), metadata: { participants: [deskR, helper], appToolApprovalPolicies: [policy] } } as unknown as Conversation;
  scoped = scopeMachineConversationUpdate(withPolicy, { metadata: { participants: [deskR, helper, added] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), true);
  const withoutPolicy = { ...chatWith([deskR, helper]), metadata: { participants: [deskR, helper] } } as unknown as Conversation;
  scoped = scopeMachineConversationUpdate(withoutPolicy, { metadata: { participants: [deskR, helper, added] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), false, "one that asks her adds nothing without her answer");
  // A member that may not manage members at all adds nothing, policy or not.
  const denied = { ...boxR, permissions: { requestParticipants: "ask", manageRolesParticipants: "deny" } };
  const deniedChat = { ...chatWith([deskR, denied]), metadata: { participants: [deskR, denied], appToolApprovalPolicies: [{ ...policy, roleConfigId: "r" }] } } as unknown as Conversation;
  scoped = scopeMachineConversationUpdate(deniedChat, { metadata: { participants: [deskR, denied, added] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), false);
});

test("an approved addition adds the member the User saw: its name, role, place, mode and rights", () => {
  const request = { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "r", kind: "codex-cli" } }] };
  const approval = approved("p-box", "app_participants_request_change", request);
  const add = (member: Record<string, unknown>, approvals = [approval]) =>
    members(scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, member] } }, "machine-1", { rules, approvals })).has(member.id as string);
  assert.equal(add(added), true, "as approved");
  assert.equal(add({ ...added, handle: "other" }), false, "another member");
  assert.equal(add({ ...added, roleConfigId: "lead" }), false, "another role");
  assert.equal(add({ ...added, homeMachineId: "machine-1" }), false, "another place");
  assert.equal(add({ ...added, agentMode: "auto" }), false, "full access");
  assert.equal(add({ ...added, permissions: { workspaceWrite: true } }), false, "a right it was not given");
  assert.equal(add({ ...added, permissions: { requestParticipants: "allow" } }), false, "leave to ask it was not given");
  assert.equal(add({ ...added, permissions: { repoRead: false } }), true, "less is fine");
  assert.equal(add(added, [approved("p-desk", "app_participants_request_change", request)]), false, "approved for a member elsewhere");
  assert.equal(add(added, [approved("p-box", "app_participants_request_change", request, { approve: false })]), false, "denied");
  // As she edited it before approving.
  const edited = approved("p-box", "app_participants_request_change", request,
    { approve: true, draftOverride: { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "r", kind: "codex-cli", permissions: { workspaceWrite: true } } }] } });
  assert.equal(add({ ...added, permissions: { workspaceWrite: true } }, [edited]), true);
  // A role's own starting rights for a member added without its own.
  const asker = approved("p-box", "app_participants_request_change", { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "asker", kind: "codex-cli" } }] });
  assert.equal(add({ ...added, roleConfigId: "asker", permissions: { requestParticipants: "allow" } }, [asker]), true);
  // A saved member, as her computer has it.
  const saved = approved("p-box", "app_participants_request_change", { operations: [{ type: "add_existing_participant_to_chat", participantConfigId: "preset-qa" }] });
  const qa = { id: "p-qa", handle: "qa", label: "QA", roleConfigId: "r", participantConfigId: "preset-qa", permissions: rules.presets["preset-qa"].permissions };
  assert.equal(add(qa, [saved]), true);
  assert.equal(add({ ...qa, permissions: { ...qa.permissions, shell: { enabled: true, rules: [] } } }, [saved]), false);
  assert.equal(members(scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, qa] } }, "machine-1", { approvals: [saved] })).has("p-qa"), false,
    "a saved member the server does not know is not added");
});

test("a rule to act without a card is the User's answer, for the machine's own member", () => {
  const rule = { id: "pol-new", participantId: "p-box", roleConfigId: "r", toolName: "app_tool_permission", capability: "tools", targetToolName: "Bash", scope: "chat", createdAt: "t", updatedAt: "t" };
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [rule] } }, "machine-1", { rules });
  assert.deepEqual(scoped.update.metadata?.appToolApprovalPolicies, []);
  assert.ok(scoped.refused.includes("appToolApprovalPolicies.pol-new"));
  const answer = approved("p-box", "app_tool_permission", { toolName: "Bash" }, { approve: true, scope: "chat" });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [rule] } }, "machine-1", { rules, approvals: [answer] });
  assert.deepEqual((scoped.update.metadata?.appToolApprovalPolicies as Array<{ id: string }>).map((item) => item.id), ["pol-new"]);
  const once = approved("p-box", "app_tool_permission", { toolName: "Bash" }, { approve: true, scope: "once" });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [rule] } }, "machine-1", { rules, approvals: [once] });
  assert.deepEqual(scoped.update.metadata?.appToolApprovalPolicies, []);
});

test("a machine names a new chat once, as the app does from the member that answers first", () => {
  const named = { source: "first-agent", title: "Fix login", participantId: "p-box", appliedAt: "t" };
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { title: "Fix login", metadata: { autoTitle: named } }, "machine-1");
  assert.equal(scoped.update.title, "Fix login");
  assert.deepEqual(scoped.update.metadata?.autoTitle, named);
  assert.deepEqual(scoped.refused, []);
  const titled = { ...chatWith([deskR, boxR]), title: "Fix login", metadata: { participants: [deskR, boxR], autoTitle: named } } as unknown as Conversation;
  scoped = scopeMachineConversationUpdate(titled, { title: "Owned", metadata: { autoTitle: { ...named, title: "Owned" } } }, "machine-1");
  assert.equal(scoped.update.title, undefined, "named already");
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { title: "Owned", metadata: { autoTitle: { ...named, title: "Owned", participantId: "p-desk" } } }, "machine-1");
  assert.equal(scoped.update.title, undefined, "named for a member elsewhere");
});

test("a machine asks a member elsewhere with its member's leave to ask, or with the User's approval of that request", () => {
  const message = { id: "m-req", role: "participant", participantId: "p-box", content: "", createdAt: "t" } as unknown as ChatMessage;
  const base = chatWith([deskR, boxR], [message]);
  assert.equal(Boolean(machineMayAsk(base, "machine-1", message, "p-desk", [], hashOf(""))), false);
  const allowed = chatWith([deskR, { ...boxR, permissions: { requestParticipants: "allow" } }], [message]);
  assert.equal(Boolean(machineMayAsk(allowed, "machine-1", message, "p-desk", [], hashOf(""))), true);
  const request = (requestMessageId: string, target: string) => ({ ...approved("p-box", "app_chat_request_participants", { requests: [{ target }], requestMessageId }), messageHash: hashOf("") });
  assert.equal(Boolean(machineMayAsk(base, "machine-1", message, "p-desk", [request("m-req", "@desk")], hashOf(""))), true, "this request, this member");
  assert.equal(Boolean(machineMayAsk(base, "machine-1", message, "p-desk", [request("m-other", "@desk")], hashOf(""))), false, "another request");
  assert.equal(Boolean(machineMayAsk(base, "machine-1", message, "p-desk", [request("m-req", "@someone")], hashOf(""))), false, "another member");
  assert.equal(Boolean(machineMayAsk(base, "machine-1", message, "p-desk", [{ ...request("m-req", "@desk"), answer: { approve: true, auto: true } } as HubCard], hashOf(""))), false, "its own word");
  const mention = { cardId: "mention:m-req", conversationId: "c", cardKind: "mention", participantId: "p-box", messageId: "m-req", raisedBy: "dev-machine", raisedAt: "t",
    state: "settled", card: { mentions: [], sourceMessageId: "m-req" }, answer: { approve: true, targetParticipantIds: ["p-desk"] }, answeredBy: "dev-owner", answerOpId: "op-m", messageHash: hashOf("") } as unknown as HubCard;
  assert.equal(Boolean(machineMayAsk(base, "machine-1", message, "p-desk", [mention], hashOf(""))), true, "an approved mention");
  assert.equal(Boolean(machineMayAsk(base, "machine-2", message, "p-desk", [request("m-req", "@desk")], hashOf(""))), false, "another machine's member");
  assert.equal(Boolean(machineMayAsk(base, "machine-1", message, "p-desk", [request("m-req", "@desk")], hashOf("rewritten after she approved"))), false, "a request rewritten since");
  assert.equal(Boolean(machineMayAsk(base, "machine-1", message, "p-desk", [{ ...request("m-req", "@desk"), superseded: true }], hashOf(""))), false, "an approval she answered again");
});

test("an approval gives the lasting right it approved once, and a member never names itself facilitator", () => {
  const allowForChat = approved("p-box", "app_chat_request_participants", { requests: [{ target: "@desk" }], requestMessageId: "m1" }, { approve: true, scope: "chat" });
  const raise = { metadata: { participants: [deskR, { ...boxR, permissions: { requestParticipants: "allow" } }] } };
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), raise, "machine-1", { rules, approvals: [allowForChat] });
  assert.deepEqual(scoped.used, [approvalGrantKey(allowForChat.answerOpId!)], "the approval that gave the leave is noted as used");
  // The User took the leave back; an old copy or a write around the app
  // citing the same approval does not give it again.
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), raise, "machine-1", { rules, approvals: [allowForChat], used: new Set([approvalGrantKey(allowForChat.answerOpId!)]) });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).requestParticipants, "ask");
  assert.deepEqual(scoped.used, []);
  // Its own reply naming itself is not `/accord` naming its facilitator.
  const self = { id: "m-self", role: "participant", participantId: "p-box", content: "/accord @box", createdAt: "t" };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR], [self]), raise, "machine-1", { rules });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).requestParticipants, "ask");
  // The User's own `/accord` naming it (as a skill, from her phone) does.
  const hers = { id: "m-hers", role: "user", content: "run an accord", createdAt: "t", metadata: { skillMentions: [{ frontmatterName: "accord" }], deliveryTargets: ["p-box"] } };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR], [hers]), raise, "machine-1", { rules });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).requestParticipants, "allow");
  // An approved addition adds once.
  const request = { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "r", kind: "codex-cli" } }] };
  const addition = approved("p-box", "app_participants_request_change", request);
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, added] } }, "machine-1", { rules, approvals: [addition] });
  assert.deepEqual(scoped.used, [approvalGrantKey(addition.answerOpId!)]);
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, added] } }, "machine-1", { rules, approvals: [addition], used: new Set(scoped.used) });
  assert.equal(members(scoped).has("p-new"), false, "taken out and added again: asked again");
});

test("an `/accord` counts only as the chat shows it, and once", () => {
  const raise = { metadata: { participants: [deskR, { ...boxR, permissions: { requestParticipants: "allow" } }] } };
  const leaveWith = (messages: unknown[], used?: Set<string>) =>
    (members(scopeMachineConversationUpdate(chatWith([deskR, boxR], messages), raise, "machine-1", { rules, ...(used ? { used } : {}) })).get("p-box")?.permissions as Record<string, unknown>).requestParticipants;
  // A line the machine writes as the chat's own, or hides: not `/accord`.
  assert.equal(leaveWith([{ id: "m-sys", role: "system", content: "/accord @box", createdAt: "t" }]), "ask");
  assert.equal(leaveWith([{ id: "m-hid", role: "user", content: "/accord @box", createdAt: "t", metadata: { hiddenFromTimeline: true } }]), "ask");
  assert.equal(leaveWith([{ id: "m-hid2", role: "participant", participantId: "p-desk", content: "/accord @box", createdAt: "t", metadata: { hiddenFromTimeline: true } }]), "ask");
  // Hers, once: taken back, the same `/accord` does not give it again.
  const hers = { id: "m-hers", role: "user", content: "/accord @box lead this", createdAt: "t" };
  const scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR], [hers]), raise, "machine-1", { rules });
  assert.deepEqual(scoped.used, ["accord:m-hers:p-box"]);
  assert.equal(leaveWith([hers], new Set(scoped.used)), "ask");
});

test("a rule to act without a card is exactly the one the app keeps for her answer", () => {
  const helper = { ...boxR, roleConfigId: "helper" };
  const rosterAnswer = { ...approved("p-box", "app_roster_request_change", { operations: [{ type: "add", participant: { handle: "helper", roleConfigId: "r", kind: "codex-cli" } }] }, { approve: true, scope: "chat" }) };
  (rosterAnswer.card as { approval: { requesterRoleConfigId: string } }).approval.requesterRoleConfigId = "helper";
  const rosterRule = { id: "pol-r", participantId: "p-box", roleConfigId: "helper", toolName: "app_roster_request_change", capability: "participants.manage", scope: "chat", createdAt: "t", updatedAt: "t" };
  // The app adds the member and keeps the rule in one write: both stand.
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, helper]), { metadata: { participants: [deskR, helper, added], appToolApprovalPolicies: [rosterRule] } }, "machine-1", { rules, approvals: [rosterAnswer] });
  assert.equal(members(scoped).has("p-new"), true);
  assert.deepEqual((scoped.update.metadata?.appToolApprovalPolicies as Array<{ id: string }>).map((item) => item.id), ["pol-r"]);
  // An "Add member" answer gives no rule for adding without a card (the app
  // keeps none), and none shaped otherwise counts.
  const addAnswer = approved("p-box", "app_participants_request_change", { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "r", kind: "codex-cli" } }] }, { approve: true, scope: "chat" });
  const forged = { ...rosterRule, id: "pol-f", roleConfigId: "r", toolName: "app_participants_request_change" };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [forged] } }, "machine-1", { rules, approvals: [addAnswer] });
  assert.deepEqual(scoped.update.metadata?.appToolApprovalPolicies, []);
  for (const shape of [{ capability: "tools" }, { roleConfigId: "lead" }, { targetParticipantId: "p-desk" }, { targetToolName: "Bash" }]) {
    scoped = scopeMachineConversationUpdate(chatWith([deskR, helper]), { metadata: { appToolApprovalPolicies: [{ ...rosterRule, ...shape }] } }, "machine-1", { rules, approvals: [rosterAnswer] });
    assert.deepEqual(scoped.update.metadata?.appToolApprovalPolicies, [], JSON.stringify(shape));
  }
  // A forged participants-tool rule already on the server does not let it add.
  const withForged = { ...chatWith([deskR, boxR]), metadata: { participants: [deskR, boxR], appToolApprovalPolicies: [{ ...forged, roleConfigId: "r" }] } } as unknown as Conversation;
  scoped = scopeMachineConversationUpdate(withForged, { metadata: { participants: [deskR, boxR, added] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), false);
});

test("an approved addition adds one member per member she approved, with the role she saw", () => {
  const request = { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "r", kind: "codex-cli" } }] };
  const answer = approved("p-box", "app_participants_request_change", request);
  const twin = { ...added, id: "p-twin" };
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, added, twin] } }, "machine-1", { rules, approvals: [answer] });
  assert.equal(members(scoped).has("p-new"), true);
  assert.equal(members(scoped).has("p-twin"), false, "one approval, one member");
  // A role edited in the same request is still the role named.
  const edited = approved("p-box", "app_participants_request_change", { kind: "role_participant_change",
    roleRequest: { operations: [{ type: "edit_role", role: { roleConfigId: "r", participantDefaults: {} } }] }, participantRequest: request });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, { ...added, roleConfigId: "lead" }] } }, "machine-1", { rules, approvals: [edited] });
  assert.equal(members(scoped).has("p-new"), false, "not a role that manages members instead");
  // A role made in the same request: a new role, not one she already has.
  const made = approved("p-box", "app_participants_request_change", { kind: "role_participant_change",
    roleRequest: { operations: [{ type: "create_role", role: { draftRoleRef: "draft-1", participantDefaults: {} } }] },
    participantRequest: { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "draft-1", kind: "codex-cli" } }] } });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, { ...added, roleConfigId: "role-new-1" }] } }, "machine-1", { rules, approvals: [made] });
  assert.equal(members(scoped).has("p-new"), true);
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, { ...added, roleConfigId: "lead" }] } }, "machine-1", { rules, approvals: [made] });
  assert.equal(members(scoped).has("p-new"), false);
  // Answered again (refused this time): the earlier approval no longer counts.
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, added] } }, "machine-1", { rules, approvals: [{ ...answer, superseded: true }] });
  assert.equal(members(scoped).has("p-new"), false);
});

test("a member is taken out as the app takes one out; one an old copy leaves out stays", () => {
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [boxR] } }, "machine-1", { rules });
  assert.deepEqual([...members(scoped).keys()].sort(), ["p-box", "p-desk"], "not without a member that manages members, or her approval");
  assert.ok(scoped.refused.includes("participants.p-desk.removed"));
  const removal = approved("p-box", "app_participants_request_change", { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: "p-desk", handle: "desk" }] });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [boxR] } }, "machine-1", { rules, approvals: [removal] });
  assert.deepEqual([...members(scoped).keys()], ["p-box"]);
  const lead = { ...boxR, roleConfigId: "lead" };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, lead]), { metadata: { participants: [lead] } }, "machine-1", { rules });
  assert.deepEqual([...members(scoped).keys()], ["p-box"], "a member whose role manages members takes one out");
});

test("its own member without rights of its own changes only what it changed", () => {
  const plain = { id: "p-box", handle: "box", label: "Box", homeMachineId: "machine-1", model: "old" };
  const scoped = scopeMachineConversationUpdate(chatWith([deskR, plain]), { metadata: { participants: [deskR, { ...plain, model: "new" }] } }, "machine-1", { rules });
  assert.deepEqual(scoped.refused, []);
  assert.deepEqual(members(scoped).get("p-box"), { ...plain, model: "new" });
});

test("her approval runs the member it names once", () => {
  const message = { id: "m-req", role: "participant", participantId: "p-box", content: "", createdAt: "t" } as unknown as ChatMessage;
  const base = chatWith([deskR, boxR], [message]);
  const answer = { ...approved("p-box", "app_chat_request_participants", { requests: [{ target: "@desk" }], requestMessageId: "m-req" }), messageHash: hashOf("") };
  const first = machineMayAsk(base, "machine-1", message, "p-desk", [answer], hashOf(""));
  assert.deepEqual(first, { grant: `ask:${answer.answerOpId}:p-desk` });
  assert.equal(machineMayAsk(base, "machine-1", message, "p-desk", [answer], hashOf(""), new Set([(first as { grant: string }).grant])), false, "not again");
});

test("an approved addition takes the role it names; one naming none adds nobody", () => {
  const noRole = approved("p-box", "app_participants_request_change", { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", kind: "codex-cli" } }] });
  const scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, { ...added, roleConfigId: "lead" }] } }, "machine-1", { rules, approvals: [noRole] });
  assert.equal(members(scoped).has("p-new"), false);
  const made = approved("p-box", "app_participants_request_change", { kind: "role_participant_change",
    roleRequest: { operations: [{ type: "create_role", role: { draftRoleRef: "draft-1", participantDefaults: {} } }] },
    participantRequest: { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "draft-1", kind: "codex-cli" } }] } });
  const unknown = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, boxR, { ...added, roleConfigId: "role-new-1" }] } }, "machine-1", { approvals: [made] });
  assert.equal(members(unknown).has("p-new"), false, "without her rules a new role cannot be told from one that manages members");
});

test("a machine's member keeps its name; no member takes another's, the Chat Assistant and the last member stay", () => {
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, { ...boxR, handle: "desk" }] } }, "machine-1", { rules });
  assert.equal(members(scoped).get("p-box")?.handle, "box");
  const lead = { ...boxR, roleConfigId: "lead" };
  scoped = scopeMachineConversationUpdate(chatWith([deskR, lead]), { metadata: { participants: [deskR, lead, { ...added, handle: "DESK" }] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), false, "a name another member has");
  const assistant = { id: "p-assistant", handle: "assistant", label: "Assistant", roleConfigId: "administrator" };
  scoped = scopeMachineConversationUpdate(chatWith([assistant, deskR, lead]), { metadata: { participants: [deskR, lead] } }, "machine-1", { rules });
  assert.ok(members(scoped).has("p-assistant"), "the Chat Assistant stays");
  scoped = scopeMachineConversationUpdate(chatWith([deskR, lead]), { metadata: { participants: [] } }, "machine-1", { rules });
  assert.deepEqual([...members(scoped).keys()].sort(), ["p-box", "p-desk"], "the last member stays");
});

test("a machine never writes the session a member is handed when it moves, for its own members or others", () => {
  const handoff = { provider: "claude-code", sessionId: "s-1", blob: { type: "device.event.blob", blobHash: `sha256:${"a".repeat(64)}`, byteLength: 10, fragments: 1 }, at: "t" };
  const moving = chat();
  moving.metadata.participants = [desk, { ...box, sessionHandoff: handoff }] as never;
  const cleared = scopeMachineConversationUpdate(moving, { metadata: { participants: [desk, box] } }, "machine-1");
  assert.deepEqual((cleared.update.metadata?.participants as Array<{ id: string; sessionHandoff?: unknown }>)?.find((member) => member.id === "p-box")?.sessionHandoff, handoff,
    "its own member keeps what the computer handed it");
  const forged = { ...handoff, sessionId: "s-other" };
  const written = scopeMachineConversationUpdate(chat(), { metadata: { participants: [{ ...desk, sessionHandoff: forged }, { ...box, sessionHandoff: forged }] } }, "machine-1");
  const members = (written.update.metadata?.participants ?? [desk, box]) as Array<{ id: string; sessionHandoff?: unknown }>;
  assert.ok(members.every((member) => member.sessionHandoff === undefined), "nor one it makes up");
});
