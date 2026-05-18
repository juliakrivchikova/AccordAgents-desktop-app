import assert from "node:assert/strict";
import test from "node:test";
import { CliAgentRunner } from "./cliAgents";
import { defaultChatAgentPermissions } from "../../shared/agentPermissions";

function makeRunner(): CliAgentRunner {
  return new CliAgentRunner();
}

function chatOptions(overrides: { agentMode: "default" | "plan"; workspaceWrite: boolean }) {
  return {
    agentMode: overrides.agentMode,
    permissions: {
      ...defaultChatAgentPermissions(),
      repoRead: true,
      workspaceWrite: overrides.workspaceWrite
    }
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
