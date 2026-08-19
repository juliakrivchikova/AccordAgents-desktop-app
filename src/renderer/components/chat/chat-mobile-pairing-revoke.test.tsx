import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MobilePairingDialogContent } from "./chat-mobile-pairing-dialog";
import type { MobileControlSettings } from "../../../shared/types";

// The DOM comes from scripts/renderer-jsdom-setup.mjs via `node --import`; it
// cannot be installed here, because Radix reads `globalThis.document` when it
// is first imported, which happens before this file's body runs. Running this
// file without that flag renders an empty page and reports no error, so fail
// immediately and say which script to use instead.
assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`, " +
    "which passes `--import ./scripts/renderer-jsdom-setup.mjs`"
);

const PAIRING = {
  pwaUrl: "https://mobile.example.com/?v=1#k=key",
  qrPayload: "https://mobile.example.com/?v=1#k=key",
  package: {
    stableRoutingId: "route-1",
    rendezvousId: "rv-1",
    fingerprint: "fp-1",
    purpose: "phone-control",
    expiresAt: "2026-08-17T00:00:00.000Z"
  }
};

const MOBILE_CONTROL = {
  provider: "accord-managed",
  defaults: {
    relayUrl: "wss://relay.example.com/v1/relay",
    staticOriginUrl: "https://mobile.example.com/",
    outboxUrl: "https://relay.example.com/v1/mailbox/events"
  }
} as unknown as MobileControlSettings;

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (node) => (node.textContent ?? "").trim() === text
  ) as HTMLButtonElement | undefined;
}

// Creating a pairing renders the QR code asynchronously and holds the dialog in
// its busy state until that resolves, which disables every control. Waiting for
// the named button to become clickable keeps the test off that race.
async function clickableButton(text: string): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = buttonByText(text);
    if (found && !found.disabled) {
      return found;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`"${text}" never became clickable`);
}

// W-J: revocation is terminal — the mailbox is destroyed and the same link can
// never be reactivated — so one click must not be enough to fire it.
test("the pairing dialog does not revoke until the confirmation is accepted", async () => {
  const revokeCalls: unknown[] = [];
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    createMobilePairing: async () => PAIRING,
    revokeMobilePairing: async (request: unknown) => {
      revokeCalls.push(request);
    }
  };

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      <MobilePairingDialogContent
        conversationId="conversation-1"
        mobileControl={MOBILE_CONTROL}
        open
        onOpenChange={() => undefined}
      />
    );
  });

  const create = await clickableButton("Generate");
  await act(async () => {
    create.click();
  });

  const revoke = await clickableButton("Revoke");
  await act(async () => {
    revoke.click();
  });
  assert.equal(revokeCalls.length, 0, "the first click arms the confirmation, it must not revoke");
  const armed = buttonByText("Revoke permanently");
  assert.ok(armed, "the armed control says that revoking is permanent");
  assert.match(
    document.body.textContent ?? "",
    /cannot be undone/i,
    "the armed dialog explains that revoking cannot be undone"
  );

  await act(async () => {
    armed.click();
  });
  assert.equal(revokeCalls.length, 1, "the second click revokes");

  await act(async () => {
    root.unmount();
  });
});
