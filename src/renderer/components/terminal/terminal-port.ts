import {
  TERMINAL_PORT_WINDOW_MESSAGE,
  type TerminalHostToWindowMessage,
  type TerminalWindowToHostMessage
} from "../../../shared/terminal";

/** What a shown terminal view hears from the host. */
export interface TerminalPortListener {
  onSnapshot(serialized: string, cols: number, rows: number): void;
  onData(data: string): void;
  /** Called when a new port arrives, to attach again with the current size. */
  size(): { cols: number; rows: number };
}

/**
 * The window's end of the terminal port. The preload posts each new port to
 * this page (a reload or a restarted host brings a new one). Only terminals
 * on screen are attached: a hidden tab or a closed panel costs this window
 * nothing, and gets its screen back as a snapshot when shown again.
 */
export class TerminalPortClient {
  private port?: MessagePort;
  private readonly listeners = new Map<string, TerminalPortListener>();
  private connecting?: Promise<boolean>;
  private listening = false;
  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data = event.data as { type?: unknown } | null;
    if (!data || data.type !== TERMINAL_PORT_WINDOW_MESSAGE) return;
    const port = event.ports[0];
    if (port) this.adopt(port);
  };
  private exitHandler?: (terminalId: string) => void;

  constructor(private readonly requestPort: () => Promise<boolean>) {}

  /** Shows a terminal: attaches it and streams its output to the listener.
   *  The returned function hides it again. */
  register(terminalId: string, listener: TerminalPortListener): () => void {
    this.listen();
    this.listeners.set(terminalId, listener);
    if (this.port) this.attach(terminalId, listener);
    else void this.connect();
    return () => {
      if (this.listeners.get(terminalId) !== listener) return;
      this.listeners.delete(terminalId);
      this.send({ type: "detach", terminalId });
    };
  }

  /** Every shell that ends, shown or not, is reported here. */
  onExit(handler: (terminalId: string) => void): () => void {
    this.exitHandler = handler;
    return () => {
      if (this.exitHandler === handler) this.exitHandler = undefined;
    };
  }

  send(message: TerminalWindowToHostMessage): void {
    this.port?.postMessage(message);
  }

  /** Asks main for a port. Resolves once main has sent one (or has none). */
  connect(): Promise<boolean> {
    this.listen();
    this.connecting ??= this.requestPort()
      .catch(() => false)
      .finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  /** Asks for a port only when there is none (a host that started again). */
  ensureConnected(): void {
    if (!this.port) void this.connect();
  }

  /** The host stopped: the port is dead until a new one arrives. */
  drop(): void {
    this.port?.close();
    this.port = undefined;
  }

  /** Stops listening for ports and closes the current one. */
  dispose(): void {
    if (this.listening) window.removeEventListener("message", this.onWindowMessage);
    this.listening = false;
    this.drop();
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("message", this.onWindowMessage);
  }

  private adopt(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    port.onmessage = (event: MessageEvent) => this.receive(event.data as TerminalHostToWindowMessage);
    port.start();
    for (const [terminalId, listener] of this.listeners) this.attach(terminalId, listener);
  }

  private attach(terminalId: string, listener: TerminalPortListener): void {
    const { cols, rows } = listener.size();
    this.send({ type: "attach", terminalId, cols, rows });
  }

  private receive(message: TerminalHostToWindowMessage): void {
    if (message.type === "exit") {
      this.listeners.delete(message.terminalId);
      this.exitHandler?.(message.terminalId);
      return;
    }
    const listener = this.listeners.get(message.terminalId);
    if (!listener) {
      // Output that reached a terminal just hidden is not written, and is
      // confirmed at once so the shell is not held back for it.
      if (message.type === "data") this.send({ type: "ack", terminalId: message.terminalId, chars: message.data.length });
      return;
    }
    if (message.type === "snapshot") listener.onSnapshot(message.serialized, message.cols, message.rows);
    else listener.onData(message.data);
  }
}

export const terminalPort = new TerminalPortClient(() => window.consensus.connectTerminals());
