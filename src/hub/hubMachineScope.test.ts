import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { HubCard } from "../shared/hubOps";
import type { HubMemberRules } from "../shared/hubProtocol";
import type { ChatMessage, Conversation } from "../shared/types";
import { approvalGrantKey, keptApproval, machineMayAsk, scopeMachineConversationUpdate } from "./hubMachineScope";

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
  // ...never one in Codex's Full Access, which only the User chooses (a card).
  scoped = scopeMachineConversationUpdate(chatWith([deskR, lead]), { metadata: { participants: [deskR, lead, { ...added, kind: "codex-cli", agentMode: "full-access" }] } }, "machine-1", { rules });
  assert.equal(members(scoped).has("p-new"), false, "Full Access without her card");
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
  // Codex's Full Access: only as far as she approved it.
  const asked = (agentMode: string) => [approved("p-box", "app_participants_request_change",
    { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "r", kind: "codex-cli", agentMode } }] })];
  assert.equal(add({ ...added, agentMode: "full-access" }), false, "Codex's Full Access she did not approve");
  assert.equal(add({ ...added, agentMode: "full-access" }, asked("auto")), false, "above the Auto she approved");
  assert.equal(add({ ...added, agentMode: "full-access" }, asked("full-access")), true, "as she approved it");
  assert.equal(add({ ...added, agentMode: "auto" }, asked("full-access")), true, "less than she approved");
  assert.equal(add({ ...added, permissions: { workspaceWrite: true } }), false, "a right it was not given");
  assert.equal(add({ ...added, permissions: { requestParticipants: "allow" } }), false, "leave to ask it was not given");
  assert.equal(add({ ...added, permissions: { repoRead: false } }), true, "less is fine");
  // In its CLI's own mode (a chat with a main session adds every member so):
  // it asks about what it was not given, not a right beyond it.
  assert.equal(add({ ...added, permissions: { requestParticipants: "ask", cliApprovals: true } }), true, "in its CLI's own mode");
  assert.equal(add({ ...added, permissions: { requestParticipants: "ask", cliApprovals: true, workspaceWrite: true } }), false, "and nothing more");
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
  const mkdir = { kind: "commands", prefixes: ["mkdir"] };
  const rule = { id: "pol-new", participantId: "p-box", roleConfigId: "r", toolName: "app_tool_permission", capability: "tools", targetToolName: "Bash", targetToolScope: mkdir, scope: "chat", createdAt: "t", updatedAt: "t" };
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [rule] } }, "machine-1", { rules });
  assert.deepEqual(scoped.update.metadata?.appToolApprovalPolicies, []);
  assert.ok(scoped.refused.includes("appToolApprovalPolicies.pol-new"));
  const answer = approved("p-box", "app_tool_permission", { toolName: "Bash", chatScope: mkdir }, { approve: true, scope: "chat" });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [rule] } }, "machine-1", { rules, approvals: [answer] });
  assert.deepEqual((scoped.update.metadata?.appToolApprovalPolicies as Array<{ id: string }>).map((item) => item.id), ["pol-new"]);
  const once = approved("p-box", "app_tool_permission", { toolName: "Bash", chatScope: mkdir }, { approve: true, scope: "once" });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [rule] } }, "machine-1", { rules, approvals: [once] });
  assert.deepEqual(scoped.update.metadata?.appToolApprovalPolicies, []);
  // Scoped as the card she answered, as Claude Code scopes "don't ask
  // again": never the whole of Bash, never another prefix.
  const { targetToolScope: _scope, ...wholeBash } = rule;
  for (const [name, forged] of [["whole tool", wholeBash], ["another prefix", { ...rule, targetToolScope: { kind: "commands", prefixes: ["rm"] } }]] as const) {
    scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [forged] } }, "machine-1", { rules, approvals: [answer] });
    assert.deepEqual(scoped.update.metadata?.appToolApprovalPolicies, [], name);
  }
  // A tool whose answer is not scoped (an MCP tool): the rule is for the tool.
  const mcp = { ...wholeBash, id: "pol-mcp", targetToolName: "mcp__atlassian__search" };
  const mcpAnswer = approved("p-box", "app_tool_permission", { toolName: "mcp__atlassian__search" }, { approve: true, scope: "chat" });
  scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { appToolApprovalPolicies: [mcp] } }, "machine-1", { rules, approvals: [mcpAnswer] });
  assert.deepEqual((scoped.update.metadata?.appToolApprovalPolicies as Array<{ id: string }>).map((item) => item.id), ["pol-mcp"]);
});

