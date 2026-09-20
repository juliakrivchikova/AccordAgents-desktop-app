import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { create } from "react-test-renderer";

import type { ArtifactDraftView, ArtifactSummary } from "../../../shared/types";
import { AccessArtifactForm, artifactMemberStatuses } from "./artifact-forms";

const NOW = "2026-09-19T12:00:00.000Z";

function summary(overrides: Partial<ArtifactSummary>): ArtifactSummary {
  return {
    id: "artifact-s", conversationId: "chat-1", name: "Plan", owner: "owner", contributors: [], labels: [],
    lifecycle: "published", headVersion: 3, draftRosterRevision: 0, requiredDraftCount: 0, submittedDraftCount: 0,
    createdAt: NOW, updatedAt: NOW,
    approval: { state: "unsigned", requiredSigners: ["owner", "taylor"], signedCurrent: ["owner"] },
    ...overrides
  };
}

function draft(author: string, state: ArtifactDraftView["state"]): ArtifactDraftView {
  return { id: `draft-${author}`, artifactId: "artifact-s", author, state, editRevision: 1, createdAt: NOW, updatedAt: NOW, hasContent: false };
}

const text = (statuses: Array<{ text: string }>): string[] => statuses.map((status) => status.text);

type TextNode = { children: Array<string | TextNode> };
const flatText = (node: TextNode): string => node.children.map((child) => typeof child === "string" ? child : flatText(child)).join("");

test("members show who signed the current version and who still has to", () => {
  const published = summary({});
  assert.deepEqual(text(artifactMemberStatuses("owner", published, [], [])), ["Signed v3"]);
  assert.deepEqual(text(artifactMemberStatuses("taylor", published, [draft("taylor", "submitted")], [])), ["Draft submitted", "Not signed v3"]);
  assert.deepEqual(text(artifactMemberStatuses("gera", published, [], [])), []);
});

test("collecting artifacts show who submitted a draft and who has not", () => {
  const collecting = summary({ lifecycle: "collecting_drafts", headVersion: 0, approval: { state: "none-required", requiredSigners: [], signedCurrent: [] } });
  const drafts = [draft("drew", "submitted"), draft("taylor", "editing")];
  assert.deepEqual(text(artifactMemberStatuses("drew", collecting, drafts, ["drew", "taylor", "gera"])), ["Draft submitted"]);
  assert.deepEqual(text(artifactMemberStatuses("taylor", collecting, drafts, ["drew", "taylor", "gera"])), ["Draft in progress"]);
  assert.deepEqual(text(artifactMemberStatuses("gera", collecting, drafts, ["drew", "taylor", "gera"])), ["No draft yet"]);
});

test("access popover lists status per member and is read-only for archived artifacts", async () => {
  let submitted = 0;
  const renderer = create(<AccessArtifactForm
    summary={summary({ archivedAt: NOW })}
    members={["owner", "taylor"]}
    drafts={[draft("taylor", "submitted")]}
    readOnly
    busy={false}
    onSubmit={async () => { submitted += 1; return true; }}
  />);
  const root = renderer.root;
  const status = root.findByProps({ "data-testid": "artifact-access-status-taylor" });
  assert.equal(flatText(status), "Draft submitted · Not signed v3");
  const write = root.findByProps({ "data-testid": "artifact-access-write-taylor" });
  assert.equal(write.props.disabled, true);
  await write.props.onClick();
  assert.equal(submitted, 0);
  assert.equal(root.findAllByProps({ "data-testid": "artifact-access-save-details" }).length, 0);
  renderer.unmount();
});

test("draft authors who left the chat keep their status but cannot be given access", () => {
  const renderer = create(<AccessArtifactForm
    summary={summary({ approval: { state: "approved", requiredSigners: ["owner"], signedCurrent: ["owner"] } })}
    members={["owner"]}
    drafts={[draft("gera", "submitted")]}
    busy={false}
    onSubmit={async () => true}
  />);
  const root = renderer.root;
  assert.equal(flatText(root.findByProps({ "data-testid": "artifact-access-status-gera" })), "Draft submitted");
  assert.equal(root.findByProps({ "data-testid": "artifact-access-write-gera" }).props.disabled, true);
  assert.equal(root.findAllByProps({ "data-testid": "artifact-access-sign-gera" }).length, 0);
  const ownerOptions = root.findByProps({ "data-testid": "artifact-access-owner" }).findAllByType("option").map((option) => option.props.value);
  assert.ok(!ownerOptions.includes("gera"));
  renderer.unmount();
});

test("published detail body no longer repeats owner and signers", () => {
  const detailSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-detail.tsx"), "utf8");
  assert.doesNotMatch(detailSource, /artifact-people-row|artifact-detail-head/);
});
