import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ALERT_CALL_CONTACT_FILE_NAME, alertCallContactCard, type OpenAlertCallContactResult } from "../../shared/alertCallContact";
import type { HubAlertResult, UrgentAlertSettingsView } from "../../shared/urgentAlerts";

export interface AlertCallContactDependencies {
  /** Her server's alert settings, read fresh: the card carries the number
   *  calls come from now, not one the page showed earlier. */
  settings(): Promise<HubAlertResult<UrgentAlertSettingsView>>;
  /** The system's handler for the file (Contacts on macOS); an error text, or
   *  "" when it opened. */
  openPath(target: string): Promise<string>;
  /** Where the card is written; one file, written over on every press. */
  directory?: string;
}

/** Settings → Alerts → Add to contacts: the card for the number alert calls
 *  come from, written to a temporary folder and handed to the system, which
 *  shows it before anything is saved (she can cancel there). */
export async function openAlertCallContact(deps: AlertCallContactDependencies): Promise<OpenAlertCallContactResult> {
  const settings = await deps.settings();
  if (!settings.ok) return { ok: false, message: settings.error.message };
  const card = settings.value.phone ? alertCallContactCard(settings.value.phone.from) : undefined;
  if (!card) return { ok: false, message: "Phone calls aren't set up, so there is no number to save." };
  const directory = deps.directory ?? path.join(os.tmpdir(), "AccordAgents contact");
  const file = path.join(directory, ALERT_CALL_CONTACT_FILE_NAME);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(file, card, "utf8");
  } catch (error) {
    return { ok: false, message: `Couldn't write the contact card: ${error instanceof Error ? error.message : String(error)}` };
  }
  const failed = await deps.openPath(file);
  return failed ? { ok: false, message: `Couldn't open the contact card: ${failed}` } : { ok: true };
}
