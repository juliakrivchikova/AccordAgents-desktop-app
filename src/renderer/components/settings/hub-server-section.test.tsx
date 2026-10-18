import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HubServerSection } from "./hub-server-section";
import type { HubInstallRequest, HubSetupState } from "../../../shared/hubSetup";

assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`"
);

const LINE = `accord-hub-v1:${btoa(JSON.stringify({ version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip: "52.72.175.0", user: "ubuntu", nonce: "abcdefghijklmnop1234" }))}`;

function button(testId: string): HTMLButtonElement | undefined {
  return document.querySelector(`[data-testid=${testId}]`) as HTMLButtonElement | undefined;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function mount(initial: HubSetupState, install: (request: HubInstallRequest) => Promise<HubSetupState>) {
  const calls: HubInstallRequest[] = [];
  const regions: string[] = [];
  let emit: (state: HubSetupState) => void = () => undefined;
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    getHubSetupState: async () => initial,
    getHubSetupCommand: async (request: { region: string }) => { regions.push(request.region); return { command: "bash <<'ACCORDAGENTS_HUB'\nset -e\nACCORDAGENTS_HUB", region: request.region }; },
    installHub: async (request: HubInstallRequest) => { calls.push(request); return install(request); },
    onHubSetupProgress: (callback: (state: HubSetupState) => void) => { emit = callback; return () => undefined; }
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<TooltipProvider><HubServerSection /></TooltipProvider>); });
  await settle();
  return { calls, regions, emit: (state: HubSetupState) => act(async () => { emit(state); }), unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

function paste(text: string): Promise<void> {
  return act(async () => {
    const area = document.querySelector("[data-testid=hub-server-paste]") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("a server another computer set up is started over only after the User agrees", async () => {
  const view = await mount({ status: "none", bundledVersion: "1.0.0" }, async (request) => request.startOver
    ? { status: "ready", url: "https://52.72.175.0", bundledVersion: "1.0.0", server: { version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip: "52.72.175.0", user: "ubuntu", installedVersion: "1.0.0" } }
    : { status: "failed", phase: "owner", reason: "another-owner", message: "This server was set up from another computer.", bundledVersion: "1.0.0" });
  assert.equal(button("hub-server-setup")?.textContent, "Set up…");
  await act(async () => { button("hub-server-setup")!.click(); });
  await settle();
  assert.match(document.querySelector("[data-testid=hub-server-command]")?.textContent ?? "", /^bash/);
  await paste(LINE);
  assert.equal(document.querySelector("[data-testid=hub-server-destination]")?.textContent, "Installs on accordagents-hub at 52.72.175.0 (us-east-1).");
  await act(async () => { button("hub-server-install")!.click(); });
  await settle();
  assert.deepEqual(view.calls, [{ blob: LINE }]);
  assert.ok(button("hub-server-start-over"), "she is asked, not overridden");
  assert.match(document.querySelector("[data-testid=hub-server-error]")?.textContent ?? "", /another computer/);
  await act(async () => { button("hub-server-start-over")!.click(); });
  await settle();
  assert.deepEqual(view.calls.at(-1), { blob: LINE, startOver: true });
  assert.match(document.querySelector("[data-testid=hub-server-status]")?.textContent ?? "", /Running at https:\/\/52\.72\.175\.0/);
  await view.unmount();
});

test("a failed step is marked where it stopped, and a skipped copy is said so", async () => {
  const view = await mount({ status: "none", bundledVersion: "1.0.0" }, async () => ({ status: "failed", bundledVersion: "1.0.0" }));
  await act(async () => { button("hub-server-setup")!.click(); });
  await view.emit({ status: "failed", phase: "certificate", message: "too many certificates", skipped: ["chats"], bundledVersion: "1.0.0" });
  const steps = [...document.querySelectorAll("[data-testid=hub-server-progress] li")];
  const certificate = steps.find((item) => item.textContent?.includes("Certificate"));
  assert.ok(certificate?.classList.contains("is-failed"));
  assert.match(certificate?.textContent ?? "", /✕/);
  assert.match(steps.find((item) => item.textContent?.includes("Chats"))?.textContent ?? "", /already there/);
  assert.equal(button("hub-server-setup")?.textContent, "Try again…");
  await view.unmount();
});

test("a server running an older hub than this app offers the update, which needs no line", async () => {
  const server = { version: 1 as const, region: "us-east-1", instanceName: "accordagents-hub", ip: "52.72.175.0", user: "ubuntu", installedVersion: "0.9.0" };
  const view = await mount({ status: "ready", url: "https://52.72.175.0", server, bundledVersion: "1.0.0" },
    async () => ({ status: "ready", url: "https://52.72.175.0", server: { ...server, installedVersion: "1.0.0" }, bundledVersion: "1.0.0" }));
  assert.equal(button("hub-server-setup")?.textContent, "Update…");
  await act(async () => { button("hub-server-setup")!.click(); });
  await settle();
  assert.deepEqual(view.calls, [{}]);
  assert.equal(button("hub-server-setup")?.textContent, "Set up again…");
  await view.unmount();
});

test("a server this computer is not reaching is said so, and a new one is offered in the region AWS is used in", async () => {
  const server = { version: 1 as const, region: "us-east-1", instanceName: "accordagents-hub", ip: "52.72.175.0", user: "ubuntu", installedVersion: "1.0.0" };
  const down = await mount({ status: "ready", url: "https://52.72.175.0", server, reachable: false, bundledVersion: "1.0.0" }, async () => ({ status: "ready", bundledVersion: "1.0.0" }));
  assert.match(document.querySelector("[data-testid=hub-server-unreachable]")?.textContent ?? "", /not reaching the server/);
  await down.unmount();
  const fresh = await mount({ status: "none", defaultRegion: "eu-west-2", bundledVersion: "1.0.0" }, async () => ({ status: "none", bundledVersion: "1.0.0" }));
  assert.equal(document.querySelector("[data-testid=hub-server-unreachable]"), null);
  await act(async () => { button("hub-server-setup")!.click(); });
  await settle();
  assert.equal((document.querySelector("[aria-label='AWS region']") as HTMLInputElement).value, "eu-west-2");
  assert.deepEqual(fresh.regions, ["eu-west-2"]);
  await fresh.unmount();
});

test("an update that fails says so without the dialog open", async () => {
  const server = { version: 1 as const, region: "us-east-1", instanceName: "accordagents-hub", ip: "52.72.175.0", user: "ubuntu", installedVersion: "0.9.0" };
  const view = await mount({ status: "ready", url: "https://52.72.175.0", server, bundledVersion: "1.0.0" }, async () => { throw new Error("This computer does not know the server's keys."); });
  await act(async () => { button("hub-server-setup")!.click(); });
  await settle();
  assert.equal(document.querySelector("[data-testid=hub-server-dialog]"), null);
  assert.match(document.querySelector("[data-testid=hub-server]")?.textContent ?? "", /does not know the server's keys/);
  await view.unmount();
});

test("the start-over question stays with the line it was asked about", async () => {
  const other = `accord-hub-v1:${btoa(JSON.stringify({ version: 1, region: "us-east-1", instanceName: "accordagents-hub", ip: "52.72.175.1", user: "ubuntu", nonce: "abcdefghijklmnop1234" }))}`;
  const view = await mount({ status: "none", bundledVersion: "1.0.0" }, async () => ({ status: "failed", phase: "owner", reason: "another-owner", message: "This server was set up from another computer.", bundledVersion: "1.0.0" }));
  await act(async () => { button("hub-server-setup")!.click(); });
  await settle();
  await paste(LINE);
  await act(async () => { button("hub-server-install")!.click(); });
  await settle();
  assert.ok(button("hub-server-start-over"));
  await paste(other);
  assert.equal(button("hub-server-start-over"), null, "another line is installed, and asked about, on its own");
  assert.ok(button("hub-server-install"));
  await view.unmount();
});
