import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { UrgentAlertSettingsView } from "../../../shared/urgentAlerts";
import { TelegramConnectDialog } from "./alerts-connect-dialogs";
import { PhoneConnectDialog } from "./alerts-phone-dialog";

// The DOM comes from scripts/renderer-jsdom-setup.mjs via `node --import`
// (Radix reads `document` when it is first imported).
assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`"
);

const KYC = "Twilio: Primary compliance profile is not approved. Please refer to documentation and complete the KYC process in Trust Hub to gain access.";

function dialogButtons(): string[] {
  const dialog = document.querySelector("[data-slot='dialog-content']");
  return [...(dialog?.querySelectorAll("[data-slot='dialog-footer'] button") ?? [])].map((node) => (node.textContent ?? "").trim());
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((node) => (node.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  assert.ok(found, `a "${text}" button (have: ${dialogButtons().join(", ")})`);
  return found;
}

function currentStep(): string {
  return (document.querySelector(".alerts-wizard-step.is-now")?.textContent ?? "").replace(/^\d/, "");
}

async function click(text: string): Promise<void> {
  await act(async () => {
    button(text).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(selector: string, value: string): Promise<void> {
  const input = document.querySelector(selector) as HTMLInputElement | null;
  assert.ok(input, selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("the phone wizard shows one step at a time, with the step's own action where Next would be", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let buys = 0;
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    openExternal: async () => undefined,
    urgentAlertRequest: async (request: Record<string, unknown>) => {
      requests.push(request);
      if (request.action === "phone.check") return { ok: true, value: { accountName: "My first account", trial: true, numbers: [], verified: ["+35799123342"] } };
      if (request.action === "phone.buy") {
        buys += 1;
        return buys === 1 ? { ok: false, error: { code: "channel_failed", message: KYC } } : { ok: true, value: { number: "+14155550201" } };
      }
      if (request.action === "phone.try") return { ok: true, value: { testId: "t1", test: { state: "pressed", at: new Date().toISOString() } } };
      if (request.action === "phone.save") return { ok: true, value: { waitMinutes: 5, callMode: "keypad" } };
      return { ok: false, error: { code: "invalid_request", message: `unexpected ${String(request.action)}` } };
    }
  };
  let closed = 0;
  let savedSettings: UrgentAlertSettingsView | undefined;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<PhoneConnectDialog open settings={{ waitMinutes: 5, callMode: "keypad" }} onSettings={(value) => { savedSettings = value; }} onClose={() => { closed += 1; }} />);
  });

  // 1 · the keys: Next only once both are in.
  assert.equal(currentStep(), "Twilio account");
  assert.deepEqual(dialogButtons(), ["Next"]);
  assert.equal(button("Next").disabled, true);
  await type("[data-testid='alerts-phone-sid']", `AC${"1".repeat(32)}`);
  await type("[data-testid='alerts-phone-token']", "a".repeat(32));
  await click("Next");

  // 2 · no number yet: buying is the step's action, there is no Next.
  assert.equal(currentStep(), "Call from");
  assert.deepEqual(dialogButtons(), ["Back", "Buy a US number · $1.15 / month"]);
  await click("Buy a US number · $1.15 / month");
  // Twilio has not confirmed who she is: said in plain words, with the way there.
  assert.ok(document.querySelector("[data-testid='alerts-phone-identity']"), "the identity notice");
  assert.doesNotMatch(document.body.textContent ?? "", /Primary compliance profile is not approved/, "not Twilio's own sentence");
  assert.deepEqual(dialogButtons(), ["Back", "Close", "Open Trust Hub"]);
  await click("Back");
  assert.equal(currentStep(), "Twilio account");
  await click("Next");
  await click("Buy a US number · $1.15 / month");
  assert.match(document.body.textContent ?? "", /\+14155550201bought just now/);
  assert.deepEqual(dialogButtons(), ["Back", "Buy another · $1.15 / month", "Next"]);
  await click("Next");

  // 3 · her phone, checked against the trial's verified numbers.
  assert.equal(currentStep(), "Your phone");
  await type("[data-testid='alerts-phone-to']", "+357 99 123342");
  assert.match(document.body.textContent ?? "", /Verified in Twilio/);
  await click("Next");

  // 4 · the call is the main action until it worked; then Save is.
  assert.equal(currentStep(), "Test call");
  assert.deepEqual(dialogButtons(), ["Back", "Save without a test", "Call me now"]);
  await click("Call me now");
  assert.match(document.body.textContent ?? "", /You pressed 1 at .*\. Calls work\./);
  assert.deepEqual(dialogButtons(), ["Back", "Call again", "Save"]);
  await click("Save");
  const save = requests.find((request) => request.action === "phone.save");
  assert.equal(save?.testId, "t1", "the test call's result goes with the phone");
  assert.equal(save?.from, "+14155550201");
  assert.ok(savedSettings, "the page gets the saved settings");
  assert.equal(closed, 1);
  await act(async () => root.unmount());
  host.remove();
});

test("the Telegram wizard follows the server: token, Start, Got it, connected", async () => {
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    openExternal: async () => undefined,
    urgentAlertRequest: async () => ({ ok: false, error: { code: "server_unavailable", message: "no server in this test" } })
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = async (settings: UrgentAlertSettingsView) => {
    await act(async () => {
      root.render(<TooltipProvider><TelegramConnectDialog open settings={settings} onSettings={() => undefined} onClose={() => undefined} /></TooltipProvider>);
    });
  };
  const base: UrgentAlertSettingsView = { waitMinutes: 5, callMode: "keypad" };
  await show(base);
  assert.equal(currentStep(), "Your bot");
  assert.deepEqual(dialogButtons(), ["Next"]);

  await show({ ...base, telegram: { botUsername: "svetlana_accord_bot", connected: false, step: "start", startCode: "code" } });
  assert.equal(currentStep(), "Start");
  assert.deepEqual(dialogButtons(), ["Back", "Finish later", "Open @svetlana_accord_bot"]);

  await show({ ...base, telegram: { botUsername: "svetlana_accord_bot", connected: false, step: "test", chatName: "Svetlana" } });
  assert.equal(currentStep(), "Got it");
  assert.deepEqual(dialogButtons(), ["Back", "Finish later"]);
  // Back shows the Start screen again (to open the bot), the server still waits.
  await click("Back");
  assert.equal(currentStep(), "Start");
  assert.match(document.body.textContent ?? "", /Start received/);

  await show({ ...base, telegram: { botUsername: "svetlana_accord_bot", connected: true, chatName: "Svetlana" } });
  assert.equal(document.querySelector(".alerts-wizard-step.is-now"), null, "every step done");
  assert.match(document.body.textContent ?? "", /Connected to Svetlana/);
  assert.deepEqual(dialogButtons(), ["Done"]);
  await act(async () => root.unmount());
  host.remove();
});
