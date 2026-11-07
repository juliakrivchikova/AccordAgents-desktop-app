import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { SpeechToTextState } from "../../../shared/types";
import { DictationHoldKey, HOLD_TO_DICTATE_MS } from "./dictation-hold-key";
import { installFakes, type Fakes } from "./dictation-harness.test";

assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`"
);

function ready(holdKey: SpeechToTextState["holdKey"] = "option"): SpeechToTextState {
  return { status: "ready", modelInstalled: true, downloadedBytes: 1, totalBytes: 1, holdKey };
}

async function wait(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function key(type: "keydown" | "keyup", init: KeyboardEventInit): Promise<void> {
  return act(async () => { window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init })); });
}

const OPTION = { key: "Alt", code: "AltLeft", altKey: true };
const RIGHT_OPTION = { key: "Alt", code: "AltRight", altKey: true };

async function mount(state: SpeechToTextState): Promise<{ fakes: Fakes; host: HTMLElement; unmount: () => Promise<void> }> {
  const fakes = installFakes(state);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<DictationHoldKey />); });
  await wait(20);
  return { fakes, host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

async function holdAndSpeak(fakes: Fakes, keyInit: KeyboardEventInit = OPTION): Promise<void> {
  await key("keydown", keyInit);
  await wait(HOLD_TO_DICTATE_MS + 80);
  await key("keyup", { ...keyInit, altKey: false });
  await wait(40);
  assert.equal(fakes.transcribe.length, 1, "what was said is sent to be recognized");
}

test("holding Option dictates into the field that has the cursor", async () => {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.value = "Start. End.";
  field.focus();
  field.setSelectionRange(6, 6);
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 80);
    assert.match(document.querySelector("[data-testid=dictation-hold-status]")?.textContent ?? "", /Release Option/);
    assert.equal(view.fakes.prepared, 1, "the model starts loading as she starts speaking");
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    view.fakes.transcribe[0]!.resolve({ text: "Привет, мир." });
    await wait(40);
    assert.equal(field.value, "Start. Привет, мир. End.");
    assert.equal(view.fakes.tracks[0]?.stopped, true, "the microphone is released");
    assert.equal(document.querySelector("[data-testid=dictation-result]"), null);
  } finally {
    await view.unmount();
    field.remove();
  }
});

test("a quick tap, or Option with another key, is the usual Option and records nothing", async () => {
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(50);
    await key("keyup", { ...OPTION, altKey: false });
    await wait(HOLD_TO_DICTATE_MS + 50);
    await key("keydown", OPTION);
    await key("keydown", { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    await wait(HOLD_TO_DICTATE_MS + 50);
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    assert.equal(view.fakes.tracks.length, 0, "the microphone never started");
  } finally {
    await view.unmount();
  }
});

test("with no field selected, the text waits in a window to be copied", async () => {
  (document.activeElement as HTMLElement | null)?.blur();
  const view = await mount(ready());
  try {
    await holdAndSpeak(view.fakes);
    view.fakes.transcribe[0]!.resolve({ text: "1, 2, 3, 4, 5" });
    await wait(40);
    assert.equal(document.querySelector("[data-testid=dictation-result-text]")?.textContent, "1, 2, 3, 4, 5");
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
    await act(async () => { (document.querySelector("[data-testid=dictation-result-copy]") as HTMLButtonElement).click(); });
    await wait(20);
    assert.equal(copied, "1, 2, 3, 4, 5");
    assert.match(document.querySelector("[data-testid=dictation-result-copy]")?.textContent ?? "", /Copied/);
  } finally {
    await view.unmount();
  }
});

test("right Option dictates only with the right key, and Off not at all", async () => {
  const right = await mount(ready("right-option"));
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 80);
    await key("keyup", { ...OPTION, altKey: false });
    assert.equal(right.fakes.tracks.length, 0, "the left Option does nothing");
    await holdAndSpeak(right.fakes, RIGHT_OPTION);
    right.fakes.transcribe[0]!.resolve({ text: "" });
    await wait(20);
  } finally {
    await right.unmount();
  }
  const off = await mount(ready("off"));
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 80);
    await key("keyup", { ...OPTION, altKey: false });
    assert.equal(off.fakes.tracks.length, 0);
  } finally {
    await off.unmount();
  }
});

test("switching to another app while holding ends the recording", async () => {
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 80);
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    await wait(40);
    assert.equal(view.fakes.tracks[0]?.stopped, true);
    assert.equal(view.fakes.transcribe.length, 1);
    view.fakes.transcribe[0]!.resolve({ text: "" });
    await wait(20);
  } finally {
    await view.unmount();
  }
});

test("Option held into a shortcut or a click drops what was recorded", async () => {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.value = "Kept.";
  field.focus();
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 100);
    assert.equal(view.fakes.tracks.length, 1, "recording started");
    await key("keydown", { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    assert.equal(view.fakes.tracks[0]?.stopped, true, "the microphone is released");
    assert.equal(view.fakes.transcribe.length, 0, "nothing is sent to be recognized");

    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 100);
    assert.equal(view.fakes.tracks.length, 2, "recording started again");
    await act(async () => { window.dispatchEvent(new Event("pointerdown")); });
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    assert.equal(view.fakes.tracks[1]?.stopped, true);
    assert.equal(view.fakes.transcribe.length, 0);
    assert.equal(field.value, "Kept.");
    assert.equal(document.querySelector("[data-testid=dictation-result]"), null);
  } finally {
    await view.unmount();
    field.remove();
  }
});

test("text spoken for one chat never lands in another that reuses the field", async () => {
  const composer = document.createElement("div");
  composer.setAttribute("data-dictation-session", "chat-1");
  const field = document.createElement("textarea");
  composer.append(field);
  document.body.append(composer);
  field.focus();
  const view = await mount(ready());
  try {
    await holdAndSpeak(view.fakes);
    // She opened another chat while it was being recognized.
    composer.setAttribute("data-dictation-session", "chat-2");
    view.fakes.transcribe[0]!.resolve({ text: "For chat one." });
    await wait(40);
    assert.equal(field.value, "");
    assert.equal(document.querySelector("[data-testid=dictation-result-text]")?.textContent, "For chat one.");
    assert.match(document.querySelector("[data-testid=dictation-result]")?.textContent ?? "", /no longer here/);
  } finally {
    await view.unmount();
    composer.remove();
  }
});

test("text arriving while she types in another field goes in without moving her cursor", async () => {
  const field = document.createElement("textarea");
  const search = document.createElement("input");
  document.body.append(field, search);
  field.value = "Draft.";
  field.focus();
  field.setSelectionRange(6, 6);
  const view = await mount(ready());
  try {
    await holdAndSpeak(view.fakes);
    search.focus();
    search.value = "find";
    view.fakes.transcribe[0]!.resolve({ text: "More." });
    await wait(40);
    assert.equal(document.activeElement, search, "the search box keeps the cursor");
    assert.equal(search.value, "find");
    assert.equal(field.value, "Draft. More.");
  } finally {
    await view.unmount();
    field.remove();
    search.remove();
  }
});

test("a long recording is recognized piece by piece, in the language of the first piece", async () => {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 100);
    await act(async () => { view.fakes.speak(30); });
    await wait(10);
    assert.equal(view.fakes.transcribe.length, 1, "the first piece goes while she still speaks");
    assert.equal(view.fakes.transcribe[0]!.request.prompt, undefined);
    assert.equal(view.fakes.transcribe[0]!.request.language, undefined);
    view.fakes.transcribe[0]!.resolve({ text: "Первая часть.", language: "russian" });
    await wait(10);
    await act(async () => { view.fakes.speak(28); });
    await wait(10);
    assert.equal(view.fakes.transcribe.length, 2);
    assert.equal(view.fakes.transcribe[1]!.request.prompt, "Первая часть.");
    assert.equal(view.fakes.transcribe[1]!.request.language, "russian");
    view.fakes.transcribe[1]!.reject(new Error("engine stopped"));
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    assert.equal(view.fakes.transcribe.length, 3, "only the rest is left after release");
    assert.equal(view.fakes.transcribe[2]!.request.language, "russian");
    view.fakes.transcribe[2]!.resolve({ text: "Конец.", language: "russian" });
    await wait(40);
    assert.equal(field.value, "Первая часть. Конец.");
    assert.match(
      document.querySelector("[data-testid=dictation-hold-status]")?.textContent ?? "",
      /Part of the recording could not be recognized/
    );
  } finally {
    await view.unmount();
    field.remove();
  }
});
