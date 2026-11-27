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
// quietly, and is not asked again until the app starts again.

export const alertCallContactState = {
  /** The number calls come from; undefined while not known or not set up. */
  from: undefined,
  /** When it was last asked for, so opening Settings asks at most once a minute. */
  askedAt: 0,
  /** Her server refused the read (older than this app): not asked again
   *  until the app starts again. */
  refused: false,
  /** What the last press could not do. */
  error: undefined,
  /** The logo as a PNG, made before any tap: iOS shows the share sheet only
   *  when it is asked for straight from the tap. */
  logoFile: undefined
};

const ASK_AGAIN_MS = 60_000;

/** Asks her server for the number once Settings opens (not in a loop). */
export async function refreshAlertCallFrom() {
  if (!isHubPairing(loadPairing()) || alertCallContactState.refused) return;
  if (Date.now() - alertCallContactState.askedAt < ASK_AGAIN_MS) return;
  const shared = mobileSharedRules();
  const client = hubClient();
  if (!shared || !client) return;
  alertCallContactState.askedAt = Date.now();
  const answer = await client.postJson(shared.HUB_ALERTS_PATH, { action: "phone.call-from" }).catch(function () { return undefined; });
  // No answer (offline, the server restarting): what was known stays.
  if (!answer) return;
  // A server older than this app answers access_denied: no row, not asked
  // again. Any other refusal is asked again next time Settings opens.
  if (answer.ok === false) {
    if (answer.error && answer.error.code === "access_denied") alertCallContactState.refused = true;
    return;
  }
  const from = answer.ok === true && answer.value && typeof answer.value.from === "string" ? answer.value.from : undefined;
  if (from) void prepareLogo();
  if (from === alertCallContactState.from) return;
  alertCallContactState.from = from;
  redraw();
}

function redraw() {
  settingsViewState.lastSettingsRenderSignature = "";
  void render();
}

async function logoPng(shared) {
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
  return new File([png], shared.ALERT_CALL_LOGO_FILE_NAME, { type: "image/png" });
}

async function prepareLogo() {
  const shared = mobileSharedRules();
  if (!shared || alertCallContactState.logoFile) return;
  alertCallContactState.logoFile = await logoPng(shared).catch(function () { return undefined; });
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
  redraw();
}

/** A press starts afresh: an earlier failure's line goes. */
function clearError() {
  if (alertCallContactState.error === undefined) return;
  alertCallContactState.error = undefined;
  redraw();
}

/** The card as a text/vcard download: iOS opens it as a contact (Create New
 *  Contact, Add to Existing Contact); Android imports it. */
export function addAlertCallContact() {
  const shared = mobileSharedRules();
  const card = shared && alertCallContactState.from ? shared.alertCallContactCard(alertCallContactState.from) : undefined;
  if (!card) return failed("There is no number to save yet.");
  clearError();
  handOver(new Blob([card], { type: shared.ALERT_CALL_CONTACT_MIME }), shared.ALERT_CALL_CONTACT_FILE_NAME);
}

/** The contact's photo as a PNG: through the share sheet where the phone has
 *  one for files (iOS offers Save Image there), else as a download. The
 *  share is asked for first thing in the tap, with the PNG made beforehand. */
export async function saveAlertCallLogo() {
  const shared = mobileSharedRules();
  if (!shared) return failed("The logo is not available in this app version.");
  clearError();
  const ready = alertCallContactState.logoFile;
  try {
    if (ready && navigator.canShare && navigator.canShare({ files: [ready] })) {
      try {
        await navigator.share({ files: [ready] });
        return;
      } catch (error) {
        // Closing the share sheet is not a failure; a sheet the phone would
        // not show (NotAllowedError) falls back to the download.
        if (error && error.name === "AbortError") return;
        if (!error || error.name !== "NotAllowedError") throw error;
      }
    }
    const file = ready || await logoPng(shared);
    handOver(file, shared.ALERT_CALL_LOGO_FILE_NAME);
  } catch (error) {
    failed("Couldn't save the logo: " + (error && error.message ? error.message : String(error)));
  }
}
