import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { LanguageDescription, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from "@codemirror/view";

/** Marks a change that came from the disk, not from typing. */
const externalUpdate = Annotation.define<boolean>();

const editorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--app-surface)", color: "var(--app-text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-gutters": { backgroundColor: "var(--app-surface-subtle)", color: "var(--app-muted)", borderRight: "1px solid var(--app-border)" },
  ".cm-activeLine": { backgroundColor: "var(--app-surface-subtle)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--app-surface-subtle)" },
  "&.cm-focused": { outline: "none" },
  ".cm-panels": { backgroundColor: "var(--app-surface-subtle)", color: "var(--app-text)" },
  ".cm-link-target-line": { backgroundColor: "var(--app-accent-soft)" }
});

/**
 * The panel's text editor: line numbers, syntax highlighting chosen by the file
 * name, search (Cmd+F), Cmd+S to save at once, and the line a link points at.
 * The document is owned outside: `text` replaces it only when it differs from
 * what the editor holds (the file changed on disk).
 */
export function CodeEditor(props: {
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
  const handlers = useRef({ onChange: props.onChange, onSave: props.onSave });
  handlers.current = { onChange: props.onChange, onSave: props.onSave };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const crlf = props.text.includes("\r\n");
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
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
            handlers.current.onChange?.(update.state.doc.toString());
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

  // The file changed on disk (or was taken from the disk): show it, keeping the scroll.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === props.text) return;
    const scrollTop = view.scrollDOM.scrollTop;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: props.text },
      annotations: externalUpdate.of(true)
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