test("running in its CLI's own mode (asking the User for what it is not granted) is a right the server counts, as the app does", () => {
  const own = { ...boxR, permissions: { ...boxR.permissions, cliApprovals: true } };
  // The machine gives its member its CLI's mode on its own: taken back.
  let scoped = scopeMachineConversationUpdate(chatWith([deskR, boxR]), { metadata: { participants: [deskR, own] } }, "machine-1", { rules });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).cliApprovals, undefined);
  assert.ok(scoped.refused.includes("participants.p-box.rights"));
  // The server has it (the User chose the mode): it stays, and dropping it is less.
  scoped = scopeMachineConversationUpdate(chatWith([deskR, own]), { metadata: { participants: [deskR, own] } }, "machine-1", { rules });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).cliApprovals, true);
  scoped = scopeMachineConversationUpdate(chatWith([deskR, own]), { metadata: { participants: [deskR, boxR] } }, "machine-1", { rules });
  assert.deepEqual(scoped.refused, []);
  // For Antigravity its own mode is what holds it back: dropping it while
  // edits stay would skip every agy confirmation, so it stays.
  const agy = { ...boxR, kind: "gemini-cli", permissions: { ...boxR.permissions, workspaceWrite: true, cliApprovals: true } };
  const { cliApprovals: _mode, ...withoutMode } = agy.permissions;
  scoped = scopeMachineConversationUpdate(chatWith([deskR, agy]), { metadata: { participants: [deskR, { ...agy, permissions: withoutMode }] } }, "machine-1", { rules });
  assert.equal((members(scoped).get("p-box")?.permissions as Record<string, unknown>).cliApprovals, true);
  assert.ok(scoped.refused.includes("participants.p-box.rights"));
  scoped = scopeMachineConversationUpdate(chatWith([deskR, agy]), { metadata: { participants: [deskR, { ...agy, permissions: { ...withoutMode, workspaceWrite: false } }] } }, "machine-1", { rules });
  assert.deepEqual(scoped.refused, [], "without edits it is less");
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
  // The main session stays too, as in the app (docs/main-session.md).
  const main = { id: "p-main", handle: "main", label: "Main", roleConfigId: "main-session" };
  const mainChat = chatWith([main, deskR, lead]);
  mainChat.metadata.mainSessionParticipantId = main.id;
  scoped = scopeMachineConversationUpdate(mainChat, { metadata: { participants: [deskR, lead] } }, "machine-1", { rules });
  assert.ok(members(scoped).has("p-main"), "the main session stays");
  assert.ok(scoped.refused.includes("participants.p-main.removed"));
  assert.equal(members(scoped).has("p-desk"), true);
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

test("a member a machine adds comes without a session handed to it", () => {
  const handoff = { provider: "claude-code", sessionId: "s-1", blob: { type: "device.event.blob", blobHash: `sha256:${"b".repeat(64)}`, byteLength: 10, fragments: 1 }, at: "t" };
  const manager = { ...box, permissions: { manageRolesParticipants: "allow" } };
  const managed = chat();
  managed.metadata.participants = [desk, manager];
  const added = { id: "p-new", handle: "new", label: "New", roleConfigId: "r", kind: "claude-code", sessionHandoff: handoff };
  const scoped = scopeMachineConversationUpdate(managed, { metadata: { participants: [desk, manager, added] } }, "machine-1");
  const member = (scoped.update.metadata?.participants as Array<{ id: string; sessionHandoff?: unknown }>)?.find((item) => item.id === "p-new");
  if (member) assert.equal(member.sessionHandoff, undefined);
});

test("a machine never writes the member of another chat a forked main session copies, for its own members, others or ones it adds", () => {
  // Fork to new chat (src/shared/forkToNewChat.ts): only the computer names it.
  const origin = { conversationId: "c-old", participantId: "p-old", handle: "old", conversationTitle: "Old", kind: "claude-code" };
  const forked = chat();
  forked.metadata.participants = [desk, { ...box, forkOrigin: origin }] as never;
  const kept = scopeMachineConversationUpdate(forked, { metadata: { participants: [desk, box] } }, "machine-1");
  assert.deepEqual((kept.update.metadata?.participants as Array<{ id: string; forkOrigin?: unknown }>)?.find((member) => member.id === "p-box")?.forkOrigin, origin,
    "its own member keeps what the computer wrote");
  const other = { ...origin, conversationId: "c-secret", participantId: "p-secret" };
  const written = scopeMachineConversationUpdate(chat(), { metadata: { participants: [{ ...desk, forkOrigin: other }, { ...box, forkOrigin: other }] } }, "machine-1");
  assert.ok(written.update.metadata?.participants, "its members' write still goes through");
  const members = written.update.metadata!.participants as Array<{ id: string; forkOrigin?: unknown }>;
  assert.ok(members.every((member) => member.forkOrigin === undefined), "nor one it makes up");
  const manager = { ...box, permissions: { manageRolesParticipants: "allow" } };
  const managed = chat();
  managed.metadata.participants = [desk, manager];
  const added = { id: "p-new", handle: "new", label: "New", roleConfigId: "r", kind: "claude-code", forkOrigin: other };
  const scoped = scopeMachineConversationUpdate(managed, { metadata: { participants: [desk, manager, added] } }, "machine-1");
  const member = (scoped.update.metadata?.participants as Array<{ id: string; forkOrigin?: unknown }>)?.find((item) => item.id === "p-new");
  assert.ok(member, "the member is added");
  assert.equal(member!.forkOrigin, undefined, "a member it adds copies nobody");
  assert.ok(scoped.refused.includes("participants.p-new.forkOrigin"), "the server's log names what it left out");
  assert.equal(scoped.refused.includes("participants.p-new.sessionHandoff"), false, "and only that");
});

