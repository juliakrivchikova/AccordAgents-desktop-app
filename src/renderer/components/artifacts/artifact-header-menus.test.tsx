import assert from "node:assert/strict";
import test from "node:test";
import { create } from "react-test-renderer";

import type { ArtifactDraftView, PublishedArtifactReadResult } from "../../../shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ArtifactActionsMenu, artifactMenuActions } from "./artifact-actions-menu";
import { ArtifactDetailView } from "./artifact-detail";
import { ArtifactVersionSelector, artifactPickerEntries, artifactSubtitleParts } from "./artifact-version-selector";

const NOW = "2026-09-20T12:00:00.000Z";
const noop = (): void => undefined;

test("the title menu holds sign, rename, access and archive; edit and copy stay on the content", () => {
  assert.deepEqual(artifactMenuActions({ signVersion: 2, canRename: true, canManage: true, archived: false }), ["sign", "rename", "access", "archive"]);
  assert.deepEqual(artifactMenuActions({ canRename: false, canManage: true, archived: true }), ["access", "restore"]);
  assert.deepEqual(artifactMenuActions({ canRename: false, canManage: false, archived: false }), []);
});

test("the artifact title is the menu trigger", () => {
  const renderer = create(<ArtifactActionsMenu
    title="Cloud runs rollout plan"
    approved
    meta={["Owned by @drew", "v2 · fully approved · Updated 5d ago"]}
    archived={false}
    canRename
    canManage
    busy={false}
    onSign={noop}
    onRename={noop}
    onOpenAccess={noop}
    onArchivedChange={noop}
  />);
  const trigger = renderer.root.findByProps({ "data-testid": "artifact-actions-menu" });
  assert.equal(trigger.type, "button");
  assert.match(JSON.stringify(renderer.toJSON()), /Cloud runs rollout plan/);
  assert.equal(renderer.root.findAllByProps({ className: "artifact-approved-mark" }).length, 1);
  renderer.unmount();
});

test("the version line under the title is the picker trigger", () => {
  const renderer = create(<ArtifactVersionSelector
    label={<><strong>v2</strong> by @drew · Updated 5d ago</>}
    selectedVersion={2}
    headVersion={2}
    history={[]}
    drafts={[]}
    onShowVersion={noop}
    onShowDraft={noop}
  />);
  const trigger = renderer.root.findByProps({ "data-testid": "artifact-version-selector" });
  assert.equal(trigger.type, "button");
  assert.match(JSON.stringify(renderer.toJSON()), /by @drew · Updated 5d ago/);
  renderer.unmount();
});

test("picker rows show who signed each version and the version note", () => {
  const entries = artifactPickerEntries({
    headVersion: 2,
    requiredSigners: ["drew", "gera"],
    history: [
      { version: 1, versionEventId: "v1", contentHash: "1".repeat(64), author: "drew", createdAt: NOW, signatures: [{ signer: "drew", signedAt: NOW }] },
      { version: 2, versionEventId: "v2", contentHash: "2".repeat(64), author: "drew", note: "Added idle auto-stop.", createdAt: NOW,
        signatures: [{ signer: "drew", signedAt: NOW }, { signer: "gera", signedAt: NOW }, { signer: "someone-else", signedAt: NOW }] }
    ],
    drafts: []
  });
  assert.deepEqual(entries.versions.map((entry) => [entry.title, entry.signed, entry.note]), [
    ["v2 · Current", { count: 2, required: 2 }, "Added idle auto-stop."],
    ["v1", { count: 1, required: 2 }, undefined]
  ]);
});

test("the header line names the version, or the draft being read", () => {
  const draft: ArtifactDraftView = { id: "d", artifactId: "a", author: "taylor", state: "submitted", editRevision: 1, createdAt: NOW, updatedAt: NOW, hasContent: false };
  const join = (parts: ReturnType<typeof artifactSubtitleParts>): string => `${parts.prefix}${parts.strong}${parts.suffix}`;
  const base = { lifecycle: "published" as const, submittedDraftCount: 0, requiredDraftCount: 0, updatedLabel: "Updated 5d ago" };
  assert.equal(join(artifactSubtitleParts({ ...base, archived: false, version: { version: 2, author: "drew" } })), "v2 by @drew · Updated 5d ago");
  assert.equal(join(artifactSubtitleParts({ ...base, archived: true, version: { version: 2, author: "drew" } })), "Archived · v2 by @drew · Updated 5d ago");
  assert.equal(join(artifactSubtitleParts({ ...base, archived: false, version: { version: 2, author: "drew" }, draft })), "Draft by @taylor · Submitted");
});

test("a pending signature is a shortcut next to edit, not an extra line", () => {
  const detail: PublishedArtifactReadResult = {
    lifecycle: "published",
    summary: {
      id: "a", conversationId: "chat-1", name: "Plan", owner: "drew", contributors: [], labels: [], lifecycle: "published",
      headVersion: 3, draftRosterRevision: 0, requiredDraftCount: 0, submittedDraftCount: 0, createdAt: NOW, updatedAt: NOW,
      approval: { state: "partially-signed", requiredSigners: ["user", "drew"], signedCurrent: ["drew"] }
    },
    version: { version: 3, versionEventId: "v3", contentHash: "3".repeat(64), author: "drew", content: "# Plan", createdAt: NOW, signatures: [] },
    history: []
  };
  let signed = 0;
  const props: Parameters<typeof ArtifactDetailView>[0] = {
    detail, drafts: [], mode: "view", busy: false, canEdit: true, canSign: true, alreadySigned: false, reviseBase: 3,
    showDiff: false, onStartRevise: noop, onSubmitRevise: noop, onCancelForm: noop, onSign: () => { signed += 1; },
    onShowVersion: noop, onShowDiffChange: noop, onRetryDrafts: noop
  };
  const renderer = create(<TooltipProvider><ArtifactDetailView {...props} /></TooltipProvider>);
  const shortcut = renderer.root.findByProps({ "data-testid": "artifact-sign-shortcut" });
  assert.equal(shortcut.props["aria-label"] ?? shortcut.props.label, "Sign v3");
  shortcut.props.onClick();
  assert.equal(signed, 1);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "artifact-sign-bar" }).length, 0);
  renderer.update(<TooltipProvider><ArtifactDetailView {...props} alreadySigned /></TooltipProvider>);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "artifact-sign-shortcut" }).length, 0);
  renderer.unmount();
});
