import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Minus, Plus, Search } from "lucide-react";

import { IconButton } from "../primitives";
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from "./zoom";

type PdfViewer = import("pdfjs-dist/web/pdf_viewer.mjs").PDFViewer;
type EventBus = import("pdfjs-dist/web/pdf_viewer.mjs").EventBus;

let workerReady: Promise<void> | undefined;

/**
 * pdf.js parses in its own worker, bundled into the app (no separate URL to
 * load in the packaged app): a big or scanned PDF does not stall the chat, and
 * the parser runs outside the page that holds the app's bridge.
 */
function ensurePdfWorker(): Promise<void> {
  workerReady ??= (async () => {
    const [pdfjs, { default: PdfWorker }] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?worker&inline")
    ]);
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  })();
  return workerReady;
}

/**
 * A PDF in the side panel, drawn by pdf.js inside the panel (the Chromium viewer
 * does not load from a custom scheme or inside a frame in Electron). Zoom, fit
 * to width and text search.
 */
export function PdfView(props: { data: Uint8Array; revision: number }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PdfViewer | null>(null);
  const busRef = useRef<EventBus | null>(null);
  const lastQuery = useRef("");
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
    lastQuery.current = "";
    void (async () => {
      await ensurePdfWorker();
      const pdfjs = await import("pdfjs-dist");
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
      // The worker takes the buffer over: hand it a copy, the panel keeps its own.
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

  /** The same query again goes to the next (or previous) match; a new one starts over. */
  const find = (findPrevious = false): void => {
    if (!query) return;
    const again = query === lastQuery.current;
    lastQuery.current = query;
    busRef.current?.dispatch("find", {
      source: null,
      type: again ? "again" : "",
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
    viewer.currentScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewer.currentScale * factor));
  };

  return (
    <div className="file-pdf-view">
      <div className="file-viewer-toolbar" role="toolbar" aria-label="PDF">
        <IconButton label="Zoom out" icon={Minus} onClick={() => zoom(1 / ZOOM_STEP)} />
        <span className="file-viewer-zoom-value">{scale ? `${Math.round(scale * 100)}%` : "…"}</span>
        <IconButton label="Zoom in" icon={Plus} onClick={() => zoom(ZOOM_STEP)} />
        <button
          type="button"
          className="file-viewer-text-button"
          onClick={() => { if (viewerRef.current) viewerRef.current.currentScaleValue = "page-width"; }}
        >
          Fit width
        </button>
        <form className="file-viewer-search" role="search" onSubmit={(event) => { event.preventDefault(); find(); }}>
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
        <IconButton label="Previous match" icon={ChevronUp} disabled={!query} onClick={() => find(true)} />
        <IconButton label="Next match" icon={ChevronDown} disabled={!query} onClick={() => find(false)} />
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
