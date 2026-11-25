import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_ARTIFACT_CREATE_TOOL, APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL, APP_CHAT_REQUEST_COMPACTION_TOOL,
  APP_CHAT_REQUEST_PARTICIPANTS_TOOL, APP_PERMISSIONS_REQUEST_CHANGE_TOOL, AppMcpService
} from "./appMcp";
import { appMcpParts } from "./appMcp/test/appMcpParts";
import { toolsForActor } from "./appMcp/protocol";
import { ROLE } from "./chat/test/permissionFixtures";

test("app MCP denial diagnostics keep stable app-server codes without request content", async () => {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const secretCanary = "CANARY_SECRET /private/artifact/path";
  const appMcp = new AppMcpService({
    async write(event, payload) {
      events.push({ event, payload });
    }
  });
  appMcp.setArtifactToolHandler(async () => ({
    ok: false,
    error: { code: "ARTIFACT_AUDIENCE_DENIED", message: secretCanary }
  }));
  const actor = {
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: []
  };

  await appMcpParts(appMcp).toolCalls.callTool(actor, {
    name: APP_ARTIFACT_CREATE_TOOL,
    arguments: { content: secretCanary }
  });
  await assert.rejects(
    () => appMcpParts(appMcp).toolCalls.callTool(actor, {
      name: APP_PERMISSIONS_REQUEST_CHANGE_TOOL,
      arguments: { reason: secretCanary }
    }),
    /not allowed/
  );

  assert.deepEqual(events.map((item) => item.payload.code), [
    "ARTIFACT_AUDIENCE_DENIED",
    "APP_TOOL_CAPABILITY_DENIED"
  ]);
  assert.equal(events.every((item) => item.payload.layer === "first-party-app-server-policy"), true);
  assert.equal(JSON.stringify(events).includes(secretCanary), false);
});

test("app MCP advertises self-compaction only with compaction permission", () => {
  const appMcp = new AppMcpService();
  const actor = {
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version
  };
  const without = toolsForActor({ ...actor, capabilities: [] }) as Array<{ name: string }>;
  const withCapability = toolsForActor({
    ...actor,
    capabilities: ["compaction.request"]
  }) as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;

  assert.equal(without.some((tool) => tool.name === APP_CHAT_REQUEST_COMPACTION_TOOL), false);
  const tool = withCapability.find((item) => item.name === APP_CHAT_REQUEST_COMPACTION_TOOL);
  assert.ok(tool);
  assert.ok(tool.inputSchema?.properties?.instructions);
});

test("app MCP tracks client generation setup and required tools", async () => {
  const appMcp = new AppMcpService();
  const actor = {
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: ["participants.request"],
    clientGenerationId: "client-generation-1",
    expectedToolNames: [
      APP_CHAT_REQUEST_PARTICIPANTS_TOOL,
      APP_CHAT_GET_PARTICIPANT_REQUEST_STATUS_TOOL
    ]
  };

  await appMcpParts(appMcp).mcpServer.handleRpcRequest(actor, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {}
  });
  let status = appMcp.clientStatus("client-generation-1");
  assert.equal(status?.initialized, true);
  assert.equal(status?.listedTools, false);

  await appMcpParts(appMcp).mcpServer.handleRpcRequest(actor, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  status = appMcp.clientStatus("client-generation-1");
  assert.equal(status?.listedTools, true);
  assert.equal(status?.requiredToolsPresent, true);
  assert.deepEqual(status?.missingToolNames, []);
});

test("app MCP client generation records missing expected tools", async () => {
  const appMcp = new AppMcpService();
  const actor = {
    conversationId: "conversation-1",
    participantId: "participant-1",
    roleConfigId: ROLE.id,
    roleConfigVersion: ROLE.version,
    capabilities: [],
    clientGenerationId: "client-generation-missing",
    expectedToolNames: ["missing-tool"]
  };

  await appMcpParts(appMcp).mcpServer.handleRpcRequest(actor, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {}
  });
  const status = appMcp.clientStatus("client-generation-missing");

  assert.equal(status?.listedTools, true);
  assert.equal(status?.requiredToolsPresent, false);
  assert.deepEqual(status?.missingToolNames, ["missing-tool"]);
});
