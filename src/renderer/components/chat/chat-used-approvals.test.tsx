import assert from "node:assert/strict";
import test from "node:test";
import { create, type ReactTestInstance } from "react-test-renderer";

import type { ChatAppToolApproval, ChatParticipant, ChatParticipantConfig } from "../../../shared/types";
import { ChatAppToolApprovalCard } from "./chat-app-tool-approval-card";
import { formatChatTime } from "./chat-format";

const AT = "2026-11-18T15:29:00.000Z";
const participants = [
  { id: "p-taylor", handle: "taylor-claude-engineer", roleConfigId: "software-engineer", kind: "claude-code" },
  { id: "p-jill", handle: "jill", roleConfigId: "software-engineer", kind: "codex-cli" }
] as unknown as ChatParticipant[];
const saved = [{ id: "cfg-drew", handle: "drew" }] as unknown as ChatParticipantConfig[];
const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");
const at = formatChatTime(AT);
const who = "@taylor-claude-engineer";

function approval(patch: Partial<ChatAppToolApproval>): ChatAppToolApproval {
  return {
    id: `a-${patch.toolName}-${patch.status}`, conversationId: "chat-1", requesterParticipantId: "p-taylor", requesterHandle: "taylor-claude-engineer",
    requesterRoleConfigId: "software-engineer", capability: "participants.request", status: "approved", summary: "", request: {},
    createdAt: "2026-11-18T15:20:00.000Z", updatedAt: AT, ...patch
  } as ChatAppToolApproval;
}

const scriptRequest = (patch: Record<string, unknown> = {}) => ({
  kind: "script-change", op: "create", scriptId: "s1", name: "Morning Sentry digest", description: "", hostId: "local", hostLabel: "This Mac",
  hostPhrase: "this Mac", runtime: "node", entry: "main.mjs", schedule: { kind: "cron" }, scheduleText: "weekdays at 09:00", timeoutSeconds: 60,
  secretNames: [], permissions: { chatIds: [], participantIds: [], maxWakeupsPerHour: 1 }, chatLabels: {}, participantLabels: {}, fileCount: 1, totalBytes: 10,
  ...patch
}) as never;
const signInRequest = { kind: "connectorSignIn", connector: "claude.ai Gmail", action: "sign-in" } as never;
const codexRequest = {
  kind: "codexApproval", method: "item/commandExecution/requestApproval", requestId: "r1", threadId: "t", turnId: "u", itemId: "i", action: "command",
  options: [{ id: "accept", label: "Allow once", outcome: "approve" }, { id: "decline", label: "Deny", outcome: "deny" }]
} as never;

function line(item: ChatAppToolApproval) {
  const renderer = create(
    <ChatAppToolApprovalCard approval={item} participants={participants} savedParticipants={saved} roles={[]} submitting={false} onRespond={async () => undefined} />
  );
  const root = renderer.root;
  const rows = root.findAll((node) => node.props?.className === "chat-card-row");
  const section = root.findAll((node) => node.type === "section")[0];
  return {
    rows: rows.length,
    preview: rows[0] ? textOf(rows[0].find((node) => node.props?.className === "chat-card-row-preview")) : undefined,
    outcome: rows[0] ? textOf(rows[0].find((node) => node.props?.className === "chat-card-row-outcome")) : undefined,
    title: rows[0]?.props.title as string | undefined,
    label: section?.props["aria-label"] as string | undefined,
    section: section?.props.className as string | undefined,
    id: section?.props["data-app-tool-approval-id"] as string | undefined,
    text: textOf(root),
    buttons: root.findAllByType("button").length,
    unmount: () => renderer.unmount()
  };
}

