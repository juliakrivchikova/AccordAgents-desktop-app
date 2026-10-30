import * as React from "react";
import { toast } from "sonner";
import type { TerminalSummary } from "../../../shared/terminal";
import { terminalPort } from "./terminal-port";

const HEIGHT_STORAGE_KEY = "accordagents.terminalPanel.height";
const OPEN_STORAGE_KEY = "accordagents.terminalPanel.open";
const ACTIVE_STORAGE_KEY = "accordagents.terminalPanel.active";
export const TERMINAL_PANEL_DEFAULT_HEIGHT = 260;
export const TERMINAL_PANEL_MIN_HEIGHT = 120;

export interface TerminalPanelState {
  open: boolean;
  terminals: TerminalSummary[];
  activeTerminalId?: string;
  height: number;
  focusRequest: number;
  creating: boolean;
  restarting: boolean;
  /** The window is on screen: a minimized, covered or other-Space window
   *  shows no terminal, so its slowed-down page never holds a shell back. */
  pageVisible: boolean;
  toggle: () => void;
  close: () => void;
  newTerminal: () => void;
  selectTerminal: (terminalId: string) => void;
  closeTerminal: (terminalId: string) => void;
  /** Sends text to the shown terminal as if typed (a dropped file's path). */
  typeIntoActive: (text: string) => void;
  restart: () => void;
  setHeight: (height: number) => void;
}

/**
 * The terminal panel's state: one set of tabs for the whole window (as in
 * Codex), a new tab opening in the project of the chat it is opened from.
 * Hiding the panel leaves the shells running.
 */
export function useTerminalPanel(repoPath: string | undefined): TerminalPanelState {
  const [open, setOpen] = React.useState(false);
  const [terminals, setTerminals] = React.useState<TerminalSummary[]>([]);
  const [activeTerminalId, setActiveTerminalId] = React.useState<string>();
  const [height, setHeightState] = React.useState(readStoredHeight);
  const [focusRequest, setFocusRequest] = React.useState(0);
  const [creating, setCreating] = React.useState(false);
  const [restarting, setRestarting] = React.useState(false);
  const [pageVisible, setPageVisible] = React.useState(() => document.visibilityState === "visible");
  const repoPathRef = React.useRef(repoPath);
  repoPathRef.current = repoPath;
  const stateRef = React.useRef({ open, terminals, creating });
  stateRef.current = { open, terminals, creating };
  // What the window showed before a reload, read once before anything here
  // writes it again.
  const [restore] = React.useState(() => ({
    open: window.sessionStorage.getItem(OPEN_STORAGE_KEY) === "true",
    active: window.sessionStorage.getItem(ACTIVE_STORAGE_KEY) ?? undefined
  }));
  const [restored, setRestored] = React.useState(false);

  const applyList = React.useCallback((next: TerminalSummary[]) => {
    setTerminals(next);
    setActiveTerminalId((current) => (current && next.some((terminal) => terminal.terminalId === current)
      ? current
      : next[next.length - 1]?.terminalId));
    if (!next.length) setOpen(false);
  }, []);

  // After a window reload the shells are still running: take them back.
  React.useEffect(() => {
    let cancelled = false;
    void window.consensus.listTerminals().then((result) => {
      if (cancelled) return;
      applyList(result.terminals);
      if (restore.active && result.terminals.some((terminal) => terminal.terminalId === restore.active)) {
        setActiveTerminalId(restore.active);
      }
      if (result.terminals.length && restore.open) setOpen(true);
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setRestored(true);
    });
    const off = window.consensus.onTerminalHostState((event) => {
      if (event.hostState !== "running") terminalPort.drop();
      else terminalPort.ensureConnected();
      applyList(event.terminals);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [applyList, restore]);

  React.useEffect(() => {
    const onVisibility = (): void => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  React.useEffect(() => {
    if (!restored) return;
    window.sessionStorage.setItem(OPEN_STORAGE_KEY, open ? "true" : "false");
    if (activeTerminalId) window.sessionStorage.setItem(ACTIVE_STORAGE_KEY, activeTerminalId);
    else window.sessionStorage.removeItem(ACTIVE_STORAGE_KEY);
  }, [open, activeTerminalId, restored]);

  const createTerminal = React.useCallback(async (): Promise<void> => {
    if (stateRef.current.creating) return;
    setCreating(true);
    try {
      const terminal = await window.consensus.createTerminal({ repoPath: repoPathRef.current || undefined });
      setTerminals((current) => [...current, terminal]);
      setActiveTerminalId(terminal.terminalId);
      setOpen(true);
      setFocusRequest((value) => value + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The terminal could not start.");
    } finally {
      setCreating(false);
    }
  }, []);

  const toggle = React.useCallback(() => {
    const { open: isOpen, terminals: current } = stateRef.current;
    if (isOpen) {
      setOpen(false);
      return;
    }
    if (!current.length) {
      void createTerminal();
      return;
    }
    setOpen(true);
    setFocusRequest((value) => value + 1);
  }, [createTerminal]);

  // Ctrl+` opens and hides the panel, as in Codex. By the physical key: in a
  // Russian layout the same key types "ё". Captured before xterm sees it.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== "Backquote" || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [toggle]);

  // A tab closes when its shell ends (exit, Ctrl+D) or the User closes it;
  // the last one closing hides the panel.
  const removeTerminal = React.useCallback((terminalId: string) => {
    const current = stateRef.current.terminals;
    const index = current.findIndex((terminal) => terminal.terminalId === terminalId);
    if (index < 0) return;
    const next = current.filter((terminal) => terminal.terminalId !== terminalId);
    stateRef.current = { ...stateRef.current, terminals: next };
    setTerminals(next);
    setActiveTerminalId((active) => (active === terminalId ? (next[index] ?? next[index - 1])?.terminalId : active));
    if (!next.length) setOpen(false);
  }, []);

  // A shell that ends (exit, Ctrl+D), shown or not, closes its tab.
  React.useEffect(() => terminalPort.onExit(removeTerminal), [removeTerminal]);

  const closeTerminal = React.useCallback((terminalId: string) => {
    removeTerminal(terminalId);
    void window.consensus.killTerminal(terminalId).catch(() => undefined);
  }, [removeTerminal]);

  const restart = React.useCallback(() => {
    setRestarting(true);
    void window.consensus.restartTerminals()
      .then((result) => {
        applyList(result.terminals);
        return terminalPort.connect();
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "The terminal could not restart.");
      })
      .finally(() => setRestarting(false));
  }, [applyList]);

  const setHeight = React.useCallback((next: number) => {
    const clamped = Math.max(TERMINAL_PANEL_MIN_HEIGHT, Math.round(next));
    setHeightState(clamped);
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(clamped));
  }, []);

  return {
    open,
    terminals,
    activeTerminalId,
    height,
    focusRequest,
    creating,
    restarting,
    pageVisible,
    toggle,
    close: () => setOpen(false),
    newTerminal: () => void createTerminal(),
    selectTerminal: (terminalId) => {
      setActiveTerminalId(terminalId);
      setFocusRequest((value) => value + 1);
    },
    closeTerminal,
    typeIntoActive: (text) => {
      if (!activeTerminalId || !text) return;
      terminalPort.send({ type: "input", terminalId: activeTerminalId, data: text });
      setFocusRequest((value) => value + 1);
    },
    restart,
    setHeight
  };
}

function readStoredHeight(): number {
  const stored = Number(window.localStorage.getItem(HEIGHT_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= TERMINAL_PANEL_MIN_HEIGHT ? stored : TERMINAL_PANEL_DEFAULT_HEIGHT;
}
