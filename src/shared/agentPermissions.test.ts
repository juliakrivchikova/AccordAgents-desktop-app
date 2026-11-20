import assert from "node:assert/strict";
import test from "node:test";
import {
  chatAgentModeWithin,
  chatAgentPermissionsWithin,
  clampChatAgentMode,
  clampChatAgentPermissions,
  effectiveChatAgentPermissionsForProvider,
  normalizeChatAgentPermissions
} from "./agentPermissions";
import type { ChatAgentPermissions } from "./types";

function permissions(patch: Partial<ChatAgentPermissions> = {}): ChatAgentPermissions {
  return normalizeChatAgentPermissions({
    repoRead: true,
    workspaceWrite: false,
    webAccess: false,
    requestParticipants: "ask",
    requestCompaction: "ask",
    shell: { enabled: false, rules: [] },
    ...patch
  });
}

test("a member made by another never gets a right its parent does not have", () => {
  const parent = permissions({
    repoRead: true,
    workspaceWrite: true,
    webAccess: false,
    requestParticipants: "ask",
    requestCompaction: "allow",
    manageRolesParticipants: "allow",
    shell: {
      enabled: true,
      rules: [
        { action: "allow", match: "prefix", pattern: "git diff" },
        { action: "deny", match: "prefix", pattern: "git push" }
      ]
    },
    providerNative: { "claude-code": { allowedTools: ["mcp__github__get_issue"] } }
  });
  const child = clampChatAgentPermissions(permissions({
    repoRead: true,
    workspaceWrite: true,
    webAccess: true,
    requestParticipants: "allow",
    requestCompaction: "allow",
    shell: {
      enabled: true,
      rules: [
        { action: "allow", match: "prefix", pattern: "git diff" },
        { action: "allow", match: "prefix", pattern: "rm" },
        { action: "ask", match: "exact", pattern: "npm test" },
        { action: "deny", match: "prefix", pattern: "curl" }
      ]
    },
    providerNative: { "claude-code": { allowedTools: ["mcp__github__get_issue", "mcp__slack__post"] } }
  }), parent);

  assert.equal(child.repoRead, true);
  assert.equal(child.workspaceWrite, true);
  assert.equal(child.webAccess, false, "web only when the parent has it");
  assert.equal(child.requestParticipants, "ask", "never above the parent's");
  assert.equal(child.requestCompaction, "allow");
  assert.equal(child.shell.enabled, true);
  assert.deepEqual(child.shell.rules, [
    { action: "allow", match: "prefix", pattern: "git diff" },
    { action: "deny", match: "prefix", pattern: "curl" },
    { action: "deny", match: "prefix", pattern: "git push" }
  ], "only the parent's allow rules; its own and the parent's deny rules stay");
  assert.deepEqual(child.providerNative, { "claude-code": { allowedTools: ["mcp__github__get_issue"] } });
  assert.equal(child.manageRolesParticipants, "deny", "a child does not create members unless asked to");
  assert.equal(chatAgentPermissionsWithin(child, parent), true);
});

test("shell is on only when the parent's is, whatever the child asks for", () => {
  const parent = permissions({ shell: { enabled: false, rules: [{ action: "allow", match: "prefix", pattern: "ls" }] } });
  const child = clampChatAgentPermissions(permissions({ shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "ls" }] } }), parent);
  assert.equal(child.shell.enabled, false);
});

test("member requests and compaction rank deny < ask < allow", () => {
  for (const [wanted, limit, expected] of [
    ["allow", "allow", "allow"],
    ["allow", "ask", "ask"],
    ["allow", "deny", "deny"],
    ["ask", "allow", "ask"],
    ["deny", "allow", "deny"]
  ] as const) {
    const child = clampChatAgentPermissions(permissions({ requestParticipants: wanted, requestCompaction: wanted }), permissions({ requestParticipants: limit, requestCompaction: limit }));
    assert.equal(child.requestParticipants, expected, `${wanted} under ${limit}`);
    assert.equal(child.requestCompaction, expected, `${wanted} under ${limit}`);
  }
});

test("managing members only when asked for explicitly, and never above the parent's", () => {
  const parent = permissions({ manageRolesParticipants: "ask" });
  assert.equal(clampChatAgentPermissions(permissions(), parent).manageRolesParticipants, "deny");
  assert.equal(clampChatAgentPermissions(permissions({ manageRolesParticipants: "allow" }), parent).manageRolesParticipants, "ask");
  assert.equal(clampChatAgentPermissions(permissions({ manageRolesParticipants: "allow" }), permissions({ manageRolesParticipants: "allow" })).manageRolesParticipants, "allow");
  assert.equal(clampChatAgentPermissions(permissions({ manageRolesParticipants: "allow" }), permissions()).manageRolesParticipants, "deny", "no right of its own: none");
});

test("the ceiling is what the parent really has in its mode", () => {
  const stored = permissions({ repoRead: true, workspaceWrite: true, webAccess: false, shell: { enabled: true, rules: [] } });
  // Plan: no edits and no shell, whatever is stored.
  const plan = effectiveChatAgentPermissionsForProvider("claude-code", "plan", stored);
  const underPlan = clampChatAgentPermissions(stored, plan);
  assert.equal(underPlan.workspaceWrite, false);
  assert.equal(underPlan.shell.enabled, false);
  // Auto turns rights on: the child may have them.
  const auto = effectiveChatAgentPermissionsForProvider("codex-cli", "auto", stored);
  const underAuto = clampChatAgentPermissions(permissions({ webAccess: true, workspaceWrite: true, shell: { enabled: true, rules: [] } }), auto);
  assert.equal(underAuto.webAccess, true);
  assert.equal(underAuto.workspaceWrite, true);
  assert.equal(underAuto.shell.enabled, true);
});

test("modes clamp plan < default < auto", () => {
  assert.equal(clampChatAgentMode("auto", "default"), "default");
  assert.equal(clampChatAgentMode("auto", "auto"), "auto");
  assert.equal(clampChatAgentMode("default", "plan"), "plan");
  assert.equal(clampChatAgentMode("plan", "auto"), "plan");
  assert.equal(clampChatAgentMode(undefined, "auto"), "default");
  assert.equal(chatAgentModeWithin("auto", "default"), false);
  assert.equal(chatAgentModeWithin("plan", "default"), true);
});

test("within: a broader right, rule or tool is caught", () => {
  const parent = permissions({ shell: { enabled: true, rules: [{ action: "allow", match: "prefix", pattern: "git diff" }] }, providerNative: { "claude-code": { allowedTools: ["A", "B"] } } });
  assert.equal(chatAgentPermissionsWithin(permissions({ webAccess: true }), parent), false);
  assert.equal(chatAgentPermissionsWithin(permissions({ shell: { enabled: true, rules: [{ action: "ask", match: "exact", pattern: "rm" }] } }), parent), false);
  assert.equal(chatAgentPermissionsWithin(permissions({ shell: { enabled: true, rules: [{ action: "deny", match: "exact", pattern: "rm" }] } }), parent), true);
  assert.equal(chatAgentPermissionsWithin(permissions({ providerNative: { "claude-code": { allowedTools: ["A"] } } }), parent), true, "fewer tools is narrower");
  assert.equal(chatAgentPermissionsWithin(permissions({ providerNative: { "claude-code": { allowedTools: ["C"] } } }), parent), false);
  assert.equal(chatAgentPermissionsWithin(permissions({ requestParticipants: "allow" }), parent), false);
});
