import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { SpeechToTextState } from "../../../shared/types";
import { DictationHoldKey, HOLD_TO_DICTATE_MS } from "./dictation-hold-key";
import { installFakes, type Fakes } from "./dictation-harness.test";

/** Mounting and driving the hold key in tests. */

export function ready(holdKey: SpeechToTextState["holdKey"] = "option"): SpeechToTextState {
  return { status: "ready", modelInstalled: true, downloadedBytes: 1, totalBytes: 1, holdKey };
}

export async function wait(ms: number): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

export function key(type: "keydown" | "keyup", init: KeyboardEventInit): Promise<void> {
  return act(async () => { window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init })); });
}

export const OPTION = { key: "Alt", code: "AltLeft", altKey: true };
export const RIGHT_OPTION = { key: "Alt", code: "AltRight", altKey: true };

export async function mount(state: SpeechToTextState): Promise<{ fakes: Fakes; host: HTMLElement; unmount: () => Promise<void> }> {
  const fakes = installFakes(state);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<DictationHoldKey />); });
  await wait(20);
  return { fakes, host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

export async function holdAndSpeak(fakes: Fakes, keyInit: KeyboardEventInit = OPTION): Promise<void> {
  await key("keydown", keyInit);
  await wait(HOLD_TO_DICTATE_MS + 80);
  await key("keyup", { ...keyInit, altKey: false });
  await wait(40);
  assert.equal(fakes.transcribe.length, 1, "what was said is sent to be recognized");
}
