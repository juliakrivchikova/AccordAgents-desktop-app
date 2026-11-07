import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { AgentHealth, AppSettings, CliSignInState } from "../../../shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CliReadinessSetupPanel } from "./cli-readiness-setup-panel";

// The panel reads only the providers from settings.
const SETTINGS = {
  providers: [
    { kind: "gemini-cli", label: "Antigravity", enabled: true },
    { kind: "claude-code", label: "Claude Code", enabled: true },
    { kind: "codex-cli", label: "Codex", enabled: true }
  ]
} as AppSettings;

test("a signed-out Claude card starts the CLI's own sign-in, follows it, and Cancel ends that one", async () => {
  const bridge = installBridge();
  const panel = await mount(["claude-code"]);
  const card = () => cardOf(panel, "claude-code");
  assert.match(textOf(card()), /Sign in with your browser.*Or in Terminal:.*claude auth login/, "the Terminal command stays as a fallback");
  await click(button(card(), "Sign in"));
  assert.deepEqual(bridge.started, ["claude-code"]);

  await bridge.emit({ kind: "claude-code", requestId: "r1", status: "waiting", revision: 2 });
  assert.match(textOf(card()), /Finish signing in with your browser\./);
  assert.equal(textOf(card()).includes("Browser didn't open?"), false, "no fallback link before the CLI printed its page");
  await bridge.emit({ kind: "claude-code", requestId: "r1", status: "starting", revision: 1 });
  assert.match(textOf(card()), /Finish signing in/, "an older update does not win");

  await click(button(card(), "Cancel"));
  assert.deepEqual(bridge.cancelled, ["r1"]);
  assert.match(textOf(card()), /Cancelling sign-in/);
  await bridge.emit({ kind: "claude-code", requestId: "r1", status: "cancelled", revision: 3 });
  assert.ok(button(card(), "Sign in"));
  panel.unmount();
});