// --- a chat with a main session (docs/main-session.md) ---------------------------

const mainRules: HubMemberRules = { ...rules, roles: { ...rules.roles, "main-session": { manageRolesParticipants: "allow", requestParticipants: "allow" } } };
const mainOnMachine = {
  id: "p-main", handle: "main", label: "Main", roleConfigId: "main-session", kind: "claude-code", homeMachineId: "machine-1", agentMode: "default",
  permissions: {
    repoRead: true, workspaceWrite: true, webAccess: false, requestParticipants: "allow", requestCompaction: "ask",
    shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "git diff" }, { action: "deny", match: "prefix", pattern: "git push" }] }
  }
};
function mainSessionChatWith(participants: unknown[], messages: unknown[] = []): Conversation {
  return { id: "c", title: "", kind: "chat", createdAt: "t", updatedAt: "t", messages, findings: [], metadata: { participants, mainSessionParticipantId: "p-main" } } as unknown as Conversation;
}

test("the main session on a machine adds the member it gives a task to without a card, never one broader than itself", () => {
  // What the app adds for app_chat_delegate_task: the main session's rights,
  // clamped, on its machine, not managing members.
  const delegated = {
    id: "p-child", handle: "claude", label: "Claude", roleConfigId: "r", kind: "claude-code", homeMachineId: "machine-1", agentMode: "default",
    permissions: {
      repoRead: true, workspaceWrite: true, webAccess: false, requestParticipants: "allow", requestCompaction: "ask", manageRolesParticipants: "deny",
      shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "git diff" }, { action: "deny", match: "prefix", pattern: "git push" }] }
    }
  };
  const add = (member: Record<string, unknown>) =>
    members(scopeMachineConversationUpdate(mainSessionChatWith([deskR, mainOnMachine]), { metadata: { participants: [deskR, mainOnMachine, member] } }, "machine-1", { rules: mainRules })).has(member.id as string);
  assert.equal(add(delegated), true, "as the app adds it");
  assert.equal(add({ ...delegated, permissions: { ...delegated.permissions, webAccess: true } }), false, "web the main session does not have");
  assert.equal(add({ ...delegated, agentMode: "auto" }), false, "a mode above the main session's");
  assert.equal(add({ ...delegated, kind: "codex-cli", agentMode: "full-access" }), false, "Codex's Full Access above the main session's mode");
  const fullMain = { ...mainOnMachine, kind: "codex-cli", agentMode: "full-access", permissions: { ...mainOnMachine.permissions, cliApprovals: true } };
  const codexChild = { ...delegated, kind: "codex-cli", agentMode: "full-access", permissions: { ...delegated.permissions, webAccess: true, cliApprovals: true } };
  assert.equal(members(scopeMachineConversationUpdate(mainSessionChatWith([deskR, fullMain]), { metadata: { participants: [deskR, fullMain, codexChild] } }, "machine-1", { rules: mainRules })).has("p-child"), true,
    "a main session in Full Access hands its mode to the member it makes, as the app does");
  assert.equal(add({ ...delegated, permissions: { ...delegated.permissions, shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "rm" }] } } }), false, "a command the main session may not run");
  assert.equal(add({ ...delegated, permissions: { ...delegated.permissions, workspaceWrite: false, shell: { enabled: false, rules: [] } } }), true, "less is fine");
  // In plan mode the main session has no edits: neither may its member.
  const planning = { ...mainOnMachine, agentMode: "plan" };
  assert.equal(members(scopeMachineConversationUpdate(mainSessionChatWith([deskR, planning]), { metadata: { participants: [deskR, planning, delegated] } }, "machine-1", { rules: mainRules })).has("p-child"), false);
  // A chat without a main session keeps the rule it had for a manager there.
  const plainChat = chatWith([deskR, mainOnMachine]);
  assert.equal(members(scopeMachineConversationUpdate(plainChat, { metadata: { participants: [deskR, mainOnMachine, { ...delegated, permissions: { ...delegated.permissions, webAccess: true } }] } }, "machine-1", { rules: mainRules })).has("p-child"), true);
});

