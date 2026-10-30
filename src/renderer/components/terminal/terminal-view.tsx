import * as React from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_SCROLLBACK_LINES } from "../../../shared/terminal";
import { terminalPort } from "./terminal-port";

export interface TerminalViewProps {
  terminalId: string;
  /** The tab is the selected one, the panel is open and the shell is alive. */
  shown: boolean;
  /** Bumped to ask the shown terminal for focus. */
  focusRequest: number;
}

/** One terminal tab: an xterm.js screen tied to its shell in the host while
 *  it is on screen. */
export function TerminalView({ terminalId, shown, focusRequest }: TerminalViewProps): JSX.Element {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<Terminal>();
  const fitRef = React.useRef<FitAddon>();
  const webglRef = React.useRef<WebglAddon | null>();

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let dark = isDarkTheme();
    const terminal = new Terminal({
      fontFamily: cssValue("--app-terminal-font") || "Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: terminalTheme(),
      macOptionClickForcesSelection: true,
      // Links a program prints open in the system browser, as in Terminal
      // and Codex, never in a window of this app.
      linkHandler: {
        activate: (_event, uri) => {
          if (/^https?:\/\//i.test(uri)) void window.consensus.openExternal(uri);
        }
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const input = terminal.onData((data) => terminalPort.send({ type: "input", terminalId, data }));
    const resize = terminal.onResize(({ cols, rows }) => terminalPort.send({ type: "resize", terminalId, cols, rows }));
    // The window's class changes on every focus change; only a change of
    // theme repaints the terminal.
    const themeObserver = new MutationObserver(() => {
      if (isDarkTheme() === dark) return;
      dark = isDarkTheme();
      terminal.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      themeObserver.disconnect();
      input.dispose();
      resize.dispose();
      webglRef.current?.dispose();
      webglRef.current = undefined;
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
    };
  }, [terminalId]);

  // On screen: drawn through WebGL, fitted to the panel and attached to its
  // shell, which sends the screen as it is now and then live output. Off
  // screen: detached, so its output costs this window nothing.
  React.useEffect(() => {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!shown || !terminal || !fit || !container) return undefined;
    // One GL context per terminal, made the first time it is shown and kept:
    // making one on every show would pile them up faster than the browser
    // frees them. null: this terminal draws with the DOM renderer.
    if (webglRef.current === undefined) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          webglRef.current = null;
        });
        terminal.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        webglRef.current = null;
      }
    }
    safeFit(fit);
    const unregister = terminalPort.register(terminalId, {
      size: () => ({ cols: terminal.cols, rows: terminal.rows }),
      onSnapshot: (serialized) => {
        // Reset in order with what xterm still has queued (reset() would act
        // at once and let older queued output land on the cleared screen).
        terminal.write(`\x1bc${serialized}`);
      },
      onData: (data) => {
        terminal.write(data, () => terminalPort.send({ type: "ack", terminalId, chars: data.length }));
      }
    });
    const sizeObserver = new ResizeObserver(() => safeFit(fit));
    sizeObserver.observe(container);
    return () => {
      sizeObserver.disconnect();
      unregister();
    };
  }, [shown, terminalId]);

  React.useEffect(() => {
    if (shown && focusRequest > 0) terminalRef.current?.focus();
  }, [focusRequest, shown]);

  return <div ref={containerRef} className="terminal-view" data-terminal-id={terminalId} hidden={!shown} />;
}

function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // Not laid out yet; the next resize fits it.
  }
}

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark");
}

function cssValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalTheme(): ITheme {
  const color = (name: string): string | undefined => cssValue(`--app-terminal-${name}`) || undefined;
  return {
    background: color("bg"),
    foreground: color("fg"),
    cursor: color("cursor"),
    cursorAccent: color("bg"),
    selectionBackground: color("selection"),
    black: color("black"),
    red: color("red"),
    green: color("green"),
    yellow: color("yellow"),
    blue: color("blue"),
    magenta: color("magenta"),
    cyan: color("cyan"),
    white: color("white"),
    brightBlack: color("bright-black"),
    brightRed: color("bright-red"),
    brightGreen: color("bright-green"),
    brightYellow: color("bright-yellow"),
    brightBlue: color("bright-blue"),
    brightMagenta: color("bright-magenta"),
    brightCyan: color("bright-cyan"),
    brightWhite: color("bright-white")
  };
}
