import assert from "node:assert/strict";
import test from "node:test";
import { act, create } from "react-test-renderer";

import type { PublishedArtifactReadResult } from "../../../shared/types";
import { ArtifactDetailView } from "./artifact-detail";
import { TooltipProvider } from "@/components/ui/tooltip";

const NOW = "2026-09-19T12:00:00.000Z";

function publishedDetail(content: string): PublishedArtifactReadResult {
  return {
    lifecycle: "published",
    summary: {
      id: "artifact-preview",
      conversationId: "chat-1",
      name: "Preview",
      owner: "user",
      contributors: [],
      labels: [],
      lifecycle: "published",
      headVersion: 1,
      draftRosterRevision: 0,
      requiredDraftCount: 0,
      submittedDraftCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      approval: { state: "none-required", requiredSigners: [], signedCurrent: [] }
    },
    version: { version: 1, versionEventId: "fixture-preview-1", contentHash: "1".repeat(64), author: "user", content, createdAt: NOW, signatures: [] },
    history: []
  };
}

test("revise preview renders the unsaved edit without leaving revise mode", () => {
  const noop = (): void => undefined;
  const saved: Array<[string, string | undefined]> = [];
  let cancelled = 0;
  const props: Parameters<typeof ArtifactDetailView>[0] = {
    detail: publishedDetail("original"), drafts: [], mode: "revise", busy: false, canEdit: true, canSign: false,
    alreadySigned: false, reviseBase: 1, showDiff: false, renaming: false, renameValue: "", onRenameValueChange: noop,
    onStartRename: noop, onCancelRename: noop, onSubmitRename: noop, onStartRevise: noop,
    onSubmitRevise: (content, note) => { saved.push([content, note]); },
    onCancelForm: () => { cancelled += 1; }, onSign: noop, onShowVersion: noop, onShowDiffChange: noop, onRetryDrafts: noop
  };
  const renderer = create(<TooltipProvider><ArtifactDetailView {...props} /></TooltipProvider>);
  const edited = "# Draft title\n\nNew body";

  act(() => renderer.root.findByProps({ id: "artifact-revise-content" }).props.onChange({ target: { value: edited } }));
  act(() => renderer.root.findByProps({ "data-testid": "artifact-revise-preview-toggle" }).props.onClick());

  assert.equal(cancelled, 0);
  assert.equal(renderer.root.findByProps({ id: "artifact-revise-content" }).props.hidden, true);
  const preview = renderer.root.findByProps({ "data-testid": "artifact-revise-preview" });
  const heading = preview.findByType("h4");
  assert.equal(heading.props.className, "markdown-heading markdown-heading-1");
  assert.equal(heading.children.join(""), "Draft title");

  act(() => renderer.root.findByProps({ "data-testid": "artifact-revise-edit-toggle" }).props.onClick());
  assert.equal(renderer.root.findByProps({ id: "artifact-revise-content" }).props.value, edited);
  assert.equal(renderer.root.findByProps({ id: "artifact-revise-content" }).props.hidden, false);
  assert.equal(renderer.root.findAllByProps({ "data-testid": "artifact-revise-preview" }).length, 0);

  act(() => renderer.root.findByProps({ "data-testid": "artifact-revise-preview-toggle" }).props.onClick());
  act(() => renderer.root.findByProps({ "aria-label": "Save as v2" }).props.onClick());
  assert.deepEqual(saved, [[edited, undefined]]);
  assert.equal(cancelled, 0);
  act(() => renderer.unmount());
});
