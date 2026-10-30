import { lazy, Suspense, useContext, useMemo, useState } from "react";

import { FILE_PREVIEW_MARKDOWN_RENDER_LIMIT, fileBasename } from "../../../shared/filePreview";
import { MarkdownText } from "../content/markdown-text";
import { LocalFileLinkContext, type FileLinkRef } from "../content/local-file-link";
import { CsvTable } from "./csv-table";
import type { FileDocument } from "./use-file-document";
import { ImageViewer } from "./image-viewer";
import { PdfView } from "./pdf-view";

// CodeMirror loads the first time a file is shown, not with the app.
const CodeEditor = lazy(() => import("./code-editor"));

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

function ModeSwitch(props: { mode: ViewMode; rendered: string; onChange: (mode: ViewMode) => void }): JSX.Element {
  return (
    <div className="file-mode-switch" role="group" aria-label="Show as">
      {(["rendered", "source"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={props.mode === mode}
          className="file-viewer-text-button"
          onClick={() => props.onChange(mode)}
        >
          {mode === "rendered" ? props.rendered : "Source"}
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
  /** The name of the panel's Open button, for files it cannot show. */
  externalLabel: string;
}): JSX.Element {
  const { document } = props;
  const preview = document.preview;
  // A link to a line shows the source at that line; a very large Markdown file
  // opens as source too (decided before the first render, not after it).
  const sourceFirst = Boolean(props.line) || (preview?.kind === "markdown" && preview.size > FILE_PREVIEW_MARKDOWN_RENDER_LIMIT);
  const [chosen, setChosen] = useState<{ file: string; line?: number; mode: ViewMode } | undefined>();
  const mode: ViewMode = chosen && chosen.file === preview?.realPath && chosen.line === props.line
    ? chosen.mode
    : sourceFirst ? "source" : "rendered";
  const setMode = (next: ViewMode): void => {
    if (preview) setChosen({ file: preview.realPath, line: props.line, mode: next });
  };

  if (document.status === "loading" && !preview) {
    return <p className="file-panel-message">Loading…</p>;
  }
  if (document.status === "error" || !preview) {
    return <p className="file-panel-message" role="alert">{document.error ?? "This file could not be opened."}</p>;
  }
  if (preview.kind === "unsupported") {
    return <p className="file-panel-message">This kind of file is not shown in the panel. Use “{props.externalLabel}” or “Reveal in file manager” at the top.</p>;
  }
  if (preview.tooLarge) {
    return <p className="file-panel-message">This file is too large to show in the panel ({Math.round(preview.size / 1024 / 1024)} MB). Use “{props.externalLabel}” at the top.</p>;
  }

  const name = fileBasename(preview.realPath);
  const text = document.buffer?.text ?? preview.text ?? "";
  const editor = (
    <Suspense fallback={<p className="file-panel-message">Loading editor…</p>}>
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
    </Suspense>
  );

  switch (preview.kind) {
    case "image":
      return <ImageViewer src={`${preview.url ?? ""}?r=${document.revision}`} alt={name} />;
    case "pdf":
      return preview.data ? <PdfView data={preview.data} revision={document.revision} /> : <p className="file-panel-message">This PDF could not be read.</p>;
    case "html":
      return (
        <div className="file-split-view">
          <ModeSwitch mode={mode} rendered="Page" onChange={setMode} />
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
          <ModeSwitch mode={mode} rendered="Preview" onChange={setMode} />
          {mode === "rendered" ? <MarkdownBesideFile text={text} absolutePath={preview.absolutePath} /> : editor}
        </div>
      );
    case "csv":
      return (
        <div className="file-split-view">
          <ModeSwitch mode={mode} rendered="Table" onChange={setMode} />
          {mode === "rendered" ? <CsvTable text={text} filename={name} partial={preview.truncated} /> : editor}
        </div>
      );
    default:
      return editor;
  }
}
