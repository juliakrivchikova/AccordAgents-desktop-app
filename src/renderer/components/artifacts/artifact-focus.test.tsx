// An Accord's card opens a member's draft and the published version in the
// document's panel (the User, 2026-11-26): where an open lands, once, and
// what it never does (replace a revision she is typing, jump after she moved).
import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { ArtifactDraftView, ArtifactReadResult, ArtifactSummary, CollectingArtifactReadResult, PublishedArtifactReadResult } from "../../../shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ArtifactsPanel } from "./artifacts-panel";
import { submittedDraftOf } from "./use-artifact-focus";
import type { ArtifactFocusRequest } from "./use-artifacts";

const NOW = "2026-11-26T12:00:00.000Z";
const ID = "artifact-accord";

function summary(headVersion: number, lifecycle: ArtifactSummary["lifecycle"] = "published"): ArtifactSummary {
  return {
    id: ID, conversationId: "chat-1", name: "Ship or wait", owner: "main", contributors: ["user"], labels: [], lifecycle, headVersion,
    draftRosterRevision: 0, requiredDraftCount: 2, submittedDraftCount: 2, createdAt: NOW, updatedAt: NOW,
    approval: { state: "none-required", requiredSigners: [], signedCurrent: [] }
  };
}

function published(version: number, headVersion = 3): PublishedArtifactReadResult {
  const meta = (n: number) => ({ version: n, versionEventId: `event-${n}`, contentHash: String(n).repeat(64), author: "main", createdAt: NOW, signatures: [] });
  return { lifecycle: "published", summary: summary(headVersion), version: { ...meta(version), content: `# Version ${version}` }, history: [1, 2, 3].map(meta) };
}

function draft(author: string, state: ArtifactDraftView["state"] = "submitted"): ArtifactDraftView {
  return {
    id: `draft-${author}`, artifactId: ID, author, state, editRevision: 1, createdAt: NOW, updatedAt: NOW, submittedAt: NOW,
    hasContent: true, content: `Draft body from ${author}`, readers: ["user"], effectiveReaders: ["user", author]
  };
}

function collecting(): CollectingArtifactReadResult {
  return {
    lifecycle: "collecting_drafts", summary: summary(0, "collecting_drafts"), allowedDraftAuthors: ["taylor", "drew"],
    requiredDraftAuthors: ["taylor", "drew"], audiencePolicyByAuthor: {}, drafts: [draft("taylor"), draft("drew")],
    missingRequiredAuthors: [], readyToPublish: true
  };
}

interface Bridge {
  detail: ArtifactReadResult;
  drafts: ArtifactDraftView[];
  reads: number[];
  /** Set: the drafts list waits until released (a slow server). */
  slowDrafts?: boolean;
  release?: () => void;
}

// Every read answers with new objects, as the app's IPC does.
function install(bridge: Bridge): void {
  Object.defineProperty(window, "consensus", {
    configurable: true,
    value: {
      readArtifact: async (request: { version?: number }) => {
        bridge.reads.push(request.version ?? 0);
        const detail = request.version === undefined || bridge.detail.lifecycle !== "published" ? bridge.detail : published(request.version);
        return { ok: true as const, value: structuredClone(detail) };
      },
      listArtifactDrafts: () => {
        const answer = () => ({ ok: true as const, value: structuredClone(bridge.drafts) });
        if (!bridge.slowDrafts) return Promise.resolve(answer());
        return new Promise((resolve) => { bridge.release = () => resolve(answer()); });
      }
    }
  });
}

async function mount(bridge: Bridge, takeFocus?: (seq: number) => boolean) {
  install(bridge);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (focus?: ArtifactFocusRequest) => act(async () => {
    root.render(
      <TooltipProvider>
        <ArtifactsPanel conversationId="chat-1" members={["user", "taylor", "drew"]} artifacts={[bridge.detail.summary]} selectedId={ID}
          focus={focus} takeFocus={takeFocus} onSelect={() => undefined} onClose={() => undefined} />
      </TooltipProvider>
    );
  });
  const text = (): string => container.textContent ?? "";
  const unmount = async (): Promise<void> => {
    await act(async () => { root.unmount(); });
    container.remove();
  };
  return { container, render, text, unmount };
}

const toDraft = (author: string, seq: number): ArtifactFocusRequest => ({ artifactId: ID, place: { draftAuthor: author }, seq });
const toVersion = (version: number, seq: number): ArtifactFocusRequest => ({ artifactId: ID, place: { version }, seq });

