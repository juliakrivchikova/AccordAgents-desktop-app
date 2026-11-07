import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import { HOLD_TO_DICTATE_MS } from "./dictation-hold-key";
import { OPTION, RIGHT_OPTION, holdAndSpeak, key, mount, ready, wait } from "./dictation-hold-key-harness.test";
import { DICTATION_SESSION_ATTRIBUTE } from "./dictation-target";

assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`"
);

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

test("switching away while holding ends the recording, and its text is only offered to copy", async () => {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 80);
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    await wait(40);
    assert.equal(view.fakes.tracks[0]?.stopped, true);
    assert.equal(view.fakes.transcribe.length, 1);
    view.fakes.transcribe[0]!.resolve({ text: "Half a thought." });
    await wait(40);
    assert.equal(field.value, "", "never typed into her message");
    assert.equal(document.querySelector("[data-testid=dictation-result-text]")?.textContent, "Half a thought.");
    assert.match(document.querySelector("[data-testid=dictation-result]")?.textContent ?? "", /interrupted/);
  } finally {
    await view.unmount();
    field.remove();
  }
});

test("a release the page never heard ends the recording at the next move without Option", async () => {
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 80);
    await act(async () => { window.dispatchEvent(new PointerEvent("pointermove", { altKey: true })); });
    await wait(20);
    assert.equal(view.fakes.tracks[0]?.stopped, false, "moving with Option still held keeps recording");
    await act(async () => { window.dispatchEvent(new PointerEvent("pointermove", { altKey: false })); });
    await wait(40);
    assert.equal(view.fakes.tracks[0]?.stopped, true);
    view.fakes.transcribe[0]!.resolve({ text: "Kept." });
    await wait(40);
    assert.match(document.querySelector("[data-testid=dictation-result]")?.textContent ?? "", /interrupted/);
  } finally {
    await view.unmount();
  }
});

test("Option with Cmd, Ctrl or Shift never starts dictation", async () => {
  const view = await mount(ready());
  try {
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey"]) {
      await key("keydown", { ...OPTION, [modifier]: true });
      await wait(HOLD_TO_DICTATE_MS + 50);
      await key("keyup", { ...OPTION, altKey: false });
    }
    assert.equal(view.fakes.tracks.length, 0);
  } finally {
    await view.unmount();
  }
});

test("letting go before the microphone is on records nothing and says to hold longer", async () => {
  const view = await mount(ready());
  view.fakes.holdMicrophone = true;
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 50);
    assert.match(document.querySelector("[data-testid=dictation-hold-status]")?.textContent ?? "", /Starting the microphone/);
    await key("keyup", { ...OPTION, altKey: false });
    await wait(20);
    assert.match(document.querySelector("[data-testid=dictation-hold-status]")?.textContent ?? "", /Hold Option until it says Listening/);
    // A second hold at once, while the first one's microphone still answers.
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 50);
    await act(async () => { view.fakes.answerMicrophone(); });
    await wait(20);
    await key("keyup", { ...OPTION, altKey: false });
    await act(async () => { view.fakes.answerMicrophone(); });
    await wait(40);
    assert.equal(view.fakes.tracks.filter((track) => !track.stopped).length, 0, "no microphone is left on");
    assert.equal(view.fakes.transcribe.length, 0);
  } finally {
    await view.unmount();
  }
});

test("the terminal and read-only fields never get dictated text", async () => {
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const shell = document.createElement("textarea");
  terminal.append(shell);
  const readOnly = document.createElement("textarea");
  readOnly.readOnly = true;
  document.body.append(terminal, readOnly);
  const view = await mount(ready());
  try {
    let index = 0;
    for (const field of [shell, readOnly]) {
      field.focus();
      await key("keydown", OPTION);
      await wait(HOLD_TO_DICTATE_MS + 80);
      await key("keyup", { ...OPTION, altKey: false });
      await wait(40);
      view.fakes.transcribe[index]!.resolve({ text: "ls -la" });
      await wait(40);
      assert.equal(field.value, "");
      assert.equal(document.querySelector("[data-testid=dictation-result-text]")?.textContent, "ls -la");
      index += 1;
    }
  } finally {
    await view.unmount();
    terminal.remove();
    readOnly.remove();
  }
});

test("typing through the browser is used when it can, so Undo takes the text out", async () => {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.value = "Hi.";
  field.focus();
  field.setSelectionRange(3, 3);
  const typed: string[] = [];
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string, _ui: boolean, value: string) => {
      typed.push(`${command}:${value}`);
      field.setRangeText(value, field.selectionStart, field.selectionEnd, "end");
      return true;
    }
  });
  const view = await mount(ready());
  try {
    await holdAndSpeak(view.fakes);
    view.fakes.transcribe[0]!.resolve({ text: "Bye." });
    await wait(40);
    assert.deepEqual(typed, ["insertText: Bye."]);
    assert.equal(field.value, "Hi. Bye.");
  } finally {
    await view.unmount();
    delete (document as unknown as { execCommand?: unknown }).execCommand;
    field.remove();
  }
});

test("the Copy window: a failed copy keeps it open, Escape closes it, and new text starts fresh", async () => {
  (document.activeElement as HTMLElement | null)?.blur();
  const view = await mount(ready());
  try {
    await holdAndSpeak(view.fakes);
    view.fakes.transcribe[0]!.resolve({ text: "First." });
    await wait(40);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    await act(async () => { (document.querySelector("[data-testid=dictation-result-copy]") as HTMLButtonElement).click(); });
    await wait(20);
    assert.match(document.querySelector("[data-testid=dictation-result]")?.textContent ?? "", /Copy failed/);
    assert.ok(document.querySelector(".dictation-result-close[data-paused]"), "the window waits while the text is only here");

    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 80);
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    view.fakes.transcribe[1]!.resolve({ text: "Second." });
    await wait(40);
    assert.equal(document.querySelector("[data-testid=dictation-result-text]")?.textContent, "Second.");
    assert.doesNotMatch(document.querySelector("[data-testid=dictation-result]")?.textContent ?? "", /Copy failed|Copied/);

    await act(async () => {
      document.querySelector("[data-testid=dictation-result]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(document.querySelector("[data-testid=dictation-result]"), null);
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
  composer.setAttribute(DICTATION_SESSION_ATTRIBUTE, "chat-1");
  const field = document.createElement("textarea");
  composer.append(field);
  document.body.append(composer);
  field.focus();
  const view = await mount(ready());
  try {
    await holdAndSpeak(view.fakes);
    // She opened another chat while it was being recognized.
    composer.setAttribute(DICTATION_SESSION_ATTRIBUTE, "chat-2");
    view.fakes.transcribe[0]!.resolve({ text: "For chat one." });
    await wait(40);
    assert.equal(field.value, "");
    assert.equal(document.querySelector("[data-testid=dictation-result-text]")?.textContent, "For chat one.");
    assert.match(document.querySelector("[data-testid=dictation-result]")?.textContent ?? "", /could not go back/);
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
