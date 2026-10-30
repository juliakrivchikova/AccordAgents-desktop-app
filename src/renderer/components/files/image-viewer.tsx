import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";

import { IconButton } from "../primitives";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

interface View {
  scale: number;
  x: number;
  y: number;
  /** Fitted to the panel; follows its size until the User zooms. */
  fit: boolean;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * An image in the side panel. It starts fitted to the panel. The wheel and a
 * trackpad pinch zoom around the pointer; dragging moves a zoomed image;
 * "Fit" and "100%" set the scale; a double click switches between them.
 */
export function ImageViewer(props: { src: string; alt: string }): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | undefined>();
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0, fit: true });
  const [loadError, setLoadError] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | undefined>();

  const fitView = useCallback((): View | undefined => {
    const frame = frameRef.current;
    if (!frame || !natural) return undefined;
    const bounds = frame.getBoundingClientRect();
    const scale = clampScale(Math.min(1, bounds.width / natural.width, bounds.height / natural.height));
    return {
      scale,
      x: (bounds.width - natural.width * scale) / 2,
      y: (bounds.height - natural.height * scale) / 2,
      fit: true
    };
  }, [natural]);

  const actualSize = useCallback((): View | undefined => {
    const frame = frameRef.current;
    if (!frame || !natural) return undefined;
    const bounds = frame.getBoundingClientRect();
    return { scale: 1, x: (bounds.width - natural.width) / 2, y: (bounds.height - natural.height) / 2, fit: false };
  }, [natural]);

  useEffect(() => {
    setNatural(undefined);
    setLoadError(false);
    setView({ scale: 1, x: 0, y: 0, fit: true });
  }, [props.src]);

  useLayoutEffect(() => {
    if (!view.fit) return;
    const next = fitView();
    if (next) setView(next);
  }, [fitView, view.fit]);

  // Follow the panel's size while fitted.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const observer = new ResizeObserver(() => {
      setView((current) => (current.fit ? fitView() ?? current : current));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [fitView]);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const frame = frameRef.current;
    if (!frame || !natural) return;
    const bounds = frame.getBoundingClientRect();
    const px = clientX === undefined ? bounds.width / 2 : clientX - bounds.left;
    const py = clientY === undefined ? bounds.height / 2 : clientY - bounds.top;
    setView((current) => {
      const scale = clampScale(current.scale * factor);
      const ratio = scale / current.scale;
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio, fit: false };
    });
  }, [natural]);

  // A non-passive listener, so the wheel zooms the image instead of scrolling the page.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      // A pinch arrives as a wheel with ctrlKey and small deltas; scale it up to feel the same.
      const delta = event.ctrlKey ? event.deltaY * 3 : event.deltaY;
      zoomAt(Math.exp(-delta / 300), event.clientX, event.clientY);
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const percent = Math.round(view.scale * 100);

  return (
    <div className="file-image-viewer">
      <div className="file-viewer-toolbar" role="toolbar" aria-label="Image zoom">
        <IconButton label="Zoom out" icon={Minus} onClick={() => zoomAt(1 / 1.25)} />
        <span className="file-viewer-zoom-value" aria-live="polite">{percent}%</span>
        <IconButton label="Zoom in" icon={Plus} onClick={() => zoomAt(1.25)} />
        <button type="button" className="file-viewer-text-button" aria-pressed={view.fit} onClick={() => { const next = fitView(); if (next) setView(next); }}>
          <Maximize2 size={13} aria-hidden /> Fit
        </button>
        <button type="button" className="file-viewer-text-button" aria-pressed={!view.fit && view.scale === 1} onClick={() => { const next = actualSize(); if (next) setView(next); }}>
          100%
        </button>
        {natural && <span className="file-viewer-meta">{natural.width}×{natural.height}</span>}
      </div>
      <div
        ref={frameRef}
        className="file-image-frame"
        data-dragging={drag.current ? "true" : undefined}
        data-testid="file-image-frame"
        onDoubleClick={() => {
          const next = view.fit ? actualSize() : fitView();
          if (next) setView(next);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          setView((value) => ({ ...value, x: current.x + event.clientX - current.startX, y: current.y + event.clientY - current.startY, fit: false }));
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) drag.current = undefined;
        }}
        onPointerCancel={() => { drag.current = undefined; }}
      >
        {loadError ? (
          <p className="file-panel-message">This image could not be shown.</p>
        ) : (
          <img
            src={props.src}
            alt={props.alt}
            draggable={false}
            data-testid="file-image"
            style={{
              width: natural ? natural.width * view.scale : undefined,
              height: natural ? natural.height * view.scale : undefined,
              transform: `translate(${view.x}px, ${view.y}px)`,
              visibility: natural ? "visible" : "hidden"
            }}
            onLoad={(event) => {
              const image = event.currentTarget;
              // An SVG without a size reports 0: give it a size the panel can fit.
              setNatural({ width: image.naturalWidth || 800, height: image.naturalHeight || 600 });
            }}
            onError={() => setLoadError(true)}
          />
        )}
      </div>
    </div>
  );
}
