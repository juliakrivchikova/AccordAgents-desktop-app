import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type {
  ArtifactDiffResult,
  ArtifactDraftView,
  ArtifactReadResult,
  ArtifactResult,
  ArtifactSummary,
  CollectingArtifactReadResult,
  PublishedArtifactReadResult
} from "../../../shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ArtifactDetailView } from "./artifact-detail";
import { ArtifactsPanel } from "./artifacts-panel";

declare global {
  var ACCORD_RENDERER_JSDOM: boolean | undefined;
}

const NOW = "2026-09-20T12:00:00.000Z";
const ARTIFACT_ID = "artifact-sel";

function summary(headVersion: number): ArtifactSummary {
  return {
    id: ARTIFACT_ID,
    conversationId: "chat-1",
    name: "Cloud runs rollout plan",
    owner: "drew",
    contributors: ["user"],
    labels: [],
    lifecycle: "published",
    headVersion,
    draftRosterRevision: 0,
    requiredDraftCount: 1,
    submittedDraftCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    approval: { state: "none-required", requiredSigners: [], signedCurrent: [] }
  };
}

function published(version: number, headVersion = version): PublishedArtifactReadResult {
  return {
    lifecycle: "published",
    summary: summary(headVersion),
    version: {
      version,
      versionEventId: `event-${version}`,
      contentHash: String(version).repeat(64).slice(0, 64),
      author: "drew",
      content: `# Version ${version}`,
      createdAt: NOW,
      signatures: []
    },
    history: Array.from({ length: headVersion }, (_unused, index) => ({
      version: index + 1,
      versionEventId: `event-${index + 1}`,
      contentHash: String(index + 1).repeat(64).slice(0, 64),
      author: "drew",
      createdAt: NOW,
      signatures: []
    }))
  };
}

function draft(state: ArtifactDraftView["state"]): ArtifactDraftView {
  return {
    id: "draft-taylor",
    artifactId: ARTIFACT_ID,
    author: "taylor",
    state,
    editRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    submittedAt: NOW,
    hasContent: true,
    content: "Draft body from taylor",
    readers: ["user"],
    effectiveReaders: ["user", "taylor"]
  };
}

function collecting(draftState: ArtifactDraftView["state"]): CollectingArtifactReadResult {
  return {
    lifecycle: "collecting_drafts",
    summary: { ...summary(0), lifecycle: "collecting_drafts", headVersion: 0, requiredDraftCount: 2, submittedDraftCount: 1 },
    allowedDraftAuthors: ["taylor", "drew"],
    requiredDraftAuthors: ["taylor", "drew"],
    audiencePolicyByAuthor: {},
    drafts: [draft(draftState)],
    missingRequiredAuthors: ["drew"],
    readyToPublish: false
  };
}

interface Bridge {
  readVersions: number[];
  diffCalls: Array<{ fromVersion: number; toVersion: number }>;
  // When set, diffArtifactVersions parks until released, so the render between "a new
  // head arrived" and "its diff resolved" is observable instead of being skipped over.
  holdDiff?: { release: () => void };
  detail: ArtifactReadResult;
  // The panel keys its refresh on the identity of the summary in the artifacts list, the
  // way a real `artifacts:updated` hands it a freshly deserialized one. Keeping it stable
  // here means a re-render alone does not refresh; `refresh()` is what makes it one.
  listSummary: ArtifactSummary;
  drafts: ArtifactResult<ArtifactDraftView[]>;
  diff: ArtifactResult<ArtifactDiffResult>;
}

function installBridge(bridge: Bridge): void {
  Object.defineProperty(window, "consensus", {
    configurable: true,
    value: {
      readArtifact: async (request: { version?: number }) => {
        bridge.readVersions.push(request.version ?? 0);
        const wanted = request.version;
        const detail = wanted === undefined || bridge.detail.lifecycle !== "published"
          ? bridge.detail
          : { ...bridge.detail, version: published(wanted, bridge.detail.summary.headVersion).version };
        return { ok: true as const, value: detail };
      },
      listArtifactDrafts: async () => bridge.drafts,
      diffArtifactVersions: async (request: { fromVersion: number; toVersion: number }) => {
        bridge.diffCalls.push({ fromVersion: request.fromVersion, toVersion: request.toVersion });
        if (bridge.holdDiff) {
          await new Promise<void>((resolve) => { bridge.holdDiff = { release: resolve }; });
        }
        return bridge.diff;
      }
    }
  });
}

