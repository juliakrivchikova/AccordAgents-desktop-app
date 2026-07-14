import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { act, create } from "react-test-renderer";

import type {
  AppBridge,
  ArtifactDraftView,
  ArtifactError,
  ArtifactReadResult,
  ArtifactResult,
  CollectingArtifactReadResult,
  PublishedArtifactReadResult
} from "../../../shared/types";
import { artifactSummaryStatusLabel } from "../../../shared/artifacts";
import { loadArtifactDetail } from "./artifact-detail-loader";
import { ArtifactVersionSelector } from "./artifact-version-selector";

const NOW = "2026-07-13T12:00:00.000Z";

test("collecting artifact renders one selector and one draft body", () => {
  const inboxSource = readFileSync(resolve("src/renderer/components/artifacts/draft-inbox.tsx"), "utf8");
  assert.match(inboxSource, /<ArtifactVersionSelector/);
  assert.match(inboxSource, /const selectedDraft =/);
  assert.match(inboxSource, /selectedContent\.content/);
  assert.doesNotMatch(inboxSource, /detail\.drafts\.map/);
});

test("one selector contains every version and draft with author labels", () => {
  const selected: number[] = [];
  const shownDrafts: string[] = [];
  const renderer = create(<ArtifactVersionSelector
    selectedVersion={5}
    headVersion={5}
    history={[
      { version: 1, author: "owner", createdAt: NOW, signatures: [] },
      { version: 5, author: "owner", createdAt: NOW, signatures: [] }
    ]}
    drafts={[publishedDraft()]}
    onShowVersion={(version) => selected.push(version)}
    onShowDraft={(draftId) => shownDrafts.push(draftId)}
  />);
  const text = JSON.stringify(renderer.toJSON());
  assert.match(text, /Versions/);
  assert.match(text, /Drafts/);
  assert.match(text, /Draft by @author-two/);
  const selector = renderer.root.findByProps({ "data-testid": "artifact-version-selector" });
  act(() => selector.props.onChange({ currentTarget: { value: "version:1" } }));
  act(() => selector.props.onChange({ currentTarget: { value: "draft:draft-a" } }));
  assert.deepEqual(selected, [1]);
  assert.deepEqual(shownDrafts, ["draft-a"]);
});

test("selector marks the head version current while viewing history", () => {
  const renderer = create(<ArtifactVersionSelector
    selectedVersion={1}
    headVersion={5}
    history={[
      { version: 1, author: "owner", createdAt: NOW, signatures: [] },
      { version: 5, author: "owner", createdAt: NOW, signatures: [] }
    ]}
    drafts={[]}
    onShowVersion={() => undefined}
    onShowDraft={() => undefined}
  />);
  const options = renderer.root.findAllByType("option");
  assert.match(options.find((option) => option.props.value === "version:5")?.children.join("") ?? "", /Current/);
  assert.doesNotMatch(options.find((option) => option.props.value === "version:1")?.children.join("") ?? "", /Current/);
});

test("published artifact selector keeps initial draft content available", () => {
  const detailSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-detail.tsx"), "utf8");
  const panelSource = readFileSync(resolve("src/renderer/components/artifacts/artifacts-panel.tsx"), "utf8");
  const loaderSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-detail-loader.ts"), "utf8");
  assert.match(detailSource, /selectedDraft \?/);
  assert.match(detailSource, /data-testid="artifact-draft-author"/);
  assert.match(detailSource, /artifactMemberLabel\(selectedDraft\.author\)/);
  assert.match(detailSource, /testId="artifact-draft-content"/);
  assert.doesNotMatch(detailSource, /<ArtifactDraftArchive drafts=\{\[selectedDraft\]\}/);
  assert.match(panelSource, /loadArtifactDetail/);
  assert.match(loaderSource, /listArtifactDrafts/);
  assert.match(panelSource, /drafts=\{drafts\}/);
  const styles = readFileSync(resolve("src/renderer/styles/views/artifacts.css"), "utf8");
  assert.match(styles, /\.artifact-detail\s*\{[^}]*overflow-y:\s*auto/s);
});