test("in a chat with a main session only the User and the main session start an Accord", () => {
  const helperOnMachine = { ...boxR, id: "p-helper", handle: "helper" };
  const leave = { ...deskR, permissions: { ...deskR.permissions, requestParticipants: "allow" } };
  const fromMember = { id: "m-acc", role: "participant", participantId: "p-helper", content: "/accord @desk please run it", createdAt: "t" };
  let scoped = scopeMachineConversationUpdate(mainSessionChatWith([deskR, mainOnMachine, helperOnMachine], [fromMember]), { metadata: { participants: [leave, mainOnMachine, helperOnMachine] } }, "machine-1", { rules: mainRules });
  assert.deepEqual(members(scoped).get("p-desk"), deskR, "another member's /accord gives no leave");
  // The main session's Accord launch (app_chat_start_accord).
  const fromMain = { ...fromMember, participantId: "p-main", metadata: { accordLaunchByMainSession: true } };
  scoped = scopeMachineConversationUpdate(mainSessionChatWith([deskR, mainOnMachine, helperOnMachine], [fromMain]), { metadata: { participants: [leave, mainOnMachine, helperOnMachine] } }, "machine-1", { rules: mainRules });
  assert.equal((members(scoped).get("p-desk")?.permissions as Record<string, unknown>).requestParticipants, "allow");
  const fromUser = { id: "m-user", role: "user", content: "@desk /accord with @helper", createdAt: "t" };
  scoped = scopeMachineConversationUpdate(mainSessionChatWith([deskR, mainOnMachine, helperOnMachine], [fromUser]), { metadata: { participants: [leave, mainOnMachine, helperOnMachine] } }, "machine-1", { rules: mainRules });
  assert.equal((members(scoped).get("p-desk")?.permissions as Record<string, unknown>).requestParticipants, "allow");
});

// --- what a machine may not raise (review of the main session, 2026-11-20) ------

/** The chat after the server took this machine's write. */
function afterWrite(conversation: Conversation, scoped: ReturnType<typeof scopeMachineConversationUpdate>): Conversation {
  return { ...conversation, metadata: { ...conversation.metadata, ...(scoped.update.metadata ?? {}) } } as Conversation;
}

const raisedMain = {
  ...mainOnMachine, agentMode: "auto",
  permissions: { ...mainOnMachine.permissions, webAccess: true, shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "rm" }] } }
};
/** A member that runs on the User's Mac, as broad as the raised main session. */
const broadOnMac = {
  id: "p-mac", handle: "mac", label: "Mac", roleConfigId: "r", kind: "claude-code", agentMode: "auto",
  permissions: { ...raisedMain.permissions, manageRolesParticipants: "deny" }
};

test("a machine cannot raise its own main session's rights or mode, then add a member as broad on the User's Mac", () => {
  // The probe: write 1 raises the main session to Auto with web and shell...
  const chat = mainSessionChatWith([deskR, mainOnMachine]);
  const first = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, raisedMain] } }, "machine-1", { rules: mainRules });
  const kept = members(first).get("p-main")!;
  const keptPermissions = kept.permissions as { webAccess: boolean; shell: { enabled: boolean; rules: Array<{ action: string; pattern: string }> } };
  assert.equal(kept.agentMode, "default", "the main session keeps the mode the User set");
  assert.equal(keptPermissions.webAccess, false, "and no web");
  assert.deepEqual(keptPermissions.shell.rules.map((rule) => `${rule.action} ${rule.pattern}`), ["deny git push"], "no command it was not given; its deny rule stays");
  assert.ok(first.refused.includes("participants.p-main.rights"));
  // ...write 2 adds a member with the same rights that runs on her Mac.
  const stored = afterWrite(chat, first);
  const second = scopeMachineConversationUpdate(stored, { metadata: { participants: [deskR, raisedMain, broadOnMac] } }, "machine-1", { rules: mainRules });
  assert.equal(members(second).has("p-mac"), false, "refused: nothing beyond the main session's rights as the server has them");
  assert.ok(second.refused.includes("participants.p-mac.added"));

  // Both in one write: the addition is held to the main session as it was before it.
  const together = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, raisedMain, broadOnMac] } }, "machine-1", { rules: mainRules });
  assert.equal(members(together).has("p-mac"), false);
  assert.equal(members(together).get("p-main")?.agentMode, "default");
});

test("a cloud main session adds a member on the User's Mac or another machine within its rights, without a card", () => {
  const chat = mainSessionChatWith([deskR, mainOnMachine]);
  const onMac = {
    id: "p-mac", handle: "mac", label: "Mac", roleConfigId: "r", kind: "claude-code", agentMode: "default",
    permissions: { repoRead: true, workspaceWrite: true, webAccess: false, requestParticipants: "allow", requestCompaction: "ask", manageRolesParticipants: "deny",
      shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "git diff" }, { action: "deny", match: "prefix", pattern: "git push" }] } }
  };
  const scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, mainOnMachine, onMac, { ...onMac, id: "p-other", handle: "other", homeMachineId: "machine-2" }] } }, "machine-1", { rules: mainRules });
  assert.equal(members(scoped).has("p-mac"), true, "runs on her Mac");
  assert.equal(members(scoped).has("p-other"), true, "runs on another machine");
  // It says the main session added it, so every device holds it to the main
  // session's rights at each turn.
  assert.equal(members(scoped).get("p-mac")?.delegatedByParticipantId, "p-main");
});

