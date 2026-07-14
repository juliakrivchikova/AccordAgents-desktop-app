import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { ArtifactDiffResult, ArtifactResult, ArtifactSummary } from "../../../shared/types";
import { loadArtifactDiff } from "./artifact-diff-loader";

test("late diff success and failure cannot replace the latest selection", async () => {
  const pending = deferred<ArtifactResult<ArtifactDiffResult>>();
  let generation = 1;
  const first = loadArtifactDiff({
    bridge: { diffArtifactVersions: async () => pending.promise },
    conversationId: "chat-1",
    artifactId: "artifact-a",
    fromVersion: 1,
    toVersion: 2,
    isCurrent: () => generation === 1
  });
  generation = 2;
  pending.resolve({ ok: true, value: { summary: summary(), fromVersion: 1, toVersion: 2, diff: "+late" } });
  assert.equal(await first, undefined);

  const rejected = deferred<ArtifactResult<ArtifactDiffResult>>();
  const second = loadArtifactDiff({
    bridge: { diffArtifactVersions: async () => rejected.promise },
    conversationId: "chat-1",
    artifactId: "artifact-b",
    fromVersion: 1,
    toVersion: 2,
    isCurrent: () => generation === 2
  });
  generation = 3;
  rejected.resolve({ ok: false, error: { code: "invalid_request", message: "late failure" } });
  assert.equal(await second, undefined);
});

test("historical revise waits for a current head load before opening the form", () => {
  const source = readFileSync(resolve("src/renderer/components/artifacts/artifacts-panel.tsx"), "utf8");
  assert.match(source, /const head = await loadDetail\(detail\.summary\.id\)/);
  assert.match(source, /setReviseBase\(head\.summary\.headVersion\)/);
  assert.match(source, /if \(!head \|\| head\.lifecycle !== "published"/);
});

function summary(): ArtifactSummary {
  return {
    id: "artifact-a", conversationId: "chat-1", name: "A", owner: "user",
    contributors: [], labels: [], lifecycle: "published", headVersion: 2,
    draftRosterRevision: 0, requiredDraftCount: 0, submittedDraftCount: 0,
    createdAt: "2026-07-13T12:00:00.000Z", updatedAt: "2026-07-13T12:00:00.000Z",
    approval: { state: "none-required", requiredSigners: [], signedCurrent: [] }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