test("a used member, role, task, sign-in or Codex card is one line: what it was, who asked, how it ended, when (the User, 2026-11-18)", () => {
  const cases: Array<[string, ChatAppToolApproval, string, string]> = [
    ["member added", approval({ toolName: "app_participants_request_change", summary: "Add @drew",
      request: { operations: [{ type: "add_existing_participant_to_chat", participantConfigId: "cfg-drew" }] } as never }),
    "Add @drew", `${who} · Member added ${at}`],
    ["member removed", approval({ toolName: "app_participants_request_change", summary: "Remove @jill from this chat", appliedParticipantIds: ["p-jill"],
      request: { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: "p-jill", handle: "jill" }] } as never }),
    "Remove @jill from this chat", `${who} · Member removed ${at}`],
    ["role refused", approval({ toolName: "app_roles_request_change", status: "denied", summary: "Create role \"Reviewer\"",
      request: { operations: [{ type: "create_role", role: { label: "Reviewer", instructions: "Review." } }] } as never }),
    "Create role \"Reviewer\"", `${who} · Request cancelled ${at}`],
    ["task approved", approval({ toolName: "app_scripts_request_change", summary: "Add scheduled task", request: scriptRequest() }),
      "Morning Sentry digest", `${who} · Approved · weekdays at 09:00`],
    ["task created without a card", approval({ toolName: "app_scripts_request_change", status: "auto-applied", summary: "Add scheduled task", request: scriptRequest(),
      machineDecisionPending: { decisionId: "d", machineName: "Box", approve: true, at: AT } }),
      "Morning Sentry digest", `${who} · Created · weekdays at 09:00`],
    ["task declined", approval({ toolName: "app_scripts_request_change", status: "denied", summary: "Add scheduled task", request: scriptRequest() }),
      "Morning Sentry digest", `${who} · Declined ${at}`],
    ["signed in", approval({ toolName: "app_connector_sign_in", summary: "Sign in to claude.ai Gmail", consumedAt: AT, request: signInRequest }),
      "claude.ai Gmail", `${who} · Connected ${at}`],
    ["not now", approval({ toolName: "app_connector_sign_in", status: "denied", summary: "Sign in to claude.ai Gmail", request: signInRequest }),
      "claude.ai Gmail", `${who} · Not now ${at}`],
    ["codex approved", approval({ toolName: "codex_auto_review_approval", capability: "permissions.request", summary: "Run git push origin main",
      request: codexRequest, resumeContext: { runId: "run", triggerMessageId: "m" } }),
    "Run git push origin main", `${who} · Approved ${at}`]
  ];
  for (const [name, item, preview, outcome] of cases) {
    const shown = line(item);
    assert.equal(shown.rows, 1, `${name}: one line`);
    assert.equal(shown.preview, preview, `${name}: what it was`);
    assert.equal(shown.outcome, outcome, `${name}: who asked, how it ended, when`);
    assert.equal(shown.buttons, 0, `${name}: nothing to press`);
    assert.match(shown.section ?? "", /chat-used-approval/, `${name}: placed as a folded alert`);
    assert.equal(shown.id, item.id, `${name}: found by its id (Activity's Open in chat)`);
    assert.match(shown.label ?? "", /^(Member change|Member removal|Role change|Scheduled task|Connector sign-in|Codex approval)\. /, `${name}: its kind first`);
    assert.ok(shown.label?.includes(`${preview}: ${outcome}`), `${name}: named by what it shows, not by the question it asked`);
    shown.unmount();
  }
  // The whole of a cut-off line, and why it ended so, on hover and in its name.
  const removed = line(cases[1][1]);
  assert.match(removed.title ?? "", /@jill left this chat\./);
  assert.match(removed.label ?? "", /@jill left this chat\./);
  removed.unmount();
});