test("its own member's rights rise only by what the User granted it for the chat, once", () => {
  const chat = mainSessionChatWith([deskR, mainOnMachine]);
  const withWeb = { ...mainOnMachine, permissions: { ...mainOnMachine.permissions, webAccess: true } };
  let scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, withWeb] } }, "machine-1", { rules: mainRules });
  assert.equal((members(scoped).get("p-main")?.permissions as Record<string, unknown>).webAccess, false);
  // She granted web access for the chat on its card: the machine writes it.
  const grant = approved("p-main", "app_permissions_request_change", { kind: "portable", permissions: ["webAccess"] }, { approve: true, scope: "chat" });
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, withWeb] } }, "machine-1", { rules: mainRules, approvals: [grant] });
  assert.equal((members(scoped).get("p-main")?.permissions as Record<string, unknown>).webAccess, true);
  assert.deepEqual(scoped.refused, []);
  assert.ok(scoped.used.includes(approvalGrantKey(grant.answerOpId!)), "noted, so it gives its change once");
  // Granted once, or already used: nothing.
  const once = approved("p-main", "app_permissions_request_change", { kind: "portable", permissions: ["webAccess"] }, { approve: true, scope: "once" });
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, withWeb] } }, "machine-1", { rules: mainRules, approvals: [once] });
  assert.equal((members(scoped).get("p-main")?.permissions as Record<string, unknown>).webAccess, false);
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, withWeb] } }, "machine-1",
    { rules: mainRules, approvals: [grant], used: new Set([approvalGrantKey(grant.answerOpId!)]) });
  assert.equal((members(scoped).get("p-main")?.permissions as Record<string, unknown>).webAccess, false);
  // A grant gives what it grants, not the rest of what the write asks for.
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, { ...withWeb, agentMode: "auto", permissions: { ...withWeb.permissions, shell: { enabled: true, rules: [] } } }] } }, "machine-1",
    { rules: mainRules, approvals: [grant] });
  const kept = members(scoped).get("p-main")!;
  assert.equal(kept.agentMode, "default");
  assert.equal((kept.permissions as Record<string, unknown>).webAccess, true);
  assert.deepEqual((kept.permissions as { shell: unknown }).shell, { enabled: true, rules: [{ action: "deny", match: "prefix", pattern: "git push" }] },
    "its deny rule stays, and nothing it was not given");
  // Less is always fine, and so is what does not change rights.
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, { ...mainOnMachine, agentMode: "plan", model: "sonnet", permissions: { ...mainOnMachine.permissions, workspaceWrite: false } }] } }, "machine-1", { rules: mainRules });
  assert.deepEqual(scoped.refused, []);
  assert.equal(members(scoped).get("p-main")?.agentMode, "plan");
  // An old copy written after she lowered the mode does not raise it back.
  const lowered = mainSessionChatWith([deskR, { ...mainOnMachine, agentMode: "plan" }]);
  scoped = scopeMachineConversationUpdate(lowered, { metadata: { participants: [deskR, mainOnMachine] } }, "machine-1", { rules: mainRules });
  assert.equal(members(scoped).get("p-main")?.agentMode, "plan");
});

test("in a chat with a main session every member's addition is held to its own rights and the main session's", () => {
  // A member the main session made, that may add members (its task said so).
  const child = {
    id: "p-child", handle: "child", label: "Child", roleConfigId: "r", kind: "claude-code", homeMachineId: "machine-1", agentMode: "default",
    delegatedByParticipantId: "p-main",
    permissions: { repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "allow", requestCompaction: "ask", manageRolesParticipants: "allow", shell: { enabled: false, rules: [] } }
  };
  // The main session runs on the User's Mac: the child is the only member
  // on the machine that may add one.
  const mainOnMac = { ...mainOnMachine, homeMachineId: undefined };
  const chat = mainSessionChatWith([deskR, mainOnMac, child]);
  const grandchild = (permissions: Record<string, unknown>, agentMode = "default") => ({
    id: "p-grand", handle: "grand", label: "Grand", roleConfigId: "r", kind: "claude-code", homeMachineId: "machine-1", agentMode,
    permissions: { repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "ask", requestCompaction: "ask", shell: { enabled: false, rules: [] }, ...permissions }
  });
  const add = (member: Record<string, unknown>) => scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, mainOnMac, child, member] } }, "machine-1", { rules: mainRules });
  // A child that manages members adds one as broad as the main session but
  // broader than itself: refused.
  assert.equal(members(add(grandchild({ workspaceWrite: true }))).has("p-grand"), false, "edits its adder does not have");
  assert.equal(members(add(grandchild({}, "auto"))).has("p-grand"), false, "a mode above both");
  const within = add(grandchild({}));
  assert.equal(members(within).has("p-grand"), true, "within both: no card");
  assert.equal(members(within).get("p-grand")?.delegatedByParticipantId, "p-child", "it says who added it");
  // The main session lowered to plan: nothing with edits or shell, even from a broader adder.
  const planningMain = { ...mainOnMac, agentMode: "plan" };
  const broadChild = { ...child, permissions: { ...child.permissions, workspaceWrite: true } };
  const planning = mainSessionChatWith([deskR, planningMain, broadChild]);
  const scoped = scopeMachineConversationUpdate(planning, { metadata: { participants: [deskR, planningMain, broadChild, grandchild({ workspaceWrite: true })] } }, "machine-1", { rules: mainRules });
  assert.equal(members(scoped).has("p-grand"), false);
  // A member keeps who added it: the machine can neither drop nor change it.
  const dropped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, mainOnMac, { ...child, delegatedByParticipantId: undefined }] } }, "machine-1", { rules: mainRules });
  assert.equal(members(dropped).get("p-child")?.delegatedByParticipantId, "p-main");
});

