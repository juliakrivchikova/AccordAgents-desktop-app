import { render } from "../chat/render.js";
import { mobileSharedRules } from "../members/avatars.js";
import { hubClient, isHubPairing } from "../pairing/hubPairing.js";
import { loadPairing } from "../pairing/pairing.js";
import { settingsViewState } from "./settingsView.js";

// Settings → Notifications → Alert calls: a contact card for the number her
// urgent-alert calls come from, so the call rings as AccordAgents with its
// logo, and the logo alone for a contact she saved before (Mia's brief,
// approved by the User, 2026-11-27). The number is read from her server;
// a server older than this app refuses the read and the row stays away,
// quietly and without asking again until Settings is opened again.

export const alertCallContactState = {
  /** The number calls come from; undefined while not known or not set up. */
  from: undefined,
  /** When it was last asked for, so opening Settings asks at most once a minute. */
  askedAt: 0,
  /** Her server refused the read (older than this app): not asked again
   *  until the app starts again. */
  refused: false,
  /** What the last press could not do. */
  error: undefined
};

const ASK_AGAIN_MS = 60_000;

/** Asks her server for the number once Settings opens (not in a loop). */
export async function refreshAlertCallFrom() {
  if (!isHubPairing(loadPairing()) || alertCallContactState.refused) return;
  if (Date.now() - alertCallContactState.askedAt < ASK_AGAIN_MS) return;
  alertCallContactState.askedAt = Date.now();
  const shared = mobileSharedRules();
  const client = hubClient();
  if (!shared || !client) return;
  const answer = await client.postJson(shared.HUB_ALERTS_PATH, { action: "phone.call-from" }).catch(function () { return undefined; });
  // A refusal (an older server), no answer or no number: no row.
  if (answer && answer.ok === false) alertCallContactState.refused = true;
  const from = answer && answer.ok === true && answer.value && typeof answer.value.from === "string" ? answer.value.from : undefined;
  if (from === alertCallContactState.from) return;
  alertCallContactState.from = from;
  settingsViewState.lastSettingsRenderSignature = "";
  await render();
}

function handOver(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 60_000);
}

function failed(message) {
  alertCallContactState.error = message;
  settingsViewState.lastSettingsRenderSignature = "";
  void render();
}

/** The card as a text/vcard download: iOS opens it as a contact (Create New
 *  Contact, Add to Existing Contact); Android imports it. */
export function addAlertCallContact() {
  const shared = mobileSharedRules();
  const card = shared && alertCallContactState.from ? shared.alertCallContactCard(alertCallContactState.from) : undefined;
  if (!card) return failed("There is no number to save yet.");
  alertCallContactState.error = undefined;
  handOver(new Blob([card], { type: shared.ALERT_CALL_CONTACT_MIME }), shared.ALERT_CALL_CONTACT_FILE_NAME);
}

/** The contact's photo as a PNG: through the share sheet where the phone has
 *  one for files (iOS offers Save Image there), else as a download. */
export async function saveAlertCallLogo() {
  const shared = mobileSharedRules();
  if (!shared) return failed("The logo is not available in this app version.");
  alertCallContactState.error = undefined;
  try {
    const image = new Image();
    image.src = "data:image/jpeg;base64," + shared.ALERT_CALL_CONTACT_PHOTO_JPEG_BASE64;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const png = await new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error("the picture could not be made")); }, "image/png");
    });
    const file = new File([png], shared.ALERT_CALL_LOGO_FILE_NAME, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] }).catch(function (error) {
        // Closing the share sheet is not a failure.
        if (!error || error.name !== "AbortError") throw error;
      });
    } else {
      handOver(file, shared.ALERT_CALL_LOGO_FILE_NAME);
    }
  } catch (error) {
    failed("Couldn't save the logo: " + (error && error.message ? error.message : String(error)));
  }
}