test("an approved card she edited names what was applied, not what the member first asked for", () => {
  const added = line(approval({ toolName: "app_participants_request_change", summary: "Add @drew-reviewer",
    request: { operations: [{ type: "add_new_participant_to_chat", participant: { handle: "reviewer", roleConfigId: "software-engineer", kind: "claude-code" } }] } as never }));
  assert.equal(added.preview, "Add @reviewer");
  added.unmount();
  const role = line(approval({ toolName: "app_roles_request_change", summary: "Create role \"QA\"",
    request: { operations: [{ type: "create_role", role: { label: "Tester", instructions: "Test." } }] } as never }));
  assert.equal(role.preview, "Create role \"Tester\"");
  role.unmount();
  const deleted = line(approval({ toolName: "app_roles_request_change", summary: "Delete role \"Old\"",
    request: { operations: [{ type: "archive_role", role: { roleConfigId: "old" } }] } as never }));
  assert.equal(deleted.preview, "Delete role \"Old\"", "a deleted role is named only by its summary");
  deleted.unmount();
  // Her saved members were renamed since (drew-codex-engineer is drew now):
  // a saved member keeps the handle it was added under.
  const renamed = line(approval({ toolName: "app_participants_request_change", summary: "Add @drew-codex-engineer",
    request: { operations: [{ type: "add_existing_participant_to_chat", participantConfigId: "cfg-drew" }] } as never }));
  assert.equal(renamed.preview, "Add @drew-codex-engineer");
  renamed.unmount();
});

test("an approved scheduled task ends as the button she pressed", () => {
  const ops: Array<[string, string]> = [
    ["create", `${who} · Approved · weekdays at 09:00`],
    ["update", `${who} · Approved · weekdays at 09:00`],
    ["enable", `${who} · Switched on · weekdays at 09:00`],
    ["disable", `${who} · Switched off ${at}`],
    ["delete", `${who} · Deleted ${at}`]
  ];
  for (const [op, outcome] of ops) {
    const shown = line(approval({ toolName: "app_scripts_request_change", summary: "Scheduled task", request: scriptRequest({ op }) }));
    assert.equal(shown.outcome, outcome, op);
    shown.unmount();
  }
});

