import { useContext, useEffect, useMemo, useState } from "react";

import { MarkdownText } from "../content/markdown-text";
import { LocalFileLinkContext, type FileLinkRef } from "../content/local-file-link";
import { CodeEditor } from "./code-editor";
import { CsvTable } from "./csv-table";
import type { FileDocument } from "./use-file-document";
import { ImageViewer } from "./image-viewer";
import { PdfView } from "./pdf-view";

type ViewMode = "rendered" | "source";

function joinRelative(directory: string, relative: string): string {
  const parts = directory.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/") || "/";
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/** Links inside a Markdown file point next to the file, not at the project root. */
function MarkdownBesideFile(props: { text: string; absolutePath: string }): JSX.Element {
  const outer = useContext(LocalFileLinkContext);
  const directory = props.absolutePath.slice(0, props.absolutePath.lastIndexOf("/")) || "/";
  const value = useMemo(() => ({
    ...outer,
    requestOpenFile: outer.requestOpenFile
      ? (ref: FileLinkRef) => outer.requestOpenFile?.({
        ...ref,
        path: ref.path.startsWith("/") || ref.path.startsWith("~") ? ref.path : joinRelative(directory, ref.path)
      })
      : undefined
  }), [directory, outer]);
  return (
    <LocalFileLinkContext.Provider value={value}>
      <div className="file-markdown-preview">
        <MarkdownText content={props.text} />
      </div>
    </LocalFileLinkContext.Provider>
  );
}

function ModeSwitch(props: { mode: ViewMode; rendered: string; source: string; onChange: (mode: ViewMode) => void }): JSX.Element {
  return (
    <div className="file-mode-switch" role="tablist" aria-label="View">
      {(["rendered", "source"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          role="tab"
          aria-selected={props.mode === mode}
          className="file-viewer-text-button"
          onClick={() => props.onChange(mode)}
        >
          {mode === "rendered" ? props.rendered : props.source}
        </button>
      ))}
    </div>
  );
}

/** Chooses the viewer for the file's kind; text kinds edit through the shared buffer. */
export function FilePanelBody(props: {
  document: FileDocument;
  line?: number;
  column?: number;
}): JSX.Element {
  const { document } = props;
  const preview = document.preview;
  const [mode, setMode] = useState<ViewMode>("rendered");

  useEffect(() => {
    // A link to a line in a Markdown or HTML file shows the source at that line.
    setMode(props.line ? "source" : "rendered");
  }, [preview?.realPath, props.line]);

  if (document.status === "loading" && !preview) {
    return <p className="file-panel-message">Loading…</p>;
  }
  if (document.status === "error" || !preview) {
    return <p className="file-panel-message" role="alert">{document.error ?? "This file could not be opened."}</p>;
  }
  if (preview.kind === "unsupported") {
    return <p className="file-panel-message">This kind of file is not shown in the panel. Use “Open in…” above.</p>;
  }
  if (preview.tooLarge) {
    return <p className="file-panel-message">This file is too large to show in the panel ({Math.round(preview.size / 1024 / 1024)} MB). Use “Open in…” above.</p>;
  }

  const name = basename(preview.realPath);
  const text = document.buffer?.text ?? preview.text ?? "";
  const editor = (
    <CodeEditor
      key={preview.realPath}
      text={text}
      filename={name}
      readOnly={!preview.editable || Boolean(document.buffer?.conflict) || document.deleted}
      line={props.line}
      column={props.column}
      onChange={document.edit}
      onSave={document.saveNow}
    />
  );

  switch (preview.kind) {
    case "image":
      return <ImageViewer src={`${preview.url ?? ""}?r=${document.revision}`} alt={name} />;
    case "pdf":
      return preview.data ? <PdfView data={preview.data} revision={document.revision} /> : <p className="file-panel-message">This PDF could not be read.</p>;
    case "html":
      return (
        <div className="file-split-view">
          <ModeSwitch mode={mode} rendered="Page" source="Source" onChange={setMode} />
          {mode === "rendered" && preview.url ? (
            <iframe
              key={`${preview.realPath}:${document.revision}`}
              className="file-html-frame"
              src={preview.url}
              title={name}
              // Scripts run, but in an opaque origin: no access to the app, its bridge or other files.
              sandbox="allow-scripts allow-forms allow-popups"
              referrerPolicy="no-referrer"
              data-testid="file-html-frame"
            />
          ) : editor}
        </div>
      );
    case "markdown":
      return (
        <div className="file-split-view">
          <ModeSwitch mode={mode} rendered="Preview" source="Text" onChange={setMode} />
          {mode === "rendered" ? <MarkdownBesideFile text={text} absolutePath={preview.absolutePath} /> : editor}
        </div>
      );
    case "csv":
      return (
        <div className="file-split-view">
          <ModeSwitch mode={mode} rendered="Table" source="Text" onChange={setMode} />
          {mode === "rendered" ? <CsvTable text={text} filename={name} partial={preview.truncated} /> : editor}
        </div>
      );
    default:
      return editor;
  }
}
