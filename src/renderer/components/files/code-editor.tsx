import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Marks a change that came from the disk, not from typing. */
const externalUpdate = Annotation.define<boolean>();

/**
 * Colors come from the app's theme variables, so light and dark both read
 * well; CodeMirror's own light defaults are not used.
 */
const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--app-surface)", color: "var(--app-text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--app-code-cursor)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--app-code-cursor)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--app-code-selection)" },
  ".cm-gutters": { backgroundColor: "var(--app-surface-subtle)", color: "var(--app-muted)", borderRight: "1px solid var(--app-border)" },
  ".cm-activeLine": { backgroundColor: "var(--app-surface-subtle)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--app-surface-subtle)" },
  "&.cm-focused": { outline: "none", boxShadow: "var(--focus-ring)" },
  ".cm-searchMatch": { backgroundColor: "var(--app-accent-soft)", outline: "1px solid var(--app-accent-border)" },
  ".cm-selectionMatch": { backgroundColor: "var(--app-accent-soft)" },
  ".cm-panels": { backgroundColor: "var(--app-surface-subtle)", color: "var(--app-text)", borderBottom: "1px solid var(--app-border)" },
  ".cm-textfield": {
    backgroundColor: "var(--app-surface)",
    color: "var(--app-text)",
    border: "1px solid var(--app-border)",
    borderRadius: "4px"
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--app-surface)",
    color: "var(--app-text)",
    border: "1px solid var(--app-border)",
    borderRadius: "4px"
  },
  ".cm-panel button[name=close]": { color: "var(--app-muted)" }
});

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword], color: "var(--app-code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--app-code-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--app-code-number)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--app-code-comment)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: "var(--app-code-function)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--app-code-type)" },
  { tag: [tags.propertyName, tags.attributeName, tags.labelName], color: "var(--app-code-property)" },
  { tag: [tags.meta, tags.processingInstruction, tags.tagName], color: "var(--app-code-meta)" },
  { tag: [tags.heading], color: "var(--app-text-strong)", fontWeight: "600" },
  { tag: [tags.link, tags.url], color: "var(--app-accent)", textDecoration: "underline" },
  { tag: [tags.emphasis], fontStyle: "italic" },
  { tag: [tags.strong], fontWeight: "600" },
  { tag: [tags.invalid], color: "var(--app-code-invalid)" }
]);

/**
 * The panel's text editor: line numbers, syntax highlighting chosen by the file
 * name, search (Cmd+F), Cmd+S to save at once, and the line a link points at.
 * The document is owned outside: `text` replaces it only when it is not the
 * text the editor itself last reported (the file changed on disk).
 */
export default function CodeEditor(props: {
  text: string;
  filename: string;
  readOnly: boolean;
  line?: number;
  column?: number;
  onChange?: (text: string) => void;
  onSave?: () => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const readOnlySlot = useRef(new Compartment());
  const lastEmitted = useRef(props.text);
  const handlers = useRef({ onChange: props.onChange, onSave: props.onSave });
  handlers.current = { onChange: props.onChange, onSave: props.onSave };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const crlf = props.text.includes("\r\n");
    lastEmitted.current = props.text;
    const state = EditorState.create({
      doc: props.text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        search({ top: true }),
        highlightSelectionMatches(),
        syntaxHighlighting(highlightStyle),
        EditorView.lineWrapping,
        // Keep CRLF files CRLF: the document joins lines with what it found.
        ...(crlf ? [EditorState.lineSeparator.of("\r\n")] : []),
        languageSlot.current.of([]),
        readOnlySlot.current.of([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { handlers.current.onSave?.(); return true; } },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && update.transactions.some((transaction) => !transaction.annotation(externalUpdate))) {
            const text = update.state.doc.toString();
            lastEmitted.current = text;
            handlers.current.onChange?.(text);
          }
        }),
        editorTheme
      ]
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Created once per file; later text arrives through the effect below.
  }, [props.filename]);

  // Highlighting for the file's language, loaded on demand.
  useEffect(() => {
    let cancelled = false;
    const description = LanguageDescription.matchFilename(languages, props.filename);
    if (!description) return undefined;
    void description.load().then((support) => {
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({ effects: languageSlot.current.reconfigure(support) });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [props.filename]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlySlot.current.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)])
    });
  }, [props.readOnly]);

  // The file changed on disk (or was taken from the disk): show it, keeping the
  // scroll. Not an undoable step: Cmd+Z must not bring back what the disk replaced.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || props.text === lastEmitted.current) return;
    lastEmitted.current = props.text;
    if (view.state.doc.toString() === props.text) return;
    const scrollTop = view.scrollDOM.scrollTop;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: props.text },
      annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)]
    });
    view.scrollDOM.scrollTop = scrollTop;
  }, [props.text]);

  // The line a link points at.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !props.line) return;
    const lineNumber = Math.min(Math.max(1, props.line), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    const column = props.column ? Math.min(Math.max(1, props.column), line.length + 1) - 1 : 0;
    view.dispatch({
      selection: EditorSelection.single(line.from + column),
      effects: EditorView.scrollIntoView(line.from, { y: "center" })
    });
  }, [props.line, props.column, props.filename]);

  return <div ref={hostRef} className="file-code-editor" data-testid="file-code-editor" />;
}