test("a member the main session made manages members no more freely than the main session as the server has it", () => {
  const child = {
    id: "p-child", handle: "child", label: "Child", roleConfigId: "r", kind: "claude-code", homeMachineId: "machine-1", agentMode: "default",
    delegatedByParticipantId: "p-main",
    permissions: { repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "allow", requestCompaction: "ask", manageRolesParticipants: "allow", shell: { enabled: false, rules: [] } }
  };
  const grand = {
    id: "p-grand", handle: "grand", label: "Grand", roleConfigId: "r", kind: "claude-code", homeMachineId: "machine-1", agentMode: "default",
    permissions: { repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "ask", requestCompaction: "ask", shell: { enabled: false, rules: [] } }
  };
  // The User took the main session's right to manage members away; the child keeps "allow" stored.
  const loweredMain = { ...mainOnMachine, homeMachineId: undefined, permissions: { ...mainOnMachine.permissions, manageRolesParticipants: "deny" } };
  const chat = mainSessionChatWith([deskR, loweredMain, child]);
  const added = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, loweredMain, child, grand] } }, "machine-1", { rules: mainRules });
  assert.equal(members(added).has("p-grand"), false, "no addition without a card");
  const removed = scopeMachineConversationUpdate(chat, { metadata: { participants: [loweredMain, child] } }, "machine-1", { rules: mainRules });
  assert.equal(members(removed).has(deskR.id), true, "no removal without a card");
  // While the main session may, so may its member.
  const mainOnMac = { ...mainOnMachine, homeMachineId: undefined };
  const allowed = scopeMachineConversationUpdate(mainSessionChatWith([deskR, mainOnMac, child]), { metadata: { participants: [deskR, mainOnMac, child, grand] } }, "machine-1", { rules: mainRules });
  assert.equal(members(allowed).has("p-grand"), true);
});

test("an addition the User approved on a card is not marked as added by a member, whatever the machine wrote", () => {
  const mainOnMac = { ...mainOnMachine, homeMachineId: undefined };
  const asker = { ...boxR, permissions: { requestParticipants: "ask", manageRolesParticipants: "ask" } };
  const request = { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "helper", roleConfigId: "r", kind: "codex-cli" } }] };
  const approval = approved("p-box", "app_participants_request_change", request);
  const scoped = scopeMachineConversationUpdate(mainSessionChatWith([deskR, mainOnMac, asker]),
    { metadata: { participants: [deskR, mainOnMac, asker, { ...added, delegatedByParticipantId: "p-box" }] } }, "machine-1", { rules: mainRules, approvals: [approval] });
  assert.equal(members(scoped).has("p-new"), true, "added: she approved it");
  assert.equal(members(scoped).get("p-new")?.delegatedByParticipantId, undefined, "hers, not held to a member's rights");
  assert.ok(scoped.refused.includes("participants.p-new.delegatedBy"));
});

test("a member added without a card keeps every command its adder may not run forbidden", () => {
  const shellMember = (rules: unknown[]) => ({
    id: "p-sh", handle: "sh", label: "Sh", roleConfigId: "r", kind: "claude-code", homeMachineId: "machine-1", agentMode: "default",
    permissions: { repoRead: true, workspaceWrite: true, webAccess: false, requestParticipants: "allow", requestCompaction: "ask", shell: { enabled: true, rules } }
  });
  const mainSelf = { ...mainOnMachine };
  const add = (member: Record<string, unknown>) =>
    members(scopeMachineConversationUpdate(mainSessionChatWith([deskR, mainSelf]), { metadata: { participants: [deskR, mainSelf, member] } }, "machine-1", { rules: mainRules })).has("p-sh");
  assert.equal(add(shellMember([{ action: "allow", match: "prefix", pattern: "git diff" }])), false, "git push would be allowed again");
  assert.equal(add(shellMember([{ action: "allow", match: "prefix", pattern: "git diff" }, { action: "deny", match: "prefix", pattern: "git push" }])), true);
});

