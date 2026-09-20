import assert from "node:assert/strict";
import test from "node:test";
import { create } from "react-test-renderer";

import type { ArtifactDraftView, CollectingArtifactReadResult } from "../../../shared/types";
import { ArtifactDraftInbox } from "./draft-inbox";
import { artifactSubtitleParts } from "./artifact-version-selector";
import { TooltipProvider } from "@/components/ui/tooltip";

const NOW = "2026-09-19T12:00:00.000Z";

// ArtifactContentSurface clears its copy timer through window; node has no window.
if (typeof window === "undefined") {
  Object.assign(globalThis, { window: globalThis });
}

function draft(id: string, author: string, content: string): ArtifactDraftView {
  return {
    id, artifactId: "artifact-c", author, state: "submitted", editRevision: 1, createdAt: NOW, updatedAt: NOW,
    submittedAt: NOW, hasContent: true, content, readers: ["owner"], effectiveReaders: ["user", author]
  };
}

function collectingDetail(): CollectingArtifactReadResult {
  return {
    lifecycle: "collecting_drafts",
    summary: {
      id: "artifact-c", conversationId: "chat-1", name: "Purchase Timing Accord", owner: "drew", contributors: [],
      labels: [], lifecycle: "collecting_drafts", headVersion: 0, draftRosterRevision: 1, requiredDraftCount: 2,
      submittedDraftCount: 2, createdAt: NOW, updatedAt: NOW,
      approval: { state: "none-required", requiredSigners: [], signedCurrent: [] }
    },
    allowedDraftAuthors: ["drew", "taylor"],
    requiredDraftAuthors: ["drew", "taylor"],
    audiencePolicyByAuthor: {},
    drafts: [draft("draft-1", "drew", "# Independent proposal"), draft("draft-2", "taylor", "Second draft")],
    missingRequiredAuthors: [],
    readyToPublish: true
  };
}

test("collecting artifact body is just the selected draft", () => {
  const renderer = create(<TooltipProvider><ArtifactDraftInbox detail={collectingDetail()} /></TooltipProvider>);
  const root = renderer.root;

  assert.equal(root.findAllByProps({ "aria-label": "New artifact name" }).length, 0);
  assert.equal(root.findAllByProps({ className: "artifact-toolbar" }).length, 0);
  assert.equal(root.findAllByProps({ "data-testid": "artifact-version-selector" }).length, 0);
  assert.equal(root.findByProps({ testId: "artifact-draft-content" }).props.content, "# Independent proposal");
  renderer.unmount();
});

test("collecting artifact shows the picked draft", () => {
  const renderer = create(<TooltipProvider><ArtifactDraftInbox detail={collectingDetail()} selectedDraftId="draft-2" /></TooltipProvider>);
  assert.equal(renderer.root.findByProps({ testId: "artifact-draft-content" }).props.content, "Second draft");
  renderer.unmount();
});

test("collecting artifact header shows draft progress instead of a version", () => {
  const detail = collectingDetail();
  const parts = artifactSubtitleParts({
    lifecycle: "collecting_drafts",
    archived: false,
    draft: detail.drafts[0],
    submittedDraftCount: 2,
    requiredDraftCount: 2,
    updatedLabel: "Updated 3d ago"
  });
  // The state matters: a withdrawn or superseded draft must not read as the live one.
  assert.equal(`${parts.prefix}${parts.strong}${parts.suffix}`, "Collecting drafts 2/2 · Draft by @drew · Submitted");
  assert.doesNotMatch(`${parts.prefix}${parts.strong}${parts.suffix}`, /v0/);
});
