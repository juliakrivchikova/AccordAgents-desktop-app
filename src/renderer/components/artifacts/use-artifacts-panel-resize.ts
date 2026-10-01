import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";

import {
  ARTIFACT_PANEL_DEFAULT_WIDTH,
  CHAT_SIDE_PANEL_MIN_WIDTH,
  chatMainMinWidth,
  chatSidePanelWidthLimits,
  clampChatSidePanelWidth
} from "../../lib/chat-split-sizing";

interface ResizeLimits {
  min: number;
  max: number;
}

interface ArtifactsPanelResize {
  panelRef: RefObject<HTMLDivElement>;
  panelWidth: number;
  resizing: boolean;
  limits: ResizeLimits;
  startResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  resizeWithKeyboard: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  resetWidth: () => void;
}

export function useArtifactsPanelResize(): ArtifactsPanelResize {
  const panelRef = useRef<HTMLDivElement>(null);
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  // The width the User chose. The panel shows it clamped to the room there is
  // now, so a wide panel comes back once the room does (sidebar closed again).
  const requestedWidthRef = useRef(ARTIFACT_PANEL_DEFAULT_WIDTH);
  const [panelWidth, setPanelWidth] = useState(ARTIFACT_PANEL_DEFAULT_WIDTH);
  const [limits, setLimits] = useState<ResizeLimits>(() => chatSidePanelWidthLimits(window.innerWidth));
  const [resizing, setResizing] = useState(false);

  useEffect(() => () => cleanupResizeRef.current?.(), []);

  const getLimits = (): ResizeLimits => {
    const container = panelRef.current?.parentElement;
    const containerWidth = container?.getBoundingClientRect().width ?? window.innerWidth;
    return chatSidePanelWidthLimits(containerWidth, {
      minWidth: CHAT_SIDE_PANEL_MIN_WIDTH,
      mainMinWidth: chatMainMinWidth(container)
    });
  };

  const applyLimits = (next: ResizeLimits): void => {
    setLimits((current) => (current.min === next.min && current.max === next.max ? current : next));
    setPanelWidth(clampChatSidePanelWidth(requestedWidthRef.current, next));
  };

  const updatePanelWidth = (width: number): void => {
    const next = getLimits();
    requestedWidthRef.current = clampChatSidePanelWidth(width, next);
    applyLimits(next);
  };

  useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent) {
      return undefined;
    }
    const clampCurrentWidth = (): void => applyLimits(getLimits());
    clampCurrentWidth();
    const resizeObserver = new ResizeObserver(clampCurrentWidth);
    resizeObserver.observe(parent);
    window.addEventListener("resize", clampCurrentWidth);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", clampCurrentWidth);
    };
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    const right = panel.getBoundingClientRect().right;
    const move = (moveEvent: PointerEvent): void => updatePanelWidth(right - moveEvent.clientX);
    const stop = (): void => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      cleanupResizeRef.current = null;
    };
    cleanupResizeRef.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      updatePanelWidth(panelWidth + 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      updatePanelWidth(panelWidth - 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      updatePanelWidth(getLimits().min);
    } else if (event.key === "End") {
      event.preventDefault();
      updatePanelWidth(getLimits().max);
    }
  };

  return {
    panelRef,
    panelWidth,
    resizing,
    limits,
    startResize,
    resizeWithKeyboard,
    resetWidth: () => {
      // The default is the request; a squeezed panel shows less until room returns.
      requestedWidthRef.current = ARTIFACT_PANEL_DEFAULT_WIDTH;
      applyLimits(getLimits());
    }
  };
}
