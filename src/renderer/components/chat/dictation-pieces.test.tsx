import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";

import { HOLD_TO_DICTATE_MS } from "./dictation-hold-key";
import { OPTION, key, mount, ready, wait } from "./dictation-hold-key-harness.test";

assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`"
);

/* A long recording held on the key: recognized in pieces while she speaks. */

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
    view.fakes.transcribe[0]!.resolve({ text: "Первая часть записи.", language: "russian" });
    await wait(10);
    await act(async () => { view.fakes.speak(28); });
    await wait(10);
    assert.equal(view.fakes.transcribe.length, 2);
    assert.equal(view.fakes.transcribe[1]!.request.prompt, "Первая часть записи.");
    assert.equal(view.fakes.transcribe[1]!.request.language, "russian");
    view.fakes.transcribe[1]!.reject(new Error("engine stopped"));
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    assert.equal(view.fakes.transcribe.length, 3, "only the rest is left after release");
    assert.equal(view.fakes.transcribe[2]!.request.language, "russian");
    view.fakes.transcribe[2]!.resolve({ text: "Конец.", language: "russian" });
    await wait(40);
    assert.equal(field.value, "Первая часть записи. Конец.");
    assert.match(
      document.querySelector("[data-testid=dictation-hold-status]")?.textContent ?? "",
      /Part of the recording could not be recognized/
    );
  } finally {
    await view.unmount();
    field.remove();
  }
});

test("a shortcut during a long recording drops the piece in flight and everything after it", async () => {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 100);
    await act(async () => { view.fakes.speak(30); });
    await wait(10);
    assert.equal(view.fakes.transcribe.length, 1);
    await key("keydown", { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
    await act(async () => { view.fakes.speak(30); });
    view.fakes.transcribe[0]!.resolve({ text: "Не для неё.", language: "russian" });
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    assert.equal(view.fakes.transcribe.length, 1, "nothing more is sent");
    assert.equal(field.value, "");
    assert.equal(document.querySelector("[data-testid=dictation-result]"), null);
  } finally {
    await view.unmount();
    field.remove();
  }
});

test("an engine that fails twice in a row is not waited on for the rest", async () => {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 100);
    await act(async () => { view.fakes.speak(30); });
    await wait(10);
    view.fakes.transcribe[0]!.reject(new Error("The speech engine did not answer in 150 s."));
    await act(async () => { view.fakes.speak(28); });
    await wait(10);
    assert.equal(view.fakes.transcribe.length, 2, "one more try: a failed engine is restarted");
    view.fakes.transcribe[1]!.reject(new Error("The speech engine did not answer in 150 s."));
    await act(async () => { view.fakes.speak(28); });
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    assert.equal(view.fakes.transcribe.length, 2, "the rest is not sent");
    assert.match(document.querySelector("[data-testid=dictation-hold-status]")?.textContent ?? "", /did not answer/);
    assert.equal(field.value, "");
    assert.equal(document.querySelector("[data-testid=dictation-result]"), null);
  } finally {
    await view.unmount();
    field.remove();
  }
});

test("a cough or a word does not fix the language for the rest of a long recording", async () => {
  const view = await mount(ready());
  try {
    await key("keydown", OPTION);
    await wait(HOLD_TO_DICTATE_MS + 100);
    await act(async () => { view.fakes.speak(30); });
    await wait(10);
    view.fakes.transcribe[0]!.resolve({ text: "Hmm.", language: "english" });
    await wait(10);
    await act(async () => { view.fakes.speak(28); });
    await wait(10);
    assert.equal(view.fakes.transcribe[1]!.request.language, undefined, "the next piece finds its own language");
    view.fakes.transcribe[1]!.resolve({ text: "Теперь говорю по-русски долго.", language: "russian" });
    await key("keyup", { ...OPTION, altKey: false });
    await wait(40);
    assert.equal(view.fakes.transcribe[2]!.request.language, "russian");
    view.fakes.transcribe[2]!.resolve({ text: "" });
    await wait(20);
  } finally {
    await view.unmount();
  }
});
