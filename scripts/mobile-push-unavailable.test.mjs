// W-K: when the User's server refuses this browser's push endpoint (it rings
// only the push services it knows), the phone must say so.
//
// A phone that silently never rings is indistinguishable from one that is
// simply quiet, so the user waits for an alert that will never come. This
// harness has a real hub (the User's own server) refuse the subscription and
// asserts the phone lands in a stated-unavailable state, does not crash, and
// does not retry forever.
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, openChat, pairPage, serveMobileShell, sleep, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8161;
const CDP_PORT = 9343;
const CONVERSATION = "conv-push-qa";

test("a refused push subscription is stated, not silent, and is not retried", { timeout: 120_000 }, async () => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-push-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/`, width: 430, height: 860 });
  let app;
  try {
    await hub.createChat(CONVERSATION, { title: "Push QA", participants: [member("drew")] });
    app = await attachApp({ port: CDP_PORT });
    const evaluate = app.evaluate;
    await app.send("Browser.grantPermissions", {
      origin: site.origin,
      permissions: ["notifications"]
    });
    // Headless Chrome has no push service, so subscribe() cannot produce a real
    // subscription. Stand one in at the browser boundary only, before the app
    // runs — everything the phone does with it, and with the server's answer,
    // is the shipped code.
    await app.send("Page.enable");
    await app.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      PushManager.prototype.getSubscription = async function () {
        return {
          toJSON: () => ({
            endpoint: "https://attacker.test/collect",
            keys: { p256dh: "fake-p256dh", auth: "fake-auth" }
          })
        };
      };
      PushManager.prototype.subscribe = async function () { throw new Error("no push service in this browser"); };
    ` });
    const subscriptionPosts = () => hub.requests.filter((request) => request.method === "POST" && request.path === "/v1/push-subscription").length;
    await pairPage(app, { hub, siteOrigin: site.origin });
    await openChat(app, CONVERSATION);
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    // Permission is already granted, so the launch itself subscribes; the tap
    // on Enable comes to the same place.
    const first = await evaluate(`AccordAgentsMobile.enableMessageAlerts()`);
    assert.equal(first, "granted", "permission is granted, so the phone proceeds to subscribe");
    assert.equal(subscriptionPosts(), 1, "the phone posted its subscription once");
    const state = await evaluate(`(() => {
      const button = document.getElementById("enable-alerts");
      return JSON.stringify({
        state: button?.dataset.alertsState ?? "",
        hidden: button?.hidden ?? null,
        text: (button?.textContent || "").trim()
      });
    })()`);
    const banner = JSON.parse(state);
    assert.equal(banner.state, "unavailable", `phone must state the refusal, got ${state}`);
    assert.equal(banner.hidden, false, "the statement must be visible, not hidden like the quiet-wait state");
    assert.match(banner.text, /aren't available/i, "the statement names what will not happen");
    // No retry loop: the endpoint will not become allowed by asking again.
    await evaluate(`AccordAgentsMobile.enableMessageAlerts()`);
    await evaluate(`AccordAgentsMobile.ensurePushSubscription()`);
    await sleep(3000);
    assert.equal(subscriptionPosts(), 1, "the refusal is terminal — no further attempts");
    // And the app is still alive and syncing after the refusal.
    const alive = await evaluate(`(() => Boolean(document.getElementById("message-list")))()`);
    assert.equal(alive, true, "the refusal must not take the app down");
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
