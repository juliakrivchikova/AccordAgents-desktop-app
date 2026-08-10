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
  CHAT_SIDE_PANEL_MAX_WIDTH,
  CHAT_SIDE_PANEL_MIN_WIDTH,
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
  getLimits: () => ResizeLimits;
  startResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  resizeWithKeyboard: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  resetWidth: () => void;
}

export function useArtifactsPanelResize(): ArtifactsPanelResize {
  const panelRef = useRef<HTMLDivElement>(null);
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  const [panelWidth, setPanelWidth] = useState(ARTIFACT_PANEL_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);

  useEffect(() => () => cleanupResizeRef.current?.(), []);

  const getLimits = (): ResizeLimits => {
    const containerWidth = panelRef.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    return chatSidePanelWidthLimits(containerWidth, {
      minWidth: CHAT_SIDE_PANEL_MIN_WIDTH,
      maxWidth: CHAT_SIDE_PANEL_MAX_WIDTH
    });
  };

  const updatePanelWidth = (width: number): void => {
    setPanelWidth(clampChatSidePanelWidth(width, getLimits()));
  };

  useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent) {
      return undefined;
    }
    const clampCurrentWidth = (): void => {
      const limits = getLimits();
      setPanelWidth((current) => clampChatSidePanelWidth(current, limits));
    };
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
    getLimits,
    startResize,
    resizeWithKeyboard,
    resetWidth: () => updatePanelWidth(ARTIFACT_PANEL_DEFAULT_WIDTH)
  };
}
