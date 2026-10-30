import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";

import CodeEditor from "./code-editor";

// jsdom lays nothing out; CodeMirror measures through these.
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number => window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (handle: number): void => window.clearTimeout(handle);
}
const emptyRects = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

async function mount(text: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const reported: string[] = [];
  const render = (next: string) => act(async () => {
    root.render(<CodeEditor text={next} filename="notes.txt" readOnly={false} onChange={(value) => reported.push(value)} />);
  });
  await render(text);
  const view = (): EditorView => EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  const type = (lineNumber: number, insert: string) => act(async () => {
    view().dispatch({ changes: { from: view().state.doc.line(lineNumber).to, insert }, userEvent: "input.type" });
  });
  return { reported, render, type, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

test("typing in a CRLF file reports CRLF text", async () => {
  const editor = await mount("one\r\ntwo\r\n");
  await editor.type(1, "!");
  assert.equal(editor.reported.at(-1), "one!\r\ntwo\r\n");
  await editor.unmount();
});

test("a file rewritten on disk as CRLF is saved CRLF after the next keystroke, and the reload itself reports nothing", async () => {
  const editor = await mount("one\ntwo\n");
  await editor.render("one\r\ntwo\r\n");
  assert.deepEqual(editor.reported, [], "a disk update is not typing");
  await editor.type(1, "!");
  assert.equal(editor.reported.at(-1), "one!\r\ntwo\r\n");
  await editor.unmount();
});

test("a mixed file keeps the endings of lines the User did not touch", async () => {
  const editor = await mount("a\r\nb\nc\r\n");
  await editor.type(3, "!");
  assert.equal(editor.reported.at(-1), "a\r\nb\nc!\r\n");
  await editor.unmount();
});