function panel(bridge: Bridge): JSX.Element {
  return (
    <TooltipProvider>
      <ArtifactsPanel
        conversationId="chat-1"
        members={["user", "drew", "taylor"]}
        artifacts={[bridge.listSummary]}
        selectedId={ARTIFACT_ID}
        onSelect={() => undefined}
        onClose={() => undefined}
      />
    </TooltipProvider>
  );
}

function freshBridge(): Bridge {
  const detail = published(3);
  return {
    readVersions: [],
    diffCalls: [],
    detail,
    listSummary: detail.summary,
    drafts: { ok: true, value: [draft("submitted")] },
    diff: { ok: true, value: { summary: summary(3), fromVersion: 2, toVersion: 3, diff: "+added line" } }
  };
}

async function mountPanel(bridge: Bridge): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(panel(bridge)); });
  return { container, root };
}

// One event-driven refresh: a new summary identity, exactly what listArtifacts produces.
async function refresh(root: Root, bridge: Bridge): Promise<void> {
  bridge.listSummary = { ...bridge.detail.summary };
  await act(async () => { root.render(panel(bridge)); });
}

const body = (container: HTMLElement): string => container.textContent ?? "";

// Radix opens on pointerdown and selects on click, so a bare .click() on the trigger
// leaves the menu closed and every row assertion fails for the wrong reason.
function pointer(node: Element, type: string): void {
  node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, view: window }));
}

async function openMenu(node: HTMLElement): Promise<void> {
  await act(async () => { pointer(node, "pointerdown"); });
}

async function chooseRow(node: HTMLElement): Promise<void> {
  await act(async () => {
    pointer(node, "pointermove");
    pointer(node, "pointerdown");
    pointer(node, "pointerup");
    node.click();
  });
}

function menuRow(match: (text: string) => boolean): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"],[role="menuitem"]')]
    .find((node) => match(node.textContent ?? ""));
}

async function openPicker(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="artifact-version-selector"]');
  assert.ok(trigger, "the version picker trigger should be in the header");
  await openMenu(trigger);
}

async function pickDraft(container: HTMLElement): Promise<void> {
  await openPicker(container);
  const row = menuRow((text) => text.includes("Draft by @taylor"));
  assert.ok(row, "the picker should offer the submitted draft");
  await chooseRow(row);
}