test("the main session's `/accord` gives its facilitator no more leave to ask than the main session's own, as in the app", () => {
  const asking = { ...mainOnMachine, permissions: { ...mainOnMachine.permissions, requestParticipants: "ask" } };
  const denied = { ...deskR, permissions: { requestParticipants: "deny" } };
  const helperOnMachine = { ...boxR, id: "p-helper", handle: "helper", permissions: { requestParticipants: "deny" } };
  // Its Accord launch (app_chat_start_accord), as the app writes it.
  const fromMain = { id: "m-acc", role: "participant", participantId: "p-main", content: "/accord @desk please run it with @helper", createdAt: "t",
    metadata: { accordLaunchByMainSession: true } };
  const chat = mainSessionChatWith([denied, asking, helperOnMachine], [fromMain]);
  // A facilitator elsewhere: "ask", never "allow".
  let scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [{ ...denied, permissions: { requestParticipants: "allow" } }, asking, helperOnMachine] } }, "machine-1", { rules: mainRules });
  assert.equal((members(scoped).get("p-desk")?.permissions as Record<string, unknown>).requestParticipants, "ask");
  // Its own facilitator likewise.
  const naming = { ...fromMain, content: "/accord @helper please run it" };
  scoped = scopeMachineConversationUpdate(mainSessionChatWith([denied, asking, helperOnMachine], [naming]),
    { metadata: { participants: [denied, asking, { ...helperOnMachine, permissions: { requestParticipants: "allow" } }] } }, "machine-1", { rules: mainRules });
  assert.equal((members(scoped).get("p-helper")?.permissions as Record<string, unknown>).requestParticipants, "ask");
  // The User's own `/accord` still gives full leave.
  const fromUser = { id: "m-user", role: "user", content: "@desk /accord with @helper", createdAt: "t" };
  scoped = scopeMachineConversationUpdate(mainSessionChatWith([denied, asking, helperOnMachine], [fromUser]),
    { metadata: { participants: [{ ...denied, permissions: { requestParticipants: "allow" } }, asking, helperOnMachine] } }, "machine-1", { rules: mainRules });
  assert.equal((members(scoped).get("p-desk")?.permissions as Record<string, unknown>).requestParticipants, "allow");
});

test("in the sessions view the main session's reply naming a facilitator with `/accord` gives no leave; its Accord launch does; the classic view as before", () => {
  const denied = { ...deskR, permissions: { requestParticipants: "deny" } };
  const raised = { metadata: { participants: [{ ...denied, permissions: { requestParticipants: "allow" } }, mainOnMachine] } };
  const leaveOf = (chat: Conversation) =>
    (members(scopeMachineConversationUpdate(chat, raised, "machine-1", { rules: mainRules })).get("p-desk")?.permissions as Record<string, unknown>).requestParticipants;
  const replyText = { id: "m-acc", role: "participant", participantId: "p-main", content: "@desk /accord on the rollout plan", createdAt: "t" };
  assert.equal(leaveOf(mainSessionChatWith([denied, mainOnMachine], [replyText])), "deny", "a mention in its reply starts nobody in the sessions view");
  const sessions = mainSessionChatWith([denied, mainOnMachine], [replyText]);
  sessions.metadata.chatView = "sessions";
  assert.equal(leaveOf(sessions), "deny");
  const launch = { ...replyText, metadata: { accordLaunchByMainSession: true } };
  assert.equal(leaveOf(mainSessionChatWith([denied, mainOnMachine], [launch])), "allow", "its app_chat_start_accord launch gives the leave");
  const classic = mainSessionChatWith([denied, mainOnMachine], [replyText]);
  classic.metadata.chatView = "classic";
  assert.equal(leaveOf(classic), "allow", "the classic view reads the reply as before");
});

test("a member the main session made asks others no more freely than the main session can now", () => {
  const lowered = { ...mainOnMachine, permissions: { ...mainOnMachine.permissions, requestParticipants: "ask" } };
  const child = { ...boxR, id: "p-child", handle: "child", delegatedByParticipantId: "p-main", permissions: { requestParticipants: "allow" } };
  const message = { id: "m-req", role: "participant", participantId: "p-child", content: "", createdAt: "t" } as unknown as ChatMessage;
  const chat = mainSessionChatWith([deskR, lowered, child], [message]);
  assert.equal(machineMayAsk(chat, "machine-1", message, "p-desk", [], hashOf("")), false);
  assert.equal(machineMayAsk(mainSessionChatWith([deskR, mainOnMachine, child], [message]), "machine-1", message, "p-desk", [], hashOf("")), true);
  // One the User added herself keeps its own leave.
  const own = { ...child, delegatedByParticipantId: undefined };
  assert.equal(machineMayAsk(mainSessionChatWith([deskR, lowered, own], [message]), "machine-1", message, "p-desk", [], hashOf("")), true);
});

