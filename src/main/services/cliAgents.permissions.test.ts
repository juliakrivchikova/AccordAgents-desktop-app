import assert from "node:assert/strict";
import test from "node:test";
import { CliAgentRunner } from "./cliAgents";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";

function makeRunner(): CliAgentRunner {
  return new CliAgentRunner();
}

function chatOptions(overrides: {
  agentMode: "default" | "plan";
  workspaceWrite: boolean;
  webAccess?: boolean;
  shell?: ReturnType<typeof defaultChatAgentPermissions>["shell"];
  canRequestPermissions?: boolean;
}) {
  const permissions = defaultChatAgentPermissions();
  return {
    agentMode: overrides.agentMode,
    permissions: {
      ...permissions,
      repoRead: true,
      workspaceWrite: overrides.workspaceWrite,
      webAccess: overrides.webAccess ?? false,
      shell: overrides.shell ?? permissions.shell
    },
    appMcp: overrides.canRequestPermissions
      ? {
          url: "http://127.0.0.1:1/mcp",
          token: "token",
          toolNames: ["app_permissions_request_change"]
        }
      : undefined
  };
}

test("claudeToolConfig maps default + workspaceWrite=true to acceptEdits", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: true
  }));
  assert.equal(config.permissionMode, "acceptEdits");
  assert.ok(config.tools.includes("Write"));
  assert.ok(config.tools.includes("Edit"));
  assert.equal(config.disallowedTools.includes("Write"), false);
  assert.equal(config.disallowedTools.includes("Edit"), false);
});

test("claudeToolConfig maps default + workspaceWrite=false to default and disallows editors", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false
  }));
  assert.equal(config.permissionMode, "default");
  assert.equal(config.tools.includes("Write"), false);
  assert.equal(config.tools.includes("Edit"), false);
  assert.ok(config.disallowedTools.includes("Write"));
  assert.ok(config.disallowedTools.includes("Edit"));
  assert.ok(config.disallowedTools.includes("MultiEdit"));
  assert.ok(config.disallowedTools.includes("NotebookEdit"));
});

test("claudeToolConfig auto-allows web tools when webAccess is true", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: true
  }));
  assert.ok(config.tools.includes("WebSearch"));
  assert.ok(config.tools.includes("WebFetch"));
  assert.ok(config.allowedTools.includes("WebSearch"));
  assert.ok(config.allowedTools.includes("WebFetch"));
  assert.equal(config.disallowedTools.includes("WebSearch"), false);
  assert.equal(config.disallowedTools.includes("WebFetch"), false);
});

test("claudeToolConfig disallows web tools when webAccess is false", () => {
  const runner = makeRunner() as any;
  const config = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false
  }));
  assert.equal(config.tools.includes("WebSearch"), false);
  assert.equal(config.tools.includes("WebFetch"), false);
  assert.equal(config.allowedTools.includes("WebSearch"), false);
  assert.equal(config.allowedTools.includes("WebFetch"), false);
  assert.ok(config.disallowedTools.includes("WebSearch"));
  assert.ok(config.disallowedTools.includes("WebFetch"));
});

test("claudeToolConfig leaves plan agent mode untouched regardless of workspaceWrite", () => {
  const runner = makeRunner() as any;
  const planNoWrite = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "plan",
    workspaceWrite: false
  }));
  const planWithWrite = runner.claudeToolConfig("chat", "/repo", [], chatOptions({
    agentMode: "plan",
    workspaceWrite: true
  }));
  assert.equal(planNoWrite.permissionMode, "plan");
  assert.equal(planWithWrite.permissionMode, "plan");
  // plan mode disables workspaceWrite via effective permissions, so editors stay disallowed
  assert.ok(planWithWrite.disallowedTools.includes("Write"));
});

test("codexPrompt chat uses permission-request guidance for blocked capabilities", () => {
  const runner = makeRunner() as any;
  const prompt = runner.codexPrompt("Handle the request.", "/repo", undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false,
    canRequestPermissions: true
  }));

  assert.match(prompt, /Shell commands are blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*shellRules/);
  assert.match(prompt, /Workspace file edits are blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*workspaceWrite/);
  assert.match(prompt, /Web access is blocked for this turn/);
  assert.match(prompt, /app_permissions_request_change.*webAccess/);
  assert.doesNotMatch(prompt, /General shell commands are blocked/);
  assert.doesNotMatch(prompt, /Do not edit files/);
  assert.doesNotMatch(prompt, /Do not use web search/);
});

test("codexPrompt chat keeps explicit shell deny rules as hard stops", () => {
  const runner = makeRunner() as any;
  const prompt = runner.codexPrompt("Handle the request.", "/repo", undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    shell: {
      enabled: true,
      rules: [{ action: "deny", match: "exact", pattern: "rm -rf" }]
    },
    canRequestPermissions: true
  }));

  assert.match(prompt, /deny exact "rm -rf"/);
  assert.match(prompt, /Deny rules are strict hard stops for matching commands/);
  assert.match(prompt, /do not request escalation for commands that match a deny rule/);
  assert.match(prompt, /outside these rules/);
});

test("codexPrompt chat uses explanation fallback when permission requests are unavailable", () => {
  const runner = makeRunner() as any;
  const prompt = runner.codexPrompt("Handle the request.", "/repo", undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false,
    canRequestPermissions: false
  }));

  assert.match(prompt, /explain the specific command and shell rule needed before refusing/);
  assert.match(prompt, /explain that `workspaceWrite` is needed before refusing/);
  assert.match(prompt, /explain that `webAccess` is needed before refusing/);
  assert.doesNotMatch(prompt, /app_permissions_request_change/);
});

test("codexPrompt chat does not suggest escalation for agent-mode masked shell and workspace grants", () => {
  const runner = makeRunner() as any;
  const prompt = runner.codexPrompt("Handle the request.", "/repo", undefined, "chat", chatOptions({
    agentMode: "plan",
    workspaceWrite: true,
    webAccess: false,
    shell: {
      enabled: true,
      rules: [{ action: "allow", match: "prefix", pattern: "npm run" }]
    },
    canRequestPermissions: true
  }));

  assert.match(prompt, /Shell commands are blocked by the current agent mode/);
  assert.match(prompt, /Workspace file edits are blocked by the current agent mode/);
  assert.match(prompt, /app_permissions_request_change.*webAccess/);
  assert.doesNotMatch(prompt, /shellRules/);
  assert.doesNotMatch(prompt, /workspaceWrite/);
});
