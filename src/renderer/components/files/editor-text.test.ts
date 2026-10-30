import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "@codemirror/state";

import { editorLineSeparator, editorText } from "./editor-text";

/** Opens `text` the way the panel's editor does and types `typed` at the end of the first line. */
function editAtFirstLineEnd(text: string, typed: (lineBreak: string) => string): string {
  const state = EditorState.create({ doc: text });
  const end = state.doc.line(1).to;
  return editorText(state.update({ changes: { from: end, insert: typed(state.lineBreak) } }).state, editorLineSeparator(text));
}

test("a CRLF file stays CRLF after an edit that adds a line", () => {
  assert.equal(editorLineSeparator("one\r\ntwo\r\n"), "\r\n");
  assert.equal(editAtFirstLineEnd("one\r\ntwo\r\n", (br) => ` edited${br}new`), "one edited\r\nnew\r\ntwo\r\n");
  assert.equal(editAtFirstLineEnd("one\r\ntwo\r\n", () => ""), "one\r\ntwo\r\n");
});

test("an LF file stays LF", () => {
  assert.equal(editorLineSeparator("one\ntwo\n"), "\n");
  assert.equal(editorLineSeparator("no line break"), "\n");
  assert.equal(editAtFirstLineEnd("one\ntwo\n", (br) => `!${br}x`), "one!\nx\ntwo\n");
});

test("a file with mixed line endings is saved with its predominant one", () => {
  assert.equal(editAtFirstLineEnd("one\r\ntwo\nthree\r\n", () => "!"), "one!\r\ntwo\r\nthree\r\n");
  assert.equal(editAtFirstLineEnd("one\ntwo\r\nthree\n", () => "!"), "one!\ntwo\nthree\n");
});
