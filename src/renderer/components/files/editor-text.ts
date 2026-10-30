import type { EditorState } from "@codemirror/state";

/**
 * The line ending a save writes: the one most of the file's lines use, so a
 * CRLF file stays CRLF and an LF file stays LF. The editor itself splits on any
 * line break; a file with mixed endings is saved with its predominant one, as
 * VS Code and IntelliJ do.
 */
export function editorLineSeparator(text: string): "\r\n" | "\n" {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** The document as the file's text. `doc.toString()` always joins with "\n". */
export function editorText(state: EditorState, lineSeparator: string): string {
  return state.doc.sliceString(0, state.doc.length, lineSeparator);
}
