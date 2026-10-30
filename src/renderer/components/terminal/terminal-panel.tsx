import * as React from "react";
import { AlertCircle, Plus, SquareTerminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { terminalWorkspaceMatches } from "../../../shared/terminal";
import { IconButton } from "../primitives";
import { TERMINAL_PANEL_MIN_HEIGHT, type TerminalPanelState } from "./use-terminal-panel";

export interface TerminalPanelChat {
  id: string;
  repoPath?: string;
}

export interface TerminalPanelProps {
  state: TerminalPanelState;
  /** The chat open beside the panel, if any: its project is compared with
   *  the terminal's folder. No chat (Settings, Activity list): no warning. */
  chat?: TerminalPanelChat;
}

// xterm.js and its renderer load only once a terminal is opened, not with
// the app.
const TerminalView = React.lazy(() => import("./terminal-view").then((module) => ({ default: module.TerminalView })));

/** The share of the workspace the panel may take when dragged up. */
const MAX_HEIGHT_SHARE = 0.75;

/**
 * The terminal panel under the chat, like the Codex desktop app's: tabs of
 * shells on this computer, a warning when a tab's folder is not the open
 * chat's project, and a way back when the terminal process stopped.
 */
export function TerminalPanel({ state, chat }: TerminalPanelProps): JSX.Element | null {
  const panelRef = React.useRef<HTMLElement>(null);
  const [resizing, setResizing] = React.useState(false);
  // While dragging, only the panel follows the pointer; the height is saved
  // once, when the drag ends.
  const [dragHeight, setDragHeight] = React.useState<number>();
  const chatRoot = useChatWorkspaceRoot(chat?.repoPath);
  const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
  const active = state.terminals.find((terminal) => terminal.terminalId === state.activeTerminalId);

  if (!state.terminals.length) return null;

  const dismissKey = active && chat ? `${active.terminalId}\u0000${chat.id}` : undefined;
  const showMismatch = Boolean(
    active && !active.lost && chat && chatRoot.resolved && dismissKey && !dismissed.has(dismissKey)
    && !terminalWorkspaceMatches(active.workspaceRoot, chatRoot.root)
  );

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const panel = panelRef.current;
    const workspace = panel?.parentElement;
    if (!panel || !workspace) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    const bottom = panel.getBoundingClientRect().bottom;
    const maxHeight = Math.max(TERMINAL_PANEL_MIN_HEIGHT, workspace.getBoundingClientRect().height * MAX_HEIGHT_SHARE);
    let latest: number | undefined;
    const move = (moveEvent: PointerEvent): void => {
      latest = Math.max(TERMINAL_PANEL_MIN_HEIGHT, Math.min(maxHeight, bottom - moveEvent.clientY));
      setDragHeight(latest);
    };
    const stop = (): void => {
      setResizing(false);
      setDragHeight(undefined);
      if (latest !== undefined) state.setHeight(latest);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  return (
    <section
      ref={panelRef}
      className="terminal-panel"
      data-resizing={resizing ? "true" : undefined}
      data-testid="terminal-panel"
      aria-label="Terminal"
      hidden={!state.open}
      style={{ height: dragHeight ?? state.height }}
      onDragOver={(event) => {
        // A file dropped anywhere on the panel must not open in the window.
        event.preventDefault();
        event.dataTransfer.dropEffect = active && !active.lost ? "copy" : "none";
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!active || active.lost) return;
        // As in Terminal and Codex: a dropped file types its quoted path.
        const paths = [...event.dataTransfer.files]
          .map((file) => window.consensus.terminalPathForFile(file))
          .filter(Boolean)
          .map(shellQuote);
        if (paths.length) state.typeIntoActive(`${paths.join(" ")} `);
      }}
    >
      <div
        className="terminal-panel-resizer"
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        onPointerDown={startResize}
      />
      <div className="terminal-panel-header">
        <div className="terminal-panel-tabs" role="tablist" aria-label="Terminals">
          {state.terminals.map((terminal) => {
            const selected = terminal.terminalId === state.activeTerminalId;
            return (
              <div
                key={terminal.terminalId}
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={cn("terminal-panel-tab", selected && "is-selected")}
                title={terminal.cwd}
                data-testid="terminal-tab"
                onClick={() => state.selectTerminal(terminal.terminalId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") state.selectTerminal(terminal.terminalId);
                }}
              >
                <SquareTerminal className="terminal-panel-tab-icon" aria-hidden />
                <span className="terminal-panel-tab-title">{terminal.title}</span>
                <IconButton
                  label="Close terminal"
                  icon={X}
                  size="xs"
                  className="terminal-panel-tab-close"
                  data-testid="terminal-tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    state.closeTerminal(terminal.terminalId);
                  }}
                />
              </div>
            );
          })}
          <IconButton
            label="New terminal"
            icon={Plus}
            data-testid="terminal-new"
            disabled={state.creating}
            onClick={state.newTerminal}
          />
        </div>
        <IconButton label="Hide terminal" icon={X} data-testid="terminal-hide" onClick={state.close} />
      </div>
      {showMismatch && dismissKey && (
        <div className="terminal-panel-notice" role="status" data-testid="terminal-mismatch">
          <AlertCircle className="terminal-panel-notice-icon" aria-hidden />
          <span className="terminal-panel-notice-text">This terminal's folder does not match this chat's project</span>
          <Button
            variant="ghost"
            size="sm"
            className="terminal-panel-notice-dismiss"
            onClick={() => setDismissed((current) => new Set(current).add(dismissKey))}
          >
            Dismiss
          </Button>
          <Button size="sm" onClick={state.newTerminal} disabled={state.creating}>Open new terminal</Button>
        </div>
      )}
      <div className="terminal-panel-body">
        <React.Suspense fallback={null}>
          {state.terminals.map((terminal) => (
            <TerminalView
              key={terminal.terminalId}
              terminalId={terminal.terminalId}
              shown={state.open && state.pageVisible && !terminal.lost && terminal.terminalId === state.activeTerminalId}
              focusRequest={state.focusRequest}
            />
          ))}
        </React.Suspense>
        {active?.lost && (
          <div className="terminal-panel-lost" role="alert" data-testid="terminal-lost">
            <p className="terminal-panel-lost-title">The terminal stopped unexpectedly</p>
            <p className="terminal-panel-lost-text">Restart it to continue. Commands that were running in it were stopped.</p>
            <Button size="sm" onClick={state.restart} disabled={state.restarting}>Restart</Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** A path as one shell word. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** The open chat's project folder as main normalizes it, so it compares
 *  with a terminal's folder. */
function useChatWorkspaceRoot(repoPath: string | undefined): { resolved: boolean; root: string | null } {
  const [value, setValue] = React.useState<{ key: string | undefined; root: string | null }>({ key: undefined, root: null });
  const key = repoPath?.trim() || "";
  React.useEffect(() => {
    let cancelled = false;
    if (!key) {
      setValue({ key, root: null });
      return undefined;
    }
    void window.consensus.terminalWorkspaceRoot(key)
      .then((root) => { if (!cancelled) setValue({ key, root }); })
      .catch(() => { if (!cancelled) setValue({ key, root: key }); });
    return () => { cancelled = true; };
  }, [key]);
  return { resolved: value.key === key, root: value.root };
}