test("only the member's latest answered plan card gives its mode: an older Yes cannot raise a mode after a later answer", () => {
  const planned = { ...mainOnMachine, agentMode: "plan", permissions: { ...mainOnMachine.permissions, workspaceWrite: false, cliApprovals: true } };
  const chat = mainSessionChatWith([deskR, planned]);
  const acceptEdits = { ...planned, agentMode: "default", permissions: { ...planned.permissions, workspaceWrite: true } };
  const card = (answer: Record<string, unknown>, answeredAt: string) => ({ ...approved("p-main", "app_tool_permission",
    { kind: "toolPermission", agentMode: "plan", toolName: "ExitPlanMode", planApproval: { plan: "# Plan" } }, answer), answeredAt });
  const oldYes = card({ approve: true, planDecision: { optionId: "yes-accept-edits-keep-context" } }, "2026-11-22T10:00:00.000Z");
  const laterNo = card({ approve: false, planDecision: { optionId: "no" } }, "2026-11-22T10:05:00.000Z");
  const laterYes = card({ approve: true, planDecision: { optionId: "yes-default-keep-context" } }, "2026-11-22T10:05:00.000Z");
  const write = (approvals: HubCard[], used: string[] = []) => members(scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, acceptEdits] } }, "machine-1",
    { rules: mainRules, approvals: approvals.map((item) => keptApproval(item)!), used: new Set(used) })).get("p-main");
  assert.equal(write([oldYes])?.agentMode, "default", "her latest answer: Accept edits");
  assert.equal(write([oldYes, laterNo])?.agentMode, "plan", "a later No, keep planning: the older Yes gives nothing");
  assert.equal(write([oldYes, laterYes], [approvalGrantKey(laterYes.answerOpId!)])?.agentMode, "plan", "a later Yes already used: the older one gives nothing either");
});

test("a plan she approved lets the machine's member follow its CLI into the mode she picked, once; nothing more", () => {
  // Claude Code in its own Plan mode on the machine (the sessions view).
  const planned = { ...mainOnMachine, agentMode: "plan", permissions: { ...mainOnMachine.permissions, workspaceWrite: false, cliApprovals: true } };
  const chat = mainSessionChatWith([deskR, planned]);
  const acceptEdits = { ...planned, agentMode: "default", permissions: { ...planned.permissions, workspaceWrite: true } };
  const plan = (optionId: string, planApproval: Record<string, unknown> = {}) => approved("p-main", "app_tool_permission",
    { kind: "toolPermission", agentMode: "plan", toolName: "ExitPlanMode", planApproval: { plan: "# Plan", ...planApproval } }, { approve: true, planDecision: { optionId } });

  // Without her Yes the write is held back: Plan stays, and so does Manual's file-edit right.
  let scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, acceptEdits] } }, "machine-1", { rules: mainRules });
  assert.equal(members(scoped).get("p-main")?.agentMode, "plan");
  assert.equal((members(scoped).get("p-main")?.permissions as Record<string, unknown>).workspaceWrite, false);

  // "Yes, auto-accept edits": Accept edits, noted so it gives it once.
  const yes = plan("yes-accept-edits-keep-context");
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, acceptEdits] } }, "machine-1", { rules: mainRules, approvals: [keptApproval(yes)!] });
  assert.equal(members(scoped).get("p-main")?.agentMode, "default");
  assert.equal((members(scoped).get("p-main")?.permissions as Record<string, unknown>).workspaceWrite, true);
  assert.ok(scoped.used.includes(approvalGrantKey(yes.answerOpId!)));
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, acceptEdits] } }, "machine-1",
    { rules: mainRules, approvals: [keptApproval(yes)!], used: new Set([approvalGrantKey(yes.answerOpId!)]) });
  assert.equal(members(scoped).get("p-main")?.agentMode, "plan", "used: nothing more");

  // "Yes, manually approve edits" gives Manual, not its file-edit right; nor Auto.
  const manual = plan("yes-default-keep-context");
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, acceptEdits] } }, "machine-1", { rules: mainRules, approvals: [keptApproval(manual)!] });
  assert.equal(members(scoped).get("p-main")?.agentMode, "default");
  assert.equal((members(scoped).get("p-main")?.permissions as Record<string, unknown>).workspaceWrite, false);
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, { ...planned, agentMode: "auto" }] } }, "machine-1", { rules: mainRules, approvals: [keptApproval(manual)!] });
  assert.equal(members(scoped).get("p-main")?.agentMode, "plan");

  // Auto only where the card offered it; a row it did not offer gives nothing.
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, { ...planned, agentMode: "auto" }] } }, "machine-1",
    { rules: mainRules, approvals: [keptApproval(plan("yes-resume-auto-mode", { autoModeAvailable: true }))!] });
  assert.equal(members(scoped).get("p-main")?.agentMode, "auto");
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, { ...planned, agentMode: "auto" }] } }, "machine-1",
    { rules: mainRules, approvals: [keptApproval(plan("yes-resume-auto-mode"))!] });
  assert.equal(members(scoped).get("p-main")?.agentMode, "plan");

  // "No, keep planning" gives nothing; what is kept of a Yes holds no plan.
  const no = approved("p-main", "app_tool_permission", { kind: "toolPermission", toolName: "ExitPlanMode", planApproval: { plan: "x" } },
    { approve: false, planDecision: { optionId: "no", feedback: "smaller" } });
  scoped = scopeMachineConversationUpdate(chat, { metadata: { participants: [deskR, acceptEdits] } }, "machine-1", { rules: mainRules, approvals: [keptApproval(no)!] });
  assert.equal(members(scoped).get("p-main")?.agentMode, "plan");
  const slim = keptApproval(yes)!;
  assert.deepEqual((slim.card as { approval: { request: unknown } }).approval.request, { kind: "toolPermission", toolName: "ExitPlanMode", planApproval: {} });
});
