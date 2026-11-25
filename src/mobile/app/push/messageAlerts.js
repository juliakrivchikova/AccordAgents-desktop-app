import { base64UrlToBytes } from "../base/bytes.js";
import { render } from "../chat/render.js";
import { hubClient, isHubPairing } from "../pairing/hubPairing.js";
import { loadPairing } from "../pairing/pairing.js";

export const messageAlertsState = {
  // A push subscription can go dead while still looking alive: the push
  // service keeps accepting rings for it and the phone never hears one. From
  // inside the app the only cure is to drop the subscription and ask for a new
  // one, so this is offered wherever alerts are already on.
  alertsReconnect: ""
};

// Doorbell subscription: the phone registers its Web Push subscription with
// the User's server, signed with its own key. The server's pushes carry no
// message text; iOS requires a user gesture before Notification permission,
// hence the explicit enable button.
let pushSubscriptionEnsured = false;

// The server refuses push endpoints it does not ring. That refusal must be
// said out loud: a phone that silently never rings looks identical to one
// that is simply quiet, and the user waits forever.
export let pushEndpointRejected = false;

// One subscription attempt at a time: the launch and a tap on "Enable"
// can ask together, and two attempts post two subscriptions (and undo
// each other's).
let pushSubscriptionInFlight;

/** The push subscription goes to the User's server, signed: the server
 *  rings this phone itself, desktop or no desktop. Replaced on each launch:
 *  a subscription can stop being delivered without ever being reported
 *  gone, and from in here the two cases look identical. The server's key is
 *  read before anything is given up: a phone that cannot reach the server
 *  just now keeps the subscription it has rather than trading it for a
 *  replacement it cannot make. */
async function ensureHubPushSubscription() {
  const client = hubClient();
  if (!client) return;
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  const publicKey = await client.vapidKey();
  if (subscription) {
    try {
      await subscription.unsubscribe();
      subscription = undefined;
    } catch {
      // Keeping a subscription that might be dead beats having none.
    }
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  }
  try {
    await client.registerPushSubscription(subscription.toJSON());
    pushSubscriptionEnsured = true;
  } catch (error) {
    if (error && error.status === 400) {
      // Terminal for this browser: its push service is not one the server
      // rings.
      pushEndpointRejected = true;
      pushSubscriptionEnsured = true;
      return;
    }
    throw error;
  }
}

export function ensurePushSubscription() {
  if (pushSubscriptionInFlight) return pushSubscriptionInFlight;
  pushSubscriptionInFlight = ensurePushSubscriptionNow().finally(function () {
    pushSubscriptionInFlight = undefined;
  });
  return pushSubscriptionInFlight;
}

async function ensurePushSubscriptionNow() {
  if (pushSubscriptionEnsured) {
    return;
  }
  try {
    if (!("Notification" in globalThis) || Notification.permission !== "granted") {
      return;
    }
    if (!navigator.serviceWorker || !("PushManager" in globalThis)) {
      return;
    }
    if (!isHubPairing(loadPairing())) {
      return;
    }
    await ensureHubPushSubscription();
  } catch {
    // Push is an enhancement; the app reads the server when it is open.
  }
}

export async function reconnectMessageAlerts() {
  if (!isHubPairing(loadPairing())) return "failed";
  if (!navigator.serviceWorker || !("PushManager" in globalThis)) return "failed";
  try {
    // ensurePushSubscription replaces the subscription itself, and only once
    // it has reached the server: dropping it here first left a phone that
    // tapped Reconnect without a connection with no subscription at all.
    pushSubscriptionEnsured = false;
    await ensurePushSubscription();
    return pushSubscriptionEnsured && !pushEndpointRejected ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

export async function enableMessageAlerts() {
  try {
    if (!("Notification" in globalThis)) {
      return "unsupported";
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return permission;
    }
    await ensurePushSubscription();
    await render("synced");
    return "granted";
  } catch {
    return "error";
  }
}