test("an open lands on the member's draft or the version asked for", async () => {
  assert.equal(globalThis.ACCORD_RENDERER_JSDOM, true, "run this test with scripts/renderer-jsdom-setup.mjs");
  const bridge: Bridge = { detail: published(3), drafts: [draft("taylor")], reads: [] };
  const panel = await mount(bridge);
  try {
    await panel.render(toDraft("@Taylor", 1));
    assert.match(panel.text(), /Draft body from taylor/, "the author's submitted draft, once the drafts are read");
    await panel.render(toVersion(2, 2));
    assert.match(panel.text(), /Version 2/);
    assert.doesNotMatch(panel.text(), /Draft body from taylor/);
    await panel.render(toVersion(3, 3));
    assert.match(panel.text(), /Version 3/, "the newest version is the document as it is");
    assert.equal(bridge.reads.at(-1), 0, "read as the head, which follows a newer version");
    await panel.render(toDraft("drew", 4));
    assert.match(panel.text(), /Version 3/, "an author with no submitted draft leaves the document as it is");
    // While drafts are collected, the inbox shows the asked author's draft rather than the first one.
    bridge.detail = collecting();
    await panel.render(toDraft("drew", 5));
    assert.match(panel.text(), /Draft body from drew/);
  } finally {
    await panel.unmount();
  }
});

test("an open lands once: a panel drawn again later shows what she went to since", async () => {
  const bridge: Bridge = { detail: published(3), drafts: [draft("taylor")], reads: [] };
  let taken = 0;
  const takeFocus = (seq: number): boolean => seq > taken && (taken = seq) > 0;
  const first = await mount(bridge, takeFocus);
  await first.render(toDraft("taylor", 1));
  assert.match(first.text(), /Draft by @taylor/);
  const back = [...first.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => /Back to v3/.test(button.textContent ?? ""));
  assert.ok(back, "the draft offers the way back to the document");
  await act(async () => { back.click(); });
  assert.doesNotMatch(first.text(), /Viewing a draft/);
  await first.unmount();

  const again = await mount(bridge, takeFocus);
  try {
    await again.render(toDraft("taylor", 1));
    assert.match(again.text(), /Version 3/);
    assert.doesNotMatch(again.text(), /Viewing a draft/, "the open was taken before");
  } finally {
    await again.unmount();
  }
});

test("an open asking for a draft keeps a revision she is typing on screen", async () => {
  const bridge: Bridge = { detail: published(3), drafts: [draft("taylor")], reads: [] };
  const panel = await mount(bridge);
  try {
    await panel.render();
    const revise = panel.container.querySelector<HTMLButtonElement>('button[aria-label="Revise"]');
    assert.ok(revise, "the document can be revised here");
    await act(async () => { revise.click(); });
    const field = panel.container.querySelector<HTMLTextAreaElement>("#artifact-revise-content");
    assert.ok(field, "the revision form is open");
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "My unsaved edit");
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await panel.render(toDraft("taylor", 1));
    assert.equal(panel.container.querySelector<HTMLTextAreaElement>("#artifact-revise-content")?.value, "My unsaved edit");
    assert.doesNotMatch(panel.text(), /Viewing a draft/);
  } finally {
    await panel.unmount();
  }
});

test("an open without a place stops an earlier open's wait for a draft", async () => {
  const bridge: Bridge = { detail: published(3), drafts: [draft("taylor")], reads: [], slowDrafts: true };
  const panel = await mount(bridge);
  try {
    await panel.render(toDraft("taylor", 1));
    // Open on the card, while her server is slow with the drafts.
    await panel.render({ artifactId: ID, seq: 2 });
    await act(async () => { bridge.release?.(); });
    assert.match(panel.text(), /Version 3/);
    assert.doesNotMatch(panel.text(), /Viewing a draft/, "the document stays as Open showed it");
  } finally {
    await panel.unmount();
  }
});

test("the draft a chip opens is the author's submitted one, else the newest it submitted", () => {
  const of = (id: string, state: ArtifactDraftView["state"], submittedAt?: string): ArtifactDraftView =>
    ({ ...draft("drew", state), id, submittedAt });
  const older = of("old", "superseded", "2026-11-26T10:00:00.000Z");
  const newer = of("new", "withdrawn", "2026-11-26T11:00:00.000Z");
  const waiting = of("waiting", "submitted", "2026-11-26T09:00:00.000Z");
  assert.equal(submittedDraftOf([older, newer, waiting], "@Drew")?.id, "waiting");
  assert.equal(submittedDraftOf([older, newer], "drew")?.id, "new");
  assert.equal(submittedDraftOf([of("editing", "editing")], "drew"), undefined, "never submitted");
  assert.equal(submittedDraftOf([waiting], "taylor"), undefined);
});
