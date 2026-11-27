import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ALERT_CALL_CONTACT_FILE_NAME, ALERT_CALL_LOGO_FILE_NAME, alertCallContactCard, type OpenAlertCallContactResult, type SaveAlertCallLogoResult } from "../../shared/alertCallContact";
import { ALERT_CALL_CONTACT_PHOTO_JPEG_BASE64 } from "../../shared/alertCallContactPhoto";
import type { HubAlertResult, UrgentAlertSettingsView } from "../../shared/urgentAlerts";

export interface AlertCallContactDependencies {
  /** Her server's alert settings, read fresh: the card carries the number
   *  calls come from now, not one the page showed earlier. */
  settings(): Promise<HubAlertResult<UrgentAlertSettingsView>>;
  /** The system's handler for the file (Contacts on macOS); an error text, or
   *  "" when it opened. */
  openPath(target: string): Promise<string>;
  /** Where the card is written (a folder of this app's own); one file,
   *  written over on every press. */
  directory: string;
}

/** Settings → Alerts → Add to contacts: the card for the number alert calls
 *  come from, written to a folder of this app and handed to the system, which
 *  shows it before anything is saved (she can cancel there). */
export async function openAlertCallContact(deps: AlertCallContactDependencies): Promise<OpenAlertCallContactResult> {
  const settings = await deps.settings().catch((error: unknown) => ({
    ok: false as const, error: { code: "server_unavailable" as const, message: error instanceof Error ? error.message : String(error) }
  }));
  if (!settings.ok) return { ok: false, message: settings.error.message };
  const card = settings.value.phone ? alertCallContactCard(settings.value.phone.from) : undefined;
  if (!card) return { ok: false, message: "Phone calls aren't set up, so there is no number to save." };
  const directory = deps.directory;
  const file = path.join(directory, ALERT_CALL_CONTACT_FILE_NAME);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, card, "utf8");
  } catch (error) {
    return { ok: false, message: `Couldn't write the contact card: ${error instanceof Error ? error.message : String(error)}` };
  }
  const failed = await deps.openPath(file);
  return failed ? { ok: false, message: `Couldn't open the contact card: ${failed}` } : { ok: true };
}

export interface AlertCallLogoDependencies {
  /** Where she wants it: the system's save dialog, starting at this path;
   *  undefined when she closed it. */
  chooseFile(defaultPath: string): Promise<string | undefined>;
  /** The contact photo, a JPEG, as a PNG. */
  toPng(jpeg: Buffer): Buffer;
  downloadsDirectory: string;
}

/** Settings → Alerts → Save logo: the contact's photo as a PNG, for a
 *  contact she saved before (she sets it as its photo herself). */
export async function saveAlertCallLogo(deps: AlertCallLogoDependencies): Promise<SaveAlertCallLogoResult> {
  const target = await deps.chooseFile(path.join(deps.downloadsDirectory, ALERT_CALL_LOGO_FILE_NAME));
  if (!target) return { ok: false, canceled: true };
  try {
    const png = deps.toPng(Buffer.from(ALERT_CALL_CONTACT_PHOTO_JPEG_BASE64, "base64"));
    // nativeImage gives an empty buffer for a picture it could not read.
    if (png.length === 0) return { ok: false, message: "Couldn't save the logo: the picture could not be made." };
    await writeFile(target, png);
  } catch (error) {
    return { ok: false, message: `Couldn't save the logo: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}