test("Claude's fallback page opens from the card and its code is passed back; Codex's page asks for no code", async () => {
  const bridge = installBridge();
  const panel = await mount(["claude-code", "codex-cli"]);
  const claude = () => cardOf(panel, "claude-code");
  await bridge.emit({ kind: "claude-code", requestId: "c1", status: "waiting", revision: 4, pageUrl: "https://claude.com/cai/oauth/authorize?state=S", pageGivesCode: true });
  assert.equal(claude().findAll((node) => node.type === "input").length, 0, "the code field waits until the fallback page is opened");
  await click(button(claude(), "Open the sign-in page"));
  assert.deepEqual(bridge.opened, ["https://claude.com/cai/oauth/authorize?state=S"]);
  await act(async () => { claude().find((node) => node.type === "input").props.onChange({ currentTarget: { value: "abc#S" } }); });
  await act(async () => {
    claude().find((node) => node.type === "form").props.onSubmit({ preventDefault: () => undefined });
    await settle();
  });
  assert.deepEqual(bridge.codes, [{ requestId: "c1", code: "abc#S" }]);
  assert.match(textOf(claude()), /Closed the page\? Open it again/, "the page stays reachable while the code is pasted");

  bridge.refuseCode = "Error invoking remote method 'cli-sign-in:submit-code': Error: This code belongs to another sign-in. Use the page opened from here.";
  await act(async () => { claude().find((node) => node.type === "input").props.onChange({ currentTarget: { value: "abc#T" } }); });
  await act(async () => {
    claude().find((node) => node.type === "form").props.onSubmit({ preventDefault: () => undefined });
    await settle();
  });
  assert.match(textOf(claude()), /^(?!.*invoking remote method).*This code belongs to another sign-in\./s, "the refusal is shown in plain words");

  await click(button(claude(), "Hide Claude Code"));
  await click(button(cardOf(panel, "codex-cli"), "Set up Codex"));
  await bridge.emit({ kind: "codex-cli", requestId: "x1", status: "waiting", revision: 5, pageUrl: "https://auth.openai.com/oauth/authorize?state=x", pageGivesCode: false });
  await click(button(cardOf(panel, "codex-cli"), "Open the sign-in page"));
  assert.equal(cardOf(panel, "codex-cli").findAll((node) => node.type === "input").length, 0);
  assert.match(textOf(cardOf(panel, "codex-cli")), /Browser didn't open\?/);
  panel.unmount();
});

test("a finished sign-in checks readiness again; a failed one says why and offers another try", async () => {
  const bridge = installBridge();
  let refreshes = 0;
  let finishRefresh!: () => void;
  const panel = await mount(["codex-cli"], () => {
    refreshes += 1;
    return new Promise<void>((resolve) => { finishRefresh = resolve; });
  });
  const card = () => cardOf(panel, "codex-cli");
  await bridge.emit({ kind: "codex-cli", requestId: "f1", status: "failed", revision: 2, message: "Port 127.0.0.1:1455 is already in use" });
  assert.match(textOf(card()), /Port 127\.0\.0\.1:1455 is already in use/);
  assert.ok(button(card(), "Sign in again"));
  assert.equal(refreshes, 0);
  await bridge.emit({ kind: "codex-cli", requestId: "f2", status: "succeeded", revision: 3 });
  assert.equal(refreshes, 1);
  assert.match(textOf(card()), /Signed in\. Checking Codex/);
  assert.equal(button(card(), "Sign in").props.disabled, true, "no second sign-in while the first one is being confirmed");
  await act(async () => { finishRefresh(); await settle(); });
  assert.doesNotMatch(textOf(card()), /Signed in\. Checking/, "the note ends with the check it belongs to");
  panel.unmount();
});

test("a sign-in already running when the panel opens is shown, not started again", async () => {
  const bridge = installBridge([
    { kind: "claude-code", requestId: "early", status: "waiting", revision: 7 },
    { kind: "codex-cli", requestId: "failed-before", status: "failed", revision: 3, message: "an old failure" }
  ]);
  let refreshes = 0;
  const panel = await mount(["claude-code", "codex-cli"], () => { refreshes += 1; });
  assert.match(textOf(cardOf(panel, "claude-code")), /Finish signing in/);
  assert.deepEqual(bridge.started, []);
  await click(button(cardOf(panel, "claude-code"), "Hide Claude Code"));
  await click(button(cardOf(panel, "codex-cli"), "Set up Codex"));
  assert.doesNotMatch(textOf(cardOf(panel, "codex-cli")), /an old failure/, "a result from before the panel opened is not shown again");
  assert.ok(button(cardOf(panel, "codex-cli"), "Sign in"));
  assert.equal(refreshes, 0);
  panel.unmount();
});

test("Antigravity has no sign-in command, so its card offers no Sign in button", async () => {
  installBridge();
  const panel = await mount(["gemini-cli"]);
  const card = cardOf(panel, "gemini-cli");
  assert.match(textOf(card), /Sign in from Terminal/);
  assert.equal(card.findAll((node) => node.type === "button" && textOf(node).trim() === "Sign in").length, 0);
  panel.unmount();
});

/** Mounts the panel with the given providers installed and signed out. */
async function mount(signedOut: AgentHealth["kind"][], onRefresh: () => void | Promise<void> = () => undefined): Promise<ReactTestRenderer> {
  const agents: AgentHealth[] = (["gemini-cli", "claude-code", "codex-cli"] as const).map((kind) => signedOut.includes(kind)
    ? { kind, label: kind, installed: true, detection: "detected", runnable: "ready", authentication: "required", platform: "darwin" }
    : { kind, label: kind, installed: false, detection: "not-detected", runnable: "unknown", authentication: "unknown", platform: "darwin" });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <TooltipProvider>
        <CliReadinessSetupPanel
          agents={agents}
          settings={SETTINGS}
          checking={false}
          onRefresh={async () => { await onRefresh(); return agents; }}
          onOpenSettings={() => undefined}
        />
      </TooltipProvider>
    );
    await settle();
  });
  return renderer;
}

function installBridge(initial: CliSignInState[] = []) {
  const listeners = new Set<(state: CliSignInState) => void>();
  const bridge = {
    started: [] as string[],
    cancelled: [] as string[],
    opened: [] as string[],
    codes: [] as Array<{ requestId: string; code: string }>,
    refuseCode: undefined as string | undefined,
    async emit(state: CliSignInState): Promise<void> {
      assert.ok(listeners.size > 0, "the panel listens for sign-in updates");
      await act(async () => {
        listeners.forEach((listener) => listener(state));
        await settle();
      });
    }
  };
  (globalThis as any).window = {
    consensus: {
      openTerminal: async () => undefined,
      openExternal: async (url: string) => { bridge.opened.push(url); },
      startCliSignIn: async (kind: string) => {
        bridge.started.push(kind);
        return { kind, requestId: "started", status: "starting", revision: 1 };
      },
      listCliSignIns: async () => initial,
      cancelCliSignIn: async (requestId: string) => { bridge.cancelled.push(requestId); },
      submitCliSignInCode: async (request: { requestId: string; code: string }) => {
        if (bridge.refuseCode) throw new Error(bridge.refuseCode);
        bridge.codes.push(request);
      },
      onCliSignInUpdated: (listener: (state: CliSignInState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    setTimeout,
    clearTimeout
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => undefined } } });
  return bridge;
}

function cardOf(renderer: ReactTestRenderer, kind: AgentHealth["kind"]): ReactTestInstance {
  return renderer.root.findByProps({ "data-provider-kind": kind });
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((node) => node.type === "button" && (textOf(node).trim() === label || node.props["aria-label"] === label));
}

async function click(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    await node.props.onClick();
    await settle();
  });
}

function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map((child) => textOf(child as ReactTestInstance | string)).join("");
}
