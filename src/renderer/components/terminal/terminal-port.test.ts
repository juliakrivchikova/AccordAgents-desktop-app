import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { TERMINAL_PORT_WINDOW_MESSAGE, type TerminalWindowToHostMessage } from "../../../shared/terminal";
import { TerminalPortClient, type TerminalPortListener } from "./terminal-port";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await wait(5);
  }
}

/** The host's end of a port the preload hands to the page. */
function hostPort() {
  const { port1, port2 } = new MessageChannel();
  const received: TerminalWindowToHostMessage[] = [];
  let closed = false;
  port1.on("message", (message: TerminalWindowToHostMessage) => received.push(message));
  port1.on("close", () => { closed = true; });
  return { host: port1, page: port2, received, isClosed: () => closed };
}

function postToPage(port: NodeMessagePort, source: unknown = window): void {
  const event = new window.Event("message");
  Object.defineProperties(event, {
    source: { value: source },
    data: { value: { type: TERMINAL_PORT_WINDOW_MESSAGE } },
    ports: { value: [port] }
  });
  window.dispatchEvent(event);
}

function listener(cols: number, rows: number) {
  const seen: string[] = [];
  const value: TerminalPortListener = {
    size: () => ({ cols, rows }),
    onSnapshot: (serialized) => { seen.push(`snapshot:${serialized}`); },
    onData: (data) => { seen.push(`data:${data}`); }
  };
  return { value, seen };
}

test("terminals shown before the port arrives attach on it, once asked for", async () => {
  let requests = 0;
  const client = new TerminalPortClient(async () => { requests += 1; return true; });
  const a = listener(100, 30);
  const b = listener(90, 20);
  client.register("a", a.value);
  client.register("b", b.value);
  assert.equal(requests, 1, "concurrent connects share one request");
  const first = hostPort();
  postToPage(first.page);
  await waitFor(() => first.received.length === 2, "attaches");
  assert.deepEqual(first.received, [
    { type: "attach", terminalId: "a", cols: 100, rows: 30 },
    { type: "attach", terminalId: "b", cols: 90, rows: 20 }
  ]);

  // A reload or a restarted host brings a new port: everything attaches again.
  const second = hostPort();
  postToPage(second.page);
  await waitFor(() => second.received.length === 2, "attaches on the new port");
  await waitFor(() => first.isClosed(), "the old port closing");
  client.dispose();
});

test("output, snapshots and exits reach the right terminal; hidden output is confirmed at once", async () => {
  const client = new TerminalPortClient(async () => true);
  const exits: string[] = [];
  client.onExit((terminalId) => exits.push(terminalId));
  const a = listener(80, 24);
  const port = hostPort();
  client.register("a", a.value);
  postToPage(port.page);
  await waitFor(() => port.received.length === 1, "attach");
  port.host.postMessage({ type: "snapshot", terminalId: "a", serialized: "screen", cols: 80, rows: 24 });
  port.host.postMessage({ type: "data", terminalId: "a", data: "live" });
  port.host.postMessage({ type: "data", terminalId: "hidden", data: "12345" });
  port.host.postMessage({ type: "exit", terminalId: "elsewhere", exitCode: 0 });
  await waitFor(() => exits.length === 1, "exit");
  assert.deepEqual(a.seen, ["snapshot:screen", "data:live"]);
  assert.deepEqual(port.received.at(-1), { type: "ack", terminalId: "hidden", chars: 5 });
  assert.deepEqual(exits, ["elsewhere"]);
  client.dispose();
});

test("hiding a terminal detaches it; a port posted by another frame is ignored", async () => {
  const client = new TerminalPortClient(async () => true);
  const a = listener(80, 24);
  const port = hostPort();
  const hide = client.register("a", a.value);
  postToPage(port.page);
  await waitFor(() => port.received.length === 1, "attach");
  hide();
  await waitFor(() => port.received.length === 2, "detach");
  assert.deepEqual(port.received.at(-1), { type: "detach", terminalId: "a" });

  const foreign = hostPort();
  postToPage(foreign.page, {});
  client.register("b", listener(80, 24).value);
  await wait(30);
  assert.deepEqual(foreign.received, []);
  await waitFor(() => port.received.length === 3, "attach on the app's own port");
  client.dispose();
  foreign.host.close();
});
