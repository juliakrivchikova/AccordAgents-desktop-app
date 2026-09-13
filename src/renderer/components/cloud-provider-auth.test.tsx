import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { CloudProviderAuth } from "./cloud-provider-auth";

const text = (node: ReactTestInstance): string => node.children.map(c => typeof c === "string" ? c : text(c)).join("");
const props = { authProvider: "claude-code", authRequestId: "request-1", authUrl: "https://claude.ai/oauth/authorize?state=one" };
function button(renderer: ReactTestRenderer, name: string): ReactTestInstance { return renderer.root.find(n => n.type === "button" && text(n) === name); }
async function render(bridge: Record<string, unknown> = {}) {
  (globalThis as any).window = { consensus: { isCloudRunAuthActive: async () => true, openExternal: async () => undefined,
    submitCloudRunAuthCode: async () => undefined, cancelCloudRunAuth: async () => undefined, ...bridge } };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<CloudProviderAuth {...props} />); });
  return renderer;
}

test("Claude has its own native sign-in form, sends the full code only to the active request, then clears it", async () => {
  const calls: unknown[] = [];
  const renderer = await render({ submitCloudRunAuthCode: async (request: unknown) => { calls.push(request); } });
  try {
    assert.match(text(renderer.root), /Sign in to Claude/); assert.doesNotMatch(text(renderer.root), /Codex/);
    assert.equal(button(renderer, "Complete sign-in").props.disabled, true);
    act(() => renderer.root.findByType("input").props.onChange({ currentTarget: { value: "code#one" } }));
    await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    assert.deepEqual(calls, [{ requestId: "request-1", code: "code#one" }]);
    assert.equal(renderer.root.findByType("input").props.value, "");
    assert.equal(button(renderer, "Complete sign-in").props.disabled, true);
    assert.match(text(renderer.root), /Waiting for Claude to confirm/);
  } finally { act(() => renderer.unmount()); }
});

test("a rejected code is actionable, cancellation uses the same request, a replacement clears old input", async () => {
  const cancelled: string[] = [];
  const renderer = await render({ submitCloudRunAuthCode: async () => { throw new Error("This code belongs to another sign-in."); },
    cancelCloudRunAuth: async (id: string) => { cancelled.push(id); } });
  try {
    act(() => renderer.root.findByType("input").props.onChange({ currentTarget: { value: "wrong#one" } }));
    await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    assert.match(text(renderer.root.findByProps({ role: "alert" })), /another sign-in/);
    await act(async () => { button(renderer, "Cancel sign-in").props.onClick(); });
    assert.deepEqual(cancelled, ["request-1"]); assert.equal(renderer.root.findByType("input").props.value, "");
    await act(async () => { renderer.update(<CloudProviderAuth {...props} authRequestId="request-2" />); });
    assert.equal(renderer.root.findByType("input").props.value, "");
    assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0);
  } finally { act(() => renderer.unmount()); }
});

test("an expired or interrupted challenge cannot accept a code or open an old URL", async () => {
  const renderer = await render({ isCloudRunAuthActive: async () => false });
  try {
    assert.match(text(renderer.root), /no longer active/);
    assert.equal(button(renderer, "Open Claude sign-in").props.disabled, true);
    assert.equal(renderer.root.findByType("input").props.disabled, true);
  } finally { act(() => renderer.unmount()); }
});