test("a used card that failed or still waits says so on its line, and why on hover", () => {
  const failed = line(approval({ toolName: "app_participants_request_change", status: "denied", summary: "Add @drew",
    error: "@drew is already in this chat",
    request: { operations: [{ type: "add_existing_participant_to_chat", participantConfigId: "cfg-drew" }] } as never }));
  assert.equal(failed.outcome, `${who} · Not applied ${at}`, "approved, then making the change failed: not her refusal");
  assert.match(failed.title ?? "", /@drew is already in this chat/);
  failed.unmount();

  const connectorCases: Array<[Partial<ChatAppToolApproval>, string, RegExp]> = [
    [{ consumedAt: AT, error: "Server refused the token" }, "Not connected", /Server refused the token/],
    [{}, "Reconnecting", /Reconnecting claude\.ai Gmail/],
    [{ status: "cancelled", error: "The member's turn ended" }, "Closed", /Closed: The member's turn ended/],
    [{ status: "expired" }, "Closed", /Closed without an answer/]
  ];
  for (const [patch, ended, why] of connectorCases) {
    const shown = line(approval({ toolName: "app_connector_sign_in", summary: "Sign in", request: signInRequest, ...patch }));
    assert.equal(shown.outcome, `${who} · ${ended} ${at}`);
    assert.match(shown.title ?? "", why);
    shown.unmount();
  }

  for (const [status, ended] of [["cancelled", "Cancelled"], ["expired", "Expired"]] as const) {
    const shown = line(approval({ toolName: "app_scripts_request_change", status, summary: "Add scheduled task", error: "The host went away",
      request: scriptRequest() }));
    assert.equal(shown.outcome, `${who} · ${ended} ${at}`);
    assert.match(shown.title ?? "", /The host went away/);
    shown.unmount();
  }
  const noSchedule = line(approval({ toolName: "app_scripts_request_change", summary: "Add scheduled task", request: scriptRequest({ scheduleText: undefined }) }));
  assert.equal(noSchedule.outcome, `${who} · Approved ${at}`, "never 'Approved · undefined'");
  noSchedule.unmount();

  const codexFailed = line(approval({ toolName: "codex_auto_review_approval", capability: "permissions.request", summary: "Run make deploy",
    error: "Codex had already moved on", request: codexRequest, resumeContext: { runId: "run", triggerMessageId: "m" } }));
  assert.equal(codexFailed.preview, "Run make deploy");
  assert.match(codexFailed.title ?? "", /Codex had already moved on/);
  codexFailed.unmount();
});

test("a card still asking, or answered and waiting for its machine, is not folded", () => {
  const asking = line(approval({ toolName: "app_connector_sign_in", status: "pending", summary: "Sign in to claude.ai Gmail",
    request: { kind: "connectorSignIn", connector: "claude.ai Gmail", action: "sign-in", authUrl: "https://claude.ai/x" } as never }));
  assert.equal(asking.rows, 0);
  assert.ok(asking.buttons > 0, "it asks");
  asking.unmount();
  const queued = { machineDecisionPending: { decisionId: "d1", machineName: "Box", approve: true, at: AT } };
  const waiting: Array<[string, ChatAppToolApproval, RegExp]> = [
    ["sign-in", approval({ toolName: "app_connector_sign_in", status: "approved", summary: "Sign in", request: signInRequest, ...queued }), /Waiting for machine Box/],
    ["task", approval({ toolName: "app_scripts_request_change", status: "approved", summary: "Add scheduled task", request: scriptRequest(), ...queued }), /Waiting for machine Box/],
    ["member", approval({ toolName: "app_participants_request_change", status: "auto-applied", summary: "Add @drew", ...queued,
      request: { operations: [{ type: "add_existing_participant_to_chat", participantConfigId: "cfg-drew" }] } as never }), /Waiting for machine Box/]
  ];
  for (const [name, item, says] of waiting) {
    const shown = line(item);
    assert.equal(shown.rows, 0, `${name}: its answer is not applied yet`);
    assert.match(shown.text, says, name);
    shown.unmount();
  }
  // A removal its member's setting allowed asked nobody: it folds, and says it waits.
  const removal = line(approval({ toolName: "app_participants_request_change", status: "auto-applied", summary: "Remove @jill from this chat", ...queued,
    request: { kind: "participant_removal", operations: [{ type: "remove_participant_from_chat", participantId: "p-jill", handle: "jill" }] } as never }));
  assert.equal(removal.rows, 1);
  assert.equal(removal.outcome, `${who} · Removal approved ${at}`);
  assert.match(removal.title ?? "", /Waiting for running turns to finish/);
  removal.unmount();
});

test("a Bash card offers \"for this chat\" in Claude Code's words, scoped to the command prefixes; one it cannot scope offers once only", () => {
  const bash = (request: Record<string, unknown>) => approval({ toolName: "app_tool_permission", capability: "permissions.request", status: "pending",
    summary: "Use Bash", request: { kind: "toolPermission", agentMode: "default", toolName: "Bash", ...request } as never });
  const scoped = line(bash({ toolInput: { command: "mkdir -p /tmp/a && date" }, chatScope: { kind: "commands", prefixes: ["mkdir", "date"] } }));
  assert.match(scoped.text, /Yes, allow once/);
  assert.match(scoped.text, /Yes, and don't ask again for mkdir and date commands in this chat/);
  assert.doesNotMatch(scoped.text, /to use Bash in this chat/, "never the whole of Bash");
  scoped.unmount();
  const opaque = line(bash({ toolInput: { command: "echo $(whoami)" } }));
  assert.match(opaque.text, /Yes, allow once/);
  assert.doesNotMatch(opaque.text, /in this chat/);
  opaque.unmount();
  const web = line(approval({ toolName: "app_tool_permission", capability: "permissions.request", status: "pending", summary: "Use WebFetch",
    request: { kind: "toolPermission", agentMode: "default", toolName: "WebFetch", toolInput: { url: "https://docs.example.com/" }, chatScope: { kind: "domain", domain: "docs.example.com" } } as never }));
  assert.match(web.text, /Yes, and don't ask again for docs\.example\.com in this chat/);
  web.unmount();
});
