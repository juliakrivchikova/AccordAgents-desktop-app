import assert from "node:assert/strict";
import test from "node:test";

import { EditorState, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorLineEndings, editorLineSeparator, editorText, replaceLineEndings } from "./editor-text";

/** Opens `text` the way the panel's editor does. */
function open(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [editorLineEndings(text)] });
}

function edit(state: EditorState, changes: (state: EditorState) => ChangeSpec): EditorState {
  return state.update({ changes: changes(state) }).state;
}

const atLineEnd = (lineNumber: number, insert: string) => (state: EditorState): ChangeSpec =>
  ({ from: state.doc.line(lineNumber).to, insert });

test("a CRLF file stays CRLF after an edit that adds a line", () => {
  const state = open("one\r\ntwo\r\n");
  assert.equal(editorText(state), "one\r\ntwo\r\n");
  assert.equal(editorText(edit(state, atLineEnd(1, " edited\nnew"))), "one edited\r\nnew\r\ntwo\r\n");
});

test("an LF file stays LF, and a file of bare CRs stays CR", () => {
  assert.equal(editorText(edit(open("one\ntwo\n"), atLineEnd(1, "!\nx"))), "one!\nx\ntwo\n");
  assert.equal(editorLineSeparator("one\rtwo\r"), "\r");
  assert.equal(editorText(edit(open("one\rtwo\r"), atLineEnd(1, "!\nx"))), "one!\rx\rtwo\r");
});

test("line breaks the User did not touch keep their own ending in a mixed file", () => {
  const mixed = "a\r\nb\nc\r\n";
  assert.equal(editorText(open(mixed)), mixed);
  assert.equal(editorText(edit(open(mixed), atLineEnd(2, "!"))), "a\r\nb!\nc\r\n");
  // A new line takes the predominant ending (CRLF here); the old LF stays after b.
  assert.equal(editorText(edit(open(mixed), atLineEnd(1, "\nnew"))), "a\r\nnew\r\nb\nc\r\n");
  assert.equal(editorText(edit(open(mixed), (state) => ({ from: state.doc.line(2).from, insert: ">" }))), "a\r\n>b\nc\r\n");
});

test("a line break inside a quoted CSV cell survives an edit elsewhere", () => {
  const csv = "id,note\r\n1,\"line one\nline two\"\r\n2,plain\r\n";
  const edited = editorText(edit(open(csv), (state) => ({ from: state.doc.line(4).from + 2, insert: "very " })));
  assert.equal(edited, "id,note\r\n1,\"line one\nline two\"\r\n2,very plain\r\n");
});

test("progress-bar redraws in an LF log stay bare CRs", () => {
  const log = "step 1\r50%\r100%\nstep 2\r50%\r100%\n";
  assert.equal(editorLineSeparator(log), "\n");
  const edited = editorText(edit(open(log), () => ({ from: 0, insert: "# " })));
  assert.equal(edited, `# ${log}`);
});

test("undoing an edit gives back the file's exact bytes; joining lines drops the old ending", () => {
  const mixed = "a\r\nb\nc\r\n";
  const start = open(mixed);
  const typed = start.update({ changes: { from: start.doc.line(2).to, insert: "xyz" } });
  const undone = typed.state.update({ changes: typed.changes.invert(start.doc) }).state;
  assert.equal(editorText(undone), mixed);
  // Deleting the LF after b joins b and c; nothing of that LF is left behind.
  const joined = edit(start, (state) => ({ from: state.doc.line(2).to, to: state.doc.line(3).from }));
  assert.equal(editorText(joined), "a\r\nbc\r\n");
});

test("a file rewritten on disk with other line endings is tracked from its new text", () => {
  const start = open("one\ntwo\n");
  const reloaded = start.update({
    changes: { from: 0, to: start.doc.length, insert: "one\r\ntwo\r\n" },
    effects: replaceLineEndings.of("one\r\ntwo\r\n")
  }).state;
  assert.equal(editorText(reloaded), "one\r\ntwo\r\n");
  assert.equal(editorText(edit(reloaded, atLineEnd(1, "!"))), "one!\r\ntwo\r\n");
});

test("ties between line endings go to LF; a copy carries the file's ending", () => {
  assert.equal(editorLineSeparator("a\r\nb\n"), "\n");
  assert.equal(editorLineSeparator("no line break"), "\n");
  const state = open("one\r\ntwo\r\n");
  const [filter] = state.facet(EditorView.clipboardOutputFilter);
  assert.equal(filter("one\ntwo", state), "one\r\ntwo");
});
