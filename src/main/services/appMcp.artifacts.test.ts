import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_ARTIFACT_DRAFT_LIST_TOOL,
  APP_ARTIFACT_DRAFT_READ_TOOL,
  APP_ARTIFACT_DRAFT_REPLACE_TOOL,
  APP_ARTIFACT_DRAFT_SAVE_TOOL,
  APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL,
  APP_ARTIFACT_DRAFT_SUBMIT_TOOL,
  APP_ARTIFACT_DRAFT_WITHDRAW_TOOL,
  APP_ARTIFACT_CREATE_TOOL,
  APP_ARTIFACT_PUBLISH_TOOL,
  artifactToolDefinitions
} from "./appMcp";
import { validateArtifactCreateToolRequest } from "./artifactToolRequest";

interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

test("draft MCP tools expose lifecycle operations without caller-controlled identity", () => {
  const definitions = artifactToolDefinitions() as ToolDefinition[];
  const expected = [
    APP_ARTIFACT_DRAFT_LIST_TOOL,
    APP_ARTIFACT_DRAFT_READ_TOOL,
    APP_ARTIFACT_DRAFT_SAVE_TOOL,
    APP_ARTIFACT_DRAFT_SUBMIT_TOOL,
    APP_ARTIFACT_DRAFT_REPLACE_TOOL,
    APP_ARTIFACT_DRAFT_WITHDRAW_TOOL,
    APP_ARTIFACT_DRAFT_SET_ROSTER_TOOL,
    APP_ARTIFACT_PUBLISH_TOOL
  ];
  for (const name of expected) {
    const definition = definitions.find((candidate) => candidate.name === name);
    assert.ok(definition, `missing ${name}`);
    const schema = JSON.stringify(definition.inputSchema);
    assert.doesNotMatch(schema, /"actor"/);
    assert.doesNotMatch(schema, /"author"/);
  }

  const save = definitions.find((candidate) => candidate.name === APP_ARTIFACT_DRAFT_SAVE_TOOL);
  assert.match(JSON.stringify(save?.inputSchema), /"operationId"/);
  assert.match(JSON.stringify(save?.inputSchema), /"readers"/);
  assert.match(save?.description ?? "", /before submission/);
  const publish = definitions.find((candidate) => candidate.name === APP_ARTIFACT_PUBLISH_TOOL);
  assert.match(JSON.stringify(publish?.inputSchema), /"sources"/);
  assert.match(JSON.stringify(publish?.inputSchema), /"requiredSigners"/);

  const create = definitions.find((candidate) => candidate.name === APP_ARTIFACT_CREATE_TOOL);
  const createSchema = JSON.stringify(create?.inputSchema);
  assert.match(createSchema, /"if".*"collecting_drafts"/);
  assert.match(createSchema, /"then".*"operationId"/);
  assert.match(createSchema, /"else".*"content"/);
  assert.match(createSchema, /"then".*"not".*"content".*"note".*"requiredSigners"/);
  assert.match(createSchema, /"else".*"not".*"allowedDraftAuthors".*"operationId"/);

  const replace = definitions.find((candidate) => candidate.name === APP_ARTIFACT_DRAFT_REPLACE_TOOL);
  assert.match(replace?.title ?? "", /Editable/);
  assert.match(replace?.description ?? "", /does not submit or freeze/i);
  assert.match(replace?.description ?? "", /Submit Artifact Draft/);
});

test("create dispatch validation rejects mixed lifecycle fields", () => {
  assert.match(validateArtifactCreateToolRequest({
    initialState: "collecting_drafts",
    content: "unexpected"
  }) ?? "", /content/);
  assert.match(validateArtifactCreateToolRequest({
    initialState: "collecting_drafts",
    note: "unexpected"
  }) ?? "", /note/);
  assert.match(validateArtifactCreateToolRequest({
    initialState: "published",
    operationId: "unexpected"
  }) ?? "", /operationId/);
  assert.match(validateArtifactCreateToolRequest({ initialState: "unknown" }) ?? "", /initialState/);
  assert.equal(validateArtifactCreateToolRequest({ initialState: "collecting_drafts" }), undefined);
  assert.equal(validateArtifactCreateToolRequest({ content: "v1" }), undefined);
});
