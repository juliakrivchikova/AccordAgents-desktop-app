import { RangeSet, RangeValue, StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type EditorLineSeparator = "\r\n" | "\n" | "\r";

/**
 * The line ending of new lines: the one most of the file's lines use (ties go
 * to LF). Bare CR only for a file that has no other kind, so a log full of
 * progress-bar redraws is not taken for an old Mac file.
 */
export function editorLineSeparator(text: string): EditorLineSeparator {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  const cr = text.split("\r").length - 1 - crlf;
  if (crlf === 0 && lf === 0 && cr > 0) return "\r";
  return crlf > lf ? "\r\n" : "\n";
}

/** The original ending of one line break, kept on the break's one-character range. */
class LineBreak extends RangeValue {
  // Text typed at the end of the line goes before the break, text at the start
  // of the next line after it; a deleted break takes its range with it.
  startSide = 1;
  endSide = -1;

  constructor(readonly text: EditorLineSeparator) {
    super();
  }

  eq(other: RangeValue): boolean {
    return other instanceof LineBreak && other.text === this.text;
  }
}

interface LineEndings {
  separator: EditorLineSeparator;
  /** Only the breaks whose ending differs from `separator`. */
  breaks: RangeSet<LineBreak>;
}

/** The file changed on disk: its text replaced the document. */
export const replaceLineEndings = StateEffect.define<string>();

const BREAK_PATTERN = /\r\n|\r|\n/g;

function lineEndingsOf(doc: Text, text: string): LineEndings {
  const separator = editorLineSeparator(text);
  const ranges: Range<LineBreak>[] = [];
  let lineNumber = 1;
  for (const match of text.matchAll(BREAK_PATTERN)) {
    if (lineNumber >= doc.lines) break;
    if (match[0] !== separator) {
      const at = doc.line(lineNumber).to;
      ranges.push(new LineBreak(match[0] as EditorLineSeparator).range(at, at + 1));
    }
    lineNumber += 1;
  }
  return { separator, breaks: RangeSet.of(ranges) };
}

const lineEndingsField = StateField.define<LineEndings>({
  create: (state) => lineEndingsOf(state.doc, state.doc.toString()),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(replaceLineEndings)) return lineEndingsOf(transaction.state.doc, effect.value);
    }
    return transaction.docChanged ? { ...value, breaks: value.breaks.map(transaction.changes) } : value;
  }
});

/**
 * The document as the file's text: every line break the User did not touch
 * keeps the ending it had on disk, new ones get the file's predominant ending.
 * (`doc.toString()` would join every line with "\n".)
 */
export function editorText(state: EditorState): string {
  const { separator, breaks } = state.field(lineEndingsField);
  if (breaks.size === 0) return state.doc.sliceString(0, state.doc.length, separator);
  const parts: string[] = [];
  const cursor = breaks.iter();
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    parts.push(line.text);
    if (lineNumber === state.doc.lines) break;
    while (cursor.value && cursor.from < line.to) cursor.next();
    parts.push(cursor.value && cursor.from === line.to ? cursor.value.text : separator);
  }
  return parts.join("");
}

/** Line-ending tracking for a document created from `text`; a copy carries the file's own ending. */
export function editorLineEndings(text: string): Extension {
  return [
    lineEndingsField.init((state) => lineEndingsOf(state.doc, text)),
    EditorView.clipboardOutputFilter.of((copied, state) => {
      const { separator } = state.field(lineEndingsField);
      return separator === "\n" ? copied : copied.replace(/\n/g, separator);
    })
  ];
}