test("the detail surface renders one selected version or one selected draft", () => {
  const detailSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-detail.tsx"), "utf8");
  assert.match(detailSource, /selectedDraft \? \([\s\S]*content=\{selectedDraftContent\.content\}/);
  assert.match(detailSource, /:\s*\([\s\S]*content=\{detail\.version\.content\}/);
  assert.doesNotMatch(detailSource, /Version history/);
});

test("show diff toggle replaces version content instead of adding a comparison panel", () => {
  const detailSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-detail.tsx"), "utf8");
  const panelSource = readFileSync(resolve("src/renderer/components/artifacts/artifacts-panel.tsx"), "utf8");
  assert.match(detailSource, /data-testid="artifact-show-diff-toggle"/);
  assert.match(detailSource, /props\.showDiff \? \(/);
  assert.match(detailSource, /data-testid="artifact-version-diff"/);
  assert.match(detailSource, /testId="artifact-version-content"/);
  assert.doesNotMatch(detailSource, /Compare with v|Comparison v/);
  assert.match(panelSource, /detail\.version\.version - 1/);
  assert.match(panelSource, /generation === compareGeneration\.current/);
});

test("artifact content has an attached copy action and no copy-reference action", () => {
  const detailSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-detail.tsx"), "utf8");
  const inboxSource = readFileSync(resolve("src/renderer/components/artifacts/draft-inbox.tsx"), "utf8");
  const contentSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-content-surface.tsx"), "utf8");
  assert.match(contentSource, /data-testid="artifact-copy-content"/);
  assert.match(contentSource, /navigator\.clipboard\.writeText\(props\.content\)/);
  assert.match(detailSource, /testId="artifact-draft-content"/);
  assert.match(detailSource, /testId="artifact-version-content"/);
  assert.doesNotMatch(detailSource, /Copy reference|artifactReference/);
  assert.doesNotMatch(detailSource, /ArtifactSourceManifest|Version sources/);
  assert.doesNotMatch(inboxSource, /Copy reference|artifactReference/);
});

test("collecting detail does not render every draft body at once", () => {
  const inboxSource = readFileSync(resolve("src/renderer/components/artifacts/draft-inbox.tsx"), "utf8");
  assert.match(inboxSource, /selectedDraft/);
  assert.match(inboxSource, /<ArtifactVersionSelector/);
  assert.doesNotMatch(inboxSource, /drafts\.map/);
  assert.doesNotMatch(inboxSource, /ArtifactDraftArchive|PublicationPreflight/);
});

test("published details distinguish draft-list failure from an ordinary artifact", () => {
  const detailSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-detail.tsx"), "utf8");
  const loaderSource = readFileSync(resolve("src/renderer/components/artifacts/artifact-detail-loader.ts"), "utf8");
  assert.match(detailSource, /props\.draftError[\s\S]*Drafts could not be loaded/);
  assert.match(detailSource, /selectedDraft[\s\S]*testId="artifact-draft-content"/);
  assert.doesNotMatch(detailSource, /No drafts were collected/);
  assert.match(loaderSource, /requiredDraftCount[\s\S]*submittedDraftCount[\s\S]*avoid an irrelevant draft-list IPC call/);
});

test("newer revisions still load the initial draft archive", async () => {
  const detail = publishedDetail("artifact-a", "Artifact A", "VERSION FIVE", false);
  detail.summary.headVersion = 5;
  detail.summary.requiredDraftCount = 2;
  detail.summary.submittedDraftCount = 2;
  detail.version.version = 5;
  detail.history = [
    { version: 1, author: "owner", createdAt: NOW, signatures: [] },
    { version: 5, author: "owner", createdAt: NOW, signatures: [] }
  ];
  let archiveReads = 0;
  let drafts: ArtifactDraftView[] = [];
  await loadArtifactDetail({
    bridge: {
      readArtifact: async () => ({ ok: true, value: detail }),
      listArtifactDrafts: async () => {
        archiveReads += 1;
        return { ok: true, value: [publishedDraft()] };
      }
    },
    conversationId: "chat-1",
    artifactId: detail.summary.id,
    isCurrent: () => true,
    callbacks: {
      onReadError: () => undefined,
      onDetail: () => undefined,
      onDrafts: (nextDrafts) => { drafts = nextDrafts; }
    }
  });
  assert.equal(archiveReads, 1);
  assert.equal(drafts[0]?.id, "draft-a");
});

test("artifact status labels never describe collecting artifacts as v0", () => {
  const collecting = collectingDetail().summary;
  assert.equal(artifactSummaryStatusLabel(collecting), "Collecting drafts · 2/2 submitted");
  assert.doesNotMatch(artifactSummaryStatusLabel(collecting), /v0|no signers/i);
  assert.equal(artifactSummaryStatusLabel({ ...collecting, lifecycle: "published", headVersion: 1 }), "v1 · no signers required");
});

test("latest artifact selection ignores a late draft-archive success", async () => {
  const pending = deferred<ArtifactResult<ArtifactDraftView[]>>();
  const { state, firstLoad, select } = await artifactSwitch(pending.promise);
  await select("artifact-b");
  pending.resolve({ ok: true, value: [publishedDraft()] });
  await firstLoad;
  assert.equal(state.detail?.summary.id, "artifact-b");
  assert.equal(state.drafts.length, 0);

  await select("artifact-a");
  assert.equal(state.detail?.summary.id, "artifact-a");
  assert.equal(state.drafts[0]?.id, "draft-a");
});

test("latest artifact selection ignores a late draft-archive failure", async () => {
  const pending = deferred<ArtifactResult<ArtifactDraftView[]>>();
  const { state, firstLoad, select } = await artifactSwitch(pending.promise);
  await select("artifact-b");
  pending.resolve({ ok: false, error: { code: "invalid_request", message: "late A failure" } });
  await firstLoad;
  assert.equal(state.detail?.summary.id, "artifact-b");
  assert.equal(state.drafts.length, 0);
  assert.equal(state.draftError, undefined);
  assert.equal(state.readError, undefined);
});

function collectingDetail(): CollectingArtifactReadResult {
  return {
    lifecycle: "collecting_drafts",
    summary: {
      id: "artifact-1",
      conversationId: "chat-1",
      name: "Draft collection",
      owner: "owner",
      contributors: ["author-two"],
      labels: [],
      lifecycle: "collecting_drafts",
      headVersion: 0,
      draftRosterRevision: 0,
      requiredDraftCount: 2,
      submittedDraftCount: 2,
      createdAt: NOW,
      updatedAt: NOW,
      approval: { state: "none-required", requiredSigners: [], signedCurrent: [] }
    },
    allowedDraftAuthors: ["owner", "author-two"],
    requiredDraftAuthors: ["owner", "author-two"],
    audiencePolicyByAuthor: {
      owner: { allowedReaders: [], requiredReaders: [] },
      "author-two": { allowedReaders: ["owner"], requiredReaders: ["owner"] }
    },
    drafts: [
      {
        id: "draft-f",
        artifactId: "artifact-1",
        author: "owner",
        state: "submitted",
        editRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        submittedAt: NOW,
        hasContent: true,
        content: "OWNER DRAFT BODY",
        readers: [],
        effectiveReaders: ["user", "owner"]
      },
      {
        id: "draft-p",
        artifactId: "artifact-1",
        author: "author-two",
        state: "submitted",
        editRevision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        submittedAt: NOW,
        hasContent: true,
        content: "AUTHOR TWO DRAFT BODY",
        readers: ["owner"],
        effectiveReaders: ["user", "author-two", "owner"]
      }
    ],
    missingRequiredAuthors: [],
    readyToPublish: true
  };
}

interface ArtifactSwitchState {
  detail?: ArtifactReadResult;
  drafts: ArtifactDraftView[];
  draftError?: ArtifactError;
  readError?: ArtifactError;
}

async function artifactSwitch(
  firstArchiveRead: Promise<ArtifactResult<ArtifactDraftView[]>>
): Promise<{
  state: ArtifactSwitchState;
  firstLoad: Promise<void>;
  select: (artifactId: string) => Promise<void>;
}> {
  let firstARead = true;
  let generation = 0;
  const state: ArtifactSwitchState = { drafts: [] };
  const details = {
    "artifact-a": publishedDetail("artifact-a", "Artifact A", "ARTIFACT A BODY", true),
    "artifact-b": publishedDetail("artifact-b", "Artifact B", "ARTIFACT B BODY", false)
  };
  const bridge: Pick<AppBridge, "readArtifact" | "listArtifactDrafts"> = {
    readArtifact: async ({ artifactId }) => ({ ok: true, value: details[artifactId as keyof typeof details] }),
    listArtifactDrafts: async ({ artifactId }) => {
      if (artifactId === "artifact-a" && firstARead) {
        firstARead = false;
        return firstArchiveRead;
      }
      return { ok: true, value: artifactId === "artifact-a" ? [publishedDraft()] : [] };
    }
  };
  const select = async (artifactId: string): Promise<void> => {
    const selectedGeneration = ++generation;
    await loadArtifactDetail({
      bridge,
      conversationId: "chat-1",
      artifactId,
      isCurrent: () => selectedGeneration === generation,
      callbacks: {
        onReadError: (error) => {
          state.detail = undefined;
          state.drafts = [];
          state.draftError = undefined;
          state.readError = error;
        },
        onDetail: (detail) => { state.detail = detail; },
        onDrafts: (drafts, error) => {
          state.drafts = drafts;
          state.draftError = error;
        }
      }
    });
  };
  const firstLoad = select("artifact-a");
  await flush();
  return {
    state,
    firstLoad,
    select
  };
}

function publishedDetail(
  id: string,
  name: string,
  content: string,
  withSources: boolean
): PublishedArtifactReadResult {
  return {
    lifecycle: "published",
    summary: {
      id,
      conversationId: "chat-1",
      name,
      owner: "user",
      contributors: [],
      labels: [],
      lifecycle: "published",
      headVersion: 1,
      draftRosterRevision: 0,
      requiredDraftCount: withSources ? 1 : 0,
      submittedDraftCount: withSources ? 1 : 0,
      createdAt: NOW,
      updatedAt: NOW,
      approval: { state: "none-required", requiredSigners: [], signedCurrent: [] }
    },
    version: { version: 1, author: "user", content, createdAt: NOW, signatures: [] },
    history: [],
    sources: withSources ? [{
      draftId: "draft-a",
      author: "author-two",
      submittedAt: NOW,
      contentHash: "a".repeat(64),
      disposition: "considered"
    }] : undefined
  };
}

function publishedDraft(): ArtifactDraftView {
  return {
    id: "draft-a",
    artifactId: "artifact-a",
    author: "author-two",
    state: "submitted",
    editRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    submittedAt: NOW,
    hasContent: true,
    content: "ARTIFACT A DRAFT",
    readers: ["owner"],
    effectiveReaders: ["user", "author-two", "owner"]
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
