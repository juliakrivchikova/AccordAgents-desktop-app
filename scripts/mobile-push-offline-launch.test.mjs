/**
 * A launch that cannot reach the User's server keeps the phone's push
 * subscription.
 *
 * Each launch replaces the subscription, because a subscription that has
 * quietly stopped being delivered looks exactly like a working one from the
 * phone. The replacement used to begin by giving the old one up; when the
 * server could not be reached right then (opened offline, on a poor
 * connection) the phone was left with no subscription at all until the next
 * launch, and the notifications this was meant to keep were the ones lost.
 *
 * The phone is paired with a real hub (the User's own server); its key is
 * made unreachable at the hub's door. The push service is the browser's, so
 * the browser boundary is stood in for; everything the phone does with it is
 * the shipped code. Not the installed phone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { attachApp, launchChrome, member, pairPage, serveMobileShell, startMobileHub, tempProfile } from "./mobile-hub-fixture.mjs";

const SITE_PORT = 8281;
const CDP_PORT = 9431;
const CONVERSATION = "conv-push-offline";
// Push endpoints the server rings; anything else it refuses for good.
const PUSH_BASE = "https://fcm.googleapis.com/fcm/send/";

test("a launch that cannot reach the server keeps the subscription it has", { timeout: 120_000 }, async (t) => {
  const hub = await startMobileHub();
  const site = await serveMobileShell({ port: SITE_PORT, hubOrigins: [hub.base] });
  const profile = await tempProfile("aa-mobile-push-offline-");
  const chrome = launchChrome({ port: CDP_PORT, profile, url: `${site.origin}/` });
  let app;
  // Whether the server can be reached for its key right now.
  const server = { reachable: false };
  hub.setGate(async (request) => request.path === "/v1/push/vapid" && !server.reachable ? { status: 503, body: { ok: false } } : undefined);
  const subscriptionPosts = () => hub.requests.filter((request) => request.method === "POST" && request.path === "/v1/push-subscription").length;
  const registered = async () => (await hub.storage.hub().pushSubscriptions()).map((item) => item.endpoint);
  try {
    await hub.createChat(CONVERSATION, { title: "Push QA", participants: [member("drew")] });
    app = await attachApp({ port: CDP_PORT });
    const evaluate = app.evaluate;
    await pairPage(app, { hub, siteOrigin: site.origin });
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    // The browser boundary: a subscription this phone holds, and the push
    // service that would hand out a new one.
    await evaluate(`(async () => {
      const registration = await navigator.serviceWorker.ready;
      window.__unsubscribed = 0;
      window.__subscribed = 0;
      const held = {
        unsubscribe: async () => { window.__unsubscribed += 1; return true; },
        toJSON: () => ({ endpoint: ${JSON.stringify(PUSH_BASE + "held")}, keys: { p256dh: "held-p256dh", auth: "held-auth" } })
      };
      registration.pushManager.getSubscription = async () => held;
      registration.pushManager.subscribe = async () => {
        window.__subscribed += 1;
        return { unsubscribe: async () => true, toJSON: () => ({ endpoint: ${JSON.stringify(PUSH_BASE + "new-")} + window.__subscribed, keys: { p256dh: "new-p256dh", auth: "new-auth" } }) };
      };
      return true;
    })()`);
    // Granted on the session that stays attached: a grant made on an earlier
    // one went with it. The page reads it once it has asked, through the same
    // call its own button makes.
    await app.send("Browser.grantPermissions", { origin: site.origin, permissions: ["notifications"] });
    assert.equal(await evaluate("Notification.requestPermission()"), "granted", "alerts are allowed for this origin");

    // Offline for the server's key: nothing is given up, nothing is posted.
    server.reachable = false;
    await evaluate(`AccordAgentsMobile.ensurePushSubscription()`);
    assert.equal(await evaluate("window.__unsubscribed"), 0, "the subscription in hand is kept when no replacement can be made");
    assert.equal(await evaluate("window.__subscribed"), 0, "and no replacement was attempted");
    assert.equal(subscriptionPosts(), 0, "nothing reached the server");

    // Reachable again: the replacement goes ahead and is registered.
    server.reachable = true;
    await evaluate(`AccordAgentsMobile.ensurePushSubscription()`);
    assert.equal(await evaluate("window.__unsubscribed"), 1, "the old subscription is given up once a replacement can be made");
    assert.equal(await evaluate("window.__subscribed"), 1, "and the replacement is made");
    assert.equal(subscriptionPosts(), 1, "and registered with the server");
    assert.deepEqual(await registered(), [PUSH_BASE + "new-1"], "the registered one is the new subscription");

    // Settings → Reconnect, tapped where the server cannot be reached: it used
    // to give the subscription up first and leave the phone with none.
    server.reachable = false;
    assert.equal(await evaluate(`AccordAgentsMobile.reconnectMessageAlerts()`), "failed", "Reconnect says it could not reconnect");
    assert.equal(await evaluate("window.__unsubscribed"), 1, "Reconnect offline keeps the subscription in hand");
    assert.equal(subscriptionPosts(), 1, "and posts nothing");
    server.reachable = true;
    assert.equal(await evaluate(`AccordAgentsMobile.reconnectMessageAlerts()`), "ok", "Reconnect with the server reachable succeeds");
    assert.equal(await evaluate("window.__unsubscribed"), 2, "and replaces the subscription");
    assert.equal(subscriptionPosts(), 2, "and registers the new one");
    assert.ok((await registered()).includes(PUSH_BASE + "new-2"), "the server rings the new one");
    t.diagnostic(`posts: ${subscriptionPosts()}`);
  } finally {
    app?.close();
    chrome.kill("SIGKILL");
    await site.close();
    await hub.close();
    await rm(profile, { recursive: true, force: true });
  }
});