// Finding 1: withdraw and supersede keep the draft row (the server only changes `state`,
// and listDrafts returns every state), so the fallback must not fire for them — and it
// must not fire on a draft list the panel could not load either.
test("a draft list that failed to load keeps the picked draft on screen", async () => {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  const bridge = freshBridge();
  installBridge(bridge);
  const { container, root } = await mountPanel(bridge);
  try {
    await pickDraft(container);
    assert.match(body(container), /Draft body from taylor/);

    // The next refresh cannot reach the draft list. The loader reports `[]` with an error.
    bridge.drafts = { ok: false, error: { code: "invalid_request", message: "drafts unavailable" } };
    await refresh(root, bridge);

    assert.match(body(container), /drafts unavailable/, "the failure should be reported");
    assert.match(body(container), /Draft body from taylor/, "the picked draft must survive a failed list");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a collecting artifact names the state of the draft on screen", async () => {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  const bridge = freshBridge();
  // A collecting artifact shows its first draft by default and its counter has already
  // moved on, so the header is the only thing that can say the draft is not live.
  bridge.detail = collecting("withdrawn");
  bridge.listSummary = bridge.detail.summary;
  bridge.drafts = { ok: true, value: [draft("withdrawn")] };
  installBridge(bridge);
  const { container, root } = await mountPanel(bridge);
  try {
    assert.match(body(container), /Draft body from taylor/, "a withdrawn draft is still readable");
    assert.match(body(container), /Collecting drafts 1\/2/);
    assert.match(body(container), /Withdrawn/, "the header must name the state, not imply it is live");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a draft that really is gone from a loaded list falls back to the version", async () => {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  const bridge = freshBridge();
  installBridge(bridge);
  const { container, root } = await mountPanel(bridge);
  try {
    await pickDraft(container);
    assert.match(body(container), /Draft body from taylor/);

    bridge.drafts = { ok: true, value: [] };
    await refresh(root, bridge);

    assert.doesNotMatch(body(container), /Draft body from taylor/);
    assert.match(body(container), /Version 3/, "the reader should land on the version body");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

// Finding 8: picking a draft while an older version is pinned left `viewVersion` set, so
// the refresh effect kept re-reading that version and dismissing the draft returned the
// reader to it instead of the head.
test("picking a draft drops an older-version pin", async () => {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  const bridge = freshBridge();
  installBridge(bridge);
  const { container, root } = await mountPanel(bridge);
  try {
    await openPicker(container);
    const older = menuRow((text) => text.startsWith("v1"));
    assert.ok(older, "the picker should offer v1");
    await chooseRow(older);
    assert.match(body(container), /not the current version/, "an older version is announced");

    await pickDraft(container);
    bridge.readVersions.length = 0;
    await refresh(root, bridge);

    assert.deepEqual(bridge.readVersions, [0], "the refresh must read the head, not the pinned v1");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

// Finding 3: the caption came from `detail.version` while the body came from `compare`, so
// a background publish printed "Changes from v3 to v4" over the v2-to-v3 text.
test("the changes caption never describes a pair the body is not showing", async () => {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  const bridge = freshBridge();
  installBridge(bridge);
  const { container, root } = await mountPanel(bridge);
  try {
    const titleTrigger = container.querySelector<HTMLButtonElement>('[data-testid="artifact-actions-menu"]');
    assert.ok(titleTrigger);
    await openMenu(titleTrigger);
    const changes = document.querySelector<HTMLElement>('[data-testid="artifact-show-diff-toggle"]');
    assert.ok(changes, "the title menu should offer the Changes view");
    await chooseRow(changes);

    assert.match(body(container), /Changes from v2 to v3/);
    assert.match(body(container), /\+added line/);
    assert.deepEqual(bridge.diffCalls, [{ fromVersion: 2, toVersion: 3 }]);

    // An agent publishes v4 while the Changes view is open, and the recompute for the new
    // pair is still in flight. The only diff loaded is v2-to-v3, so nothing on screen may
    // claim to be showing v3-to-v4 yet.
    bridge.detail = published(4);
    bridge.diff = { ok: true, value: { summary: summary(4), fromVersion: 3, toVersion: 4, diff: "+newer line" } };
    bridge.holdDiff = { release: () => undefined };
    await refresh(root, bridge);

    const held = bridge.holdDiff;
    assert.ok(held, "the recompute should have been requested");
    await act(async () => { held.release(); await Promise.resolve(); });

    const settled = body(container);
    assert.match(settled, /Changes from v3 to v4/, "the recompute should land on the new pair");
    assert.match(settled, /\+newer line/);
    assert.deepEqual(bridge.diffCalls, [{ fromVersion: 2, toVersion: 3 }, { fromVersion: 3, toVersion: 4 }]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

// The wrong-caption window is a single commit, which act() collapses at the panel level, so
// the guard has to sit on the view: given a compare for one pair and a version for another,
// nothing rendered may describe the newer pair.
test("a diff for a superseded pair is never captioned as the current one", async () => {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  const noop = (): void => undefined;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props: Parameters<typeof ArtifactDetailView>[0] = {
    detail: published(4),
    drafts: [],
    mode: "view",
    busy: false,
    canEdit: true,
    canSign: false,
    alreadySigned: false,
    reviseBase: 4,
    // What the panel holds for one render after a background publish moves the head to v4.
    compare: { fromVersion: 2, toVersion: 3, diff: "+stale line" },
    showDiff: true,
    onStartRevise: noop,
    onSubmitRevise: noop,
    onCancelForm: noop,
    onSign: noop,
    onShowVersion: noop,
    onShowDiffChange: noop,
    onRetryDrafts: noop
  };
  try {
    await act(async () => { root.render(<TooltipProvider><ArtifactDetailView {...props} /></TooltipProvider>); });
    const shown = container.textContent ?? "";
    assert.doesNotMatch(shown, /\+stale line/, "the v2-to-v3 body must not be shown beside v4");
    assert.doesNotMatch(shown, /Changes from v3 to v4/, "and must never be captioned as v3-to-v4");
    assert.match(shown, /Loading diff…/, "a mismatched pair reads as loading until the recompute lands");
    assert.equal(container.querySelector('[data-testid="artifact-version-diff"]'), null);

    // Once the matching pair arrives, caption, aria-label and body agree.
    await act(async () => {
      root.render(<TooltipProvider><ArtifactDetailView {...props} compare={{ fromVersion: 3, toVersion: 4, diff: "+fresh line" }} /></TooltipProvider>);
    });
    const settled = container.textContent ?? "";
    assert.match(settled, /Changes from v3 to v4/);
    assert.match(settled, /\+fresh line/);
    const pre = container.querySelector('[data-testid="artifact-version-diff"]');
    assert.equal(pre?.getAttribute("aria-label"), "Changes from v3 to v4");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
