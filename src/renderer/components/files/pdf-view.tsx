import { useEffect, useRef, useState } from "react";
import { Minus, Plus, Search } from "lucide-react";

import { IconButton } from "../primitives";

type PdfViewer = import("pdfjs-dist/web/pdf_viewer.mjs").PDFViewer;
type EventBus = import("pdfjs-dist/web/pdf_viewer.mjs").EventBus;

/**
 * A PDF in the side panel, drawn by pdf.js inside the panel (the Chromium viewer
 * does not load from a custom scheme or inside a frame in Electron). The worker
 * code runs on the page itself, so nothing is loaded from a separate URL in the
 * packaged app. Zoom, fit to width and text search.
 */
export function PdfView(props: { data: Uint8Array; revision: number }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PdfViewer | null>(null);
  const busRef = useRef<EventBus | null>(null);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; pages?: number; error?: string }>({ status: "loading" });
  const [scale, setScale] = useState<number | undefined>();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number } | undefined>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let cancelled = false;
    let destroyDocument: (() => void) | undefined;
    setState({ status: "loading" });
    setMatches(undefined);
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs");
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      const viewerModule = await import("pdfjs-dist/web/pdf_viewer.mjs");
      await import("pdfjs-dist/web/pdf_viewer.css");
      if (cancelled) return;
      const eventBus = new viewerModule.EventBus();
      const linkService = new viewerModule.PDFLinkService({ eventBus, externalLinkTarget: viewerModule.LinkTarget.BLANK });
      const findController = new viewerModule.PDFFindController({ eventBus, linkService });
      const viewer = new viewerModule.PDFViewer({ container, eventBus, linkService, findController });
      linkService.setViewer(viewer);
      eventBus.on("pagesinit", () => {
        viewer.currentScaleValue = "page-width";
      });
      eventBus.on("scalechanging", (event: { scale: number }) => setScale(event.scale));
      eventBus.on("updatefindmatchescount", (event: { matchesCount: { current: number; total: number } }) => setMatches(event.matchesCount));
      eventBus.on("updatefindcontrolstate", (event: { matchesCount: { current: number; total: number } }) => setMatches(event.matchesCount));
      // pdf.js may take the buffer over: hand it a copy.
      const task = pdfjs.getDocument({ data: props.data.slice(), isEvalSupported: false });
      destroyDocument = () => { void task.destroy(); };
      const document = await task.promise;
      if (cancelled) return;
      viewer.setDocument(document);
      linkService.setDocument(document);
      viewerRef.current = viewer;
      busRef.current = eventBus;
      setState({ status: "ready", pages: document.numPages });
    })().catch((error: unknown) => {
      if (!cancelled) setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
      viewerRef.current = null;
      busRef.current = null;
      destroyDocument?.();
    };
  }, [props.data, props.revision]);

  const find = (findPrevious = false): void => {
    busRef.current?.dispatch("find", {
      source: null,
      type: findPrevious ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false
    });
  };

  const zoom = (factor: number): void => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.currentScale = Math.min(8, Math.max(0.1, viewer.currentScale * factor));
  };

  return (
    <div className="file-pdf-view">
      <div className="file-viewer-toolbar" role="toolbar" aria-label="PDF">
        <IconButton label="Zoom out" icon={Minus} onClick={() => zoom(1 / 1.2)} />
        <span className="file-viewer-zoom-value">{scale ? `${Math.round(scale * 100)}%` : "…"}</span>
        <IconButton label="Zoom in" icon={Plus} onClick={() => zoom(1.2)} />
        <button
          type="button"
          className="file-viewer-text-button"
          onClick={() => { if (viewerRef.current) viewerRef.current.currentScaleValue = "page-width"; }}
        >
          Fit width
        </button>
        <form
          className="file-viewer-search"
          onSubmit={(event) => { event.preventDefault(); find(); }}
        >
          <Search size={13} aria-hidden />
          <input
            value={query}
            placeholder="Find in PDF"
            aria-label="Find in PDF"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                find(true);
              }
            }}
          />
          {matches && query && <span className="file-viewer-meta">{matches.total ? `${matches.current}/${matches.total}` : "0"}</span>}
        </form>
        {state.pages ? <span className="file-viewer-meta">{state.pages} pages</span> : null}
      </div>
      <div className="file-pdf-stage">
        <div ref={containerRef} className="file-pdf-container" data-testid="file-pdf">
          <div className="pdfViewer" />
        </div>
        {state.status === "loading" && <p className="file-panel-message file-pdf-overlay">Loading PDF…</p>}
        {state.status === "error" && <p className="file-panel-message file-pdf-overlay">This PDF could not be shown: {state.error}</p>}
      </div>
    </div>
  );
}
