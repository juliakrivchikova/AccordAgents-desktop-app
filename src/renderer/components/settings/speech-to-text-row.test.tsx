import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { SpeechToTextState } from "../../../shared/types";
import { SpeechToTextRow } from "./speech-to-text-row";

assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`"
);

const TOTAL = 1_624_555_275;

function state(patch: Partial<SpeechToTextState>): SpeechToTextState {
  return { status: "off", modelInstalled: false, downloadedBytes: 0, totalBytes: TOTAL, ...patch };
}

function find(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid=${testId}]`);
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function click(testId: string): Promise<void> {
  const element = find(testId);
  assert.ok(element, `${testId} is on screen`);
  await act(async () => { element.click(); });
  await settle();
}

async function mount(initial: SpeechToTextState) {
  const calls: string[] = [];
  let emit: (next: SpeechToTextState) => void = () => undefined;
  const answer = (next: SpeechToTextState) => async () => { emit(next); return next; };
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    getSpeechToTextState: async () => initial,
    onSpeechToTextState: (callback: (next: SpeechToTextState) => void) => { emit = callback; return () => undefined; },
    enableSpeechToText: async () => {
      calls.push("enable");
      return answer(state({ status: initial.modelInstalled ? "ready" : "downloading", modelInstalled: initial.modelInstalled, downloadedBytes: 0 }))();
    },
    cancelSpeechToTextDownload: async () => { calls.push("cancel"); return answer(state({}))(); },
    disableSpeechToText: async (request: { deleteModel: boolean }) => {
      calls.push(`disable:${request.deleteModel ? "delete" : "keep"}`);
      return answer(state({ modelInstalled: !request.deleteModel }))();
    }
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<TooltipProvider><SpeechToTextRow /></TooltipProvider>); });
  await settle();
  return {
    calls,
    emit: (next: SpeechToTextState) => act(async () => { emit(next); }),
    unmount: () => act(async () => { root.unmount(); host.remove(); })
  };
}

test("turning it on asks before the download, and cancelling the question changes nothing", async () => {
  const view = await mount(state({}));
  try {
    assert.match(find("speech-to-text-status")?.textContent ?? "", /1\.6 GB download/);
    await click("speech-to-text-toggle");
    assert.ok(find("speech-to-text-download-dialog"), "the download is confirmed first");
    assert.match(find("speech-to-text-download-dialog")?.textContent ?? "", /1\.6 GB/);
    assert.deepEqual(view.calls, []);
    const cancel = [...document.querySelectorAll("[data-testid=speech-to-text-download-dialog] button")]
      .find((button) => button.textContent === "Cancel") as HTMLButtonElement;
    await act(async () => { cancel.click(); });
    await settle();
    assert.equal(find("speech-to-text-download-dialog"), null);
    assert.deepEqual(view.calls, []);
    assert.equal((find("speech-to-text-toggle") as HTMLInputElement).checked, false);
  } finally {
    await view.unmount();
  }
});

test("confirming downloads with progress, and the download can be cancelled", async () => {
  const view = await mount(state({}));
  try {
    await click("speech-to-text-toggle");
    await click("speech-to-text-download-confirm");
    assert.deepEqual(view.calls, ["enable"]);
    assert.equal(find("speech-to-text-download-dialog"), null);
    await view.emit(state({ status: "downloading", downloadedBytes: 812_000_000 }));
    assert.equal((find("speech-to-text-toggle") as HTMLInputElement).checked, true);
    assert.match(find("speech-to-text-status")?.textContent ?? "", /812 MB of 1\.6 GB/);
    assert.equal(document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow"), "812000000");
    await click("speech-to-text-cancel");
    assert.deepEqual(view.calls, ["enable", "cancel"]);
    assert.equal((find("speech-to-text-toggle") as HTMLInputElement).checked, false);
  } finally {
    await view.unmount();
  }
});

test("an interrupted download says why and resumes", async () => {
  const view = await mount(state({ status: "interrupted", downloadedBytes: 300_000_000, error: "The download stopped: no data arrived for a minute." }));
  try {
    assert.match(find("speech-to-text-error")?.textContent ?? "", /no data arrived/);
    assert.equal((find("speech-to-text-toggle") as HTMLInputElement).checked, true);
    await click("speech-to-text-resume");
    assert.deepEqual(view.calls, ["enable"]);
  } finally {
    await view.unmount();
  }
});

test("turning it off asks whether to keep the model", async () => {
  const view = await mount(state({ status: "ready", modelInstalled: true, downloadedBytes: TOTAL }));
  try {
    await click("speech-to-text-toggle");
    assert.ok(find("speech-to-text-off-dialog"));
    await click("speech-to-text-off-keep");
    assert.deepEqual(view.calls, ["disable:keep"]);
    assert.match(find("speech-to-text-status")?.textContent ?? "", /already on this Mac/);
    // With the model kept, turning it on again needs no download question.
    await click("speech-to-text-toggle");
    assert.equal(find("speech-to-text-download-dialog"), null);
    assert.deepEqual(view.calls, ["disable:keep", "enable"]);
    await view.emit(state({ status: "ready", modelInstalled: true, downloadedBytes: TOTAL }));
    await click("speech-to-text-toggle");
    await click("speech-to-text-off-delete");
    assert.deepEqual(view.calls, ["disable:keep", "enable", "disable:delete"]);
  } finally {
    await view.unmount();
  }
});

test("a build without the engine shows why and cannot be switched on", async () => {
  const view = await mount(state({ status: "unavailable", error: "Speech to text is not included in this build of the app." }));
  try {
    assert.equal((find("speech-to-text-toggle") as HTMLInputElement).disabled, true);
    assert.match(find("speech-to-text-status")?.textContent ?? "", /not included in this build/);
  } finally {
    await view.unmount();
  }
});
