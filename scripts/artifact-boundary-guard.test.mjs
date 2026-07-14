import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const forbidden = [
  { label: "Accord", pattern: /\baccord\b/i },
  { label: "facilitator", pattern: /\bfacilitator\b/i },
  { label: "proposal", pattern: /\bproposals?\b/i },
  { label: "synthesis", pattern: /\bsynthesi(?:s|ze|zed|zing)\b/i },
  { label: "consensus", pattern: /\bconsensus\b/i },
  { label: "canonical", pattern: /\bcanonical\b/i },
  { label: "reviewer", pattern: /\breviewers?\b/i },
  { label: "blind", pattern: /\bblind(?:ness)?\b/i },
  { label: "independent draft/source", pattern: /\bindependent\s+(?:drafts?|sources?)\b/i },
  { label: "participant handle", pattern: /\bparticipant\s+handles?\b/i }
];

function source(path) {
  return readFileSync(resolve(path), "utf8");
}

function between(path, start, end) {
  const value = source(path);
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `${path}: start marker is missing`);
  assert.notEqual(to, -1, `${path}: end marker is missing`);
  return value.slice(from, to);
}

function assertGeneric(path, value) {
  // `window.consensus` is the existing application-wide preload namespace,
  // not artifact vocabulary. Keep that compatibility identifier out of this
  // narrowly scoped terminology contract.
  const inspected = value.replaceAll("window.consensus", "window.appBridge");
  for (const entry of forbidden) {
    const match = inspected.match(entry.pattern);
    assert.equal(match, null, `${path}: generic artifact surface contains ${entry.label}: ${match?.[0] ?? ""}`);
  }
}

test("generic artifact surfaces contain no workflow-specific terminology", () => {
  const wholeFiles = [
    "src/main/services/artifacts.ts",
    "src/main/services/artifactStore.ts",
    "src/main/services/artifactToolRequest.ts",
    "src/shared/artifacts.ts",
    "src/main/services/artifacts.test.ts",
    "src/main/services/appMcp.artifacts.test.ts",
    "src/renderer/components/artifacts/artifact-drafts.test.tsx",
    "src/renderer/styles/views/artifacts.css"
  ];
  for (const path of wholeFiles) {
    assertGeneric(path, source(path));
  }

  const rendererDirectory = "src/renderer/components/artifacts";
  for (const name of readdirSync(resolve(rendererDirectory))) {
    if (!/\.tsx?$/.test(name) || name.endsWith(".test.tsx")) {
      continue;
    }
    const path = `${rendererDirectory}/${name}`;
    assertGeneric(path, source(path));
  }

  assertGeneric(
    "src/main/services/appMcp.ts#artifactToolDefinitions",
    between(
      "src/main/services/appMcp.ts",
      "// Definitions for the artifact tools every chat participant gets.",
      "export interface AppMcpActor"
    )
  );
  assertGeneric(
    "src/shared/types.ts#artifactContracts",
    between(
      "src/shared/types.ts",
      "export const ARTIFACT_USER_MEMBER",
      "export interface AppBridge"
    )
  );
  assertGeneric(
    "src/shared/types.ts#artifactBridge",
    between(
      "src/shared/types.ts",
      "  listArtifacts(request: ListArtifactsRequest)",
      "  onReviewProgress(callback:"
    )
  );
  assertGeneric(
    "src/preload/index.ts#artifactBridge",
    between(
      "src/preload/index.ts",
      "  listArtifacts: (request: ListArtifactsRequest)",
      "  onReviewProgress: (callback:"
    )
  );
  assertGeneric(
    "src/main/main.ts#artifactDispatch",
    between(
      "src/main/main.ts",
      "function artifactToolNumber(value: unknown)",
      "function appSkillsSourceRoot()"
    )
  );
});
