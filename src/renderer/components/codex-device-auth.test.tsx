import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { CodexDeviceAuth } from "./codex-device-auth";

const URL = "https://auth.openai.com/codex/device";
const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === "string" ? child : text(child)).join("");

async function render(write: (value: string) => Promise<void>, code?: string): Promise<ReactTestRenderer> {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: write } } });
  (globalThis as any).window = { consensus: { openExternal: async () => undefined } };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<CodexDeviceAuth authUrl={URL} authCode={code} />); });
  return renderer;
}

test("sign-in shows the exact code, copies only that code and opens its verification URL", async () => {
  const copies: string[] = [];
  const renderer = await render(async value => { copies.push(value); }, "ABCD-12345");
  let opened: string | undefined;
  (globalThis as any).window.consensus.openExternal = async (value: string) => { opened = value; };
  assert.equal(text(renderer.root.findByProps({ "data-testid": "cloud-run-device-auth-code" })), "ABCD-12345");
  assert.match(text(renderer.root), /Sign in to Codex.*Copy this one-time code/);
  await act(async () => { renderer.root.findByProps({ "aria-label": "Copy sign-in code" }).props.onClick(); });
  assert.deepEqual(copies, ["ABCD-12345"]);
  assert.equal(text(renderer.root.findByProps({ role: "status" })), "Copied");
  await act(async () => { renderer.root.find(node => node.type === "button" && text(node) === "Open Codex sign-in").props.onClick(); });
  assert.equal(opened, URL);
  act(() => renderer.unmount());
});

test("a clipboard failure is actionable and a successful retry clears it", async () => {
  let failed = true;
  const renderer = await render(async () => { if (failed) throw new Error("clipboard denied"); }, "ABCD-12345");
  await act(async () => { renderer.root.findByProps({ "aria-label": "Copy sign-in code" }).props.onClick(); });
  assert.match(text(renderer.root.findByProps({ role: "alert" })), /Select the code and copy it manually/);
  assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 0);
  failed = false;
  await act(async () => { renderer.root.findByProps({ "aria-label": "Copy sign-in code" }).props.onClick(); });
  assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0);
  assert.equal(text(renderer.root.findByProps({ role: "status" })), "Copied");
  act(() => renderer.unmount());
});

test("a new challenge cannot inherit a delayed copy result from the old code", async () => {
  let finish!: () => void;
  const renderer = await render(() => new Promise(resolve => { finish = resolve; }), "OLD1-CODE1");
  await act(async () => { renderer.root.findByProps({ "aria-label": "Copy sign-in code" }).props.onClick(); });
  assert.equal(renderer.root.findByProps({ "aria-label": "Copy sign-in code" }).props.disabled, true);
  await act(async () => { renderer.update(<CodexDeviceAuth authUrl={URL} authCode="NEW2-CODE2" />); });
  await act(async () => { finish(); });
  assert.equal(renderer.root.findAllByProps({ role: "status" }).length, 0);
  assert.equal(text(renderer.root.findByProps({ "data-testid": "cloud-run-device-auth-code" })), "NEW2-CODE2");
  assert.equal(renderer.root.findByProps({ "aria-label": "Copy sign-in code" }).props.disabled, false);
  act(() => renderer.unmount());
});

test("an incomplete challenge offers no empty copy and reports browser opening failure", async () => {
  const renderer = await render(async () => { throw new Error("must not copy"); });
  assert.match(text(renderer.root), /Waiting for a one-time code/);
  assert.equal(renderer.root.findAllByProps({ "aria-label": "Copy sign-in code" }).length, 0);
  (globalThis as any).window.consensus.openExternal = async () => { throw new Error("browser unavailable"); };
  await act(async () => { renderer.root.findByType("button").props.onClick(); });
  assert.match(text(renderer.root.findByProps({ role: "alert" })), /Could not open the sign-in page/);
  act(() => renderer.unmount());
});
