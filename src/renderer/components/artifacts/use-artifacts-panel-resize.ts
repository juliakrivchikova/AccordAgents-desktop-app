import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState
} from "react";

const DEFAULT_PANEL_WIDTH = 460;
const MIN_PANEL_WIDTH = 340;
const MAX_PANEL_WIDTH = 960;

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
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [resizing, setResizing] = useState(false);

  useEffect(() => () => cleanupResizeRef.current?.(), []);

  const getLimits = (): ResizeLimits => {
    const containerWidth = panelRef.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const min = Math.min(MIN_PANEL_WIDTH, Math.floor(containerWidth * 0.88));
    return {
      min,
      max: Math.max(min, Math.min(MAX_PANEL_WIDTH, Math.floor(containerWidth * 0.88)))
    };
  };

  const updatePanelWidth = (width: number): void => {
    const { min, max } = getLimits();
    setPanelWidth(Math.round(Math.min(max, Math.max(min, width))));
  };

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
    resetWidth: () => updatePanelWidth(DEFAULT_PANEL_WIDTH)
  };
}
