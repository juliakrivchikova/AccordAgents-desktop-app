import assert from "node:assert/strict";
import test from "node:test";
import { CliAgentRunner } from "./cliAgents";
import { CommandError } from "./command";
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

test("codexPrompt chat envelope passes the inner prompt through and does not duplicate permission text", () => {
  const runner = makeRunner() as any;
  const innerPrompt = "INNER_PROMPT_MARKER";
  const wrapped = runner.codexPrompt(innerPrompt, "/repo", undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    webAccess: false,
    canRequestPermissions: true
  }));

  assert.match(wrapped, /You are running for AccordAgents Chat in default mode/);
  assert.match(wrapped, /Read-only file inspection/);
  assert.ok(wrapped.includes(innerPrompt));
  assert.doesNotMatch(wrapped, /Shell commands are blocked for this turn/);
  assert.doesNotMatch(wrapped, /Workspace file edits are blocked for this turn/);
  assert.doesNotMatch(wrapped, /Web access is blocked for this turn/);
  assert.doesNotMatch(wrapped, /app_permissions_request_change/);
});

test("codexPrompt chat envelope reflects plan agent mode in its header", () => {
  const runner = makeRunner() as any;
  const wrapped = runner.codexPrompt("INNER", "/repo", undefined, "chat", chatOptions({
    agentMode: "plan",
    workspaceWrite: true,
    webAccess: false,
    canRequestPermissions: true
  }));

  assert.match(wrapped, /You are running for AccordAgents Chat in plan mode/);
});

test("codexPrompt chat envelope marks runs without readable context", () => {
  const runner = makeRunner() as any;
  const wrapped = runner.codexPrompt("INNER", undefined, undefined, "chat", chatOptions({
    agentMode: "default",
    workspaceWrite: false,
    canRequestPermissions: false
  }));

  assert.match(wrapped, /No repository or app-managed readable directory is available/);
});

test("commandErrorText surfaces structured result errors", () => {
  const runner = makeRunner() as any;
  const error = new CommandError("claude exited with code 1", {
    command: "claude",
    args: [],
    stdout: JSON.stringify({
      type: "result",
      is_error: true,
      result: "You've hit your session limit; resets 4:10pm"
    }),
    stderr: "",
    exitCode: 1,
    timedOut: false
  });

  const message = runner.commandErrorText(error);

  assert.match(message, /You've hit your session limit/);
  assert.doesNotMatch(message, /Last events: result\./);
});
