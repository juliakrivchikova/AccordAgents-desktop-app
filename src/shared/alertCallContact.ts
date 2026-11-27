import { ALERT_CALL_CONTACT_PHOTO_JPEG_BASE64 } from "./alertCallContactPhoto";
import { normalizePhoneNumber } from "./urgentAlerts";

// "Add to contacts" for urgent-alert calls (Settings → Alerts on the computer,
// Settings → Notifications on the phone): a contact card for the number the
// calls come from, so she recognizes the call. Only that number goes into the
// card, nothing else of her settings; it is made anew on every press, nothing
// follows a later change of the number.

export const ALERT_CALL_CONTACT_FILE_NAME = "AccordAgents.vcf";
export const ALERT_CALL_CONTACT_MIME = "text/vcard";
/** What Add to contacts on the computer came to. */
export type OpenAlertCallContactResult = { ok: true } | { ok: false; message: string };

export const ALERT_CALL_CONTACT_HINT = "Save the number alert calls come from, with the AccordAgents name and logo, so you recognize the call.";

/** vCard 3.0 (RFC 2426): lines end in CRLF, and a line longer than 75
 *  characters continues on the next one after a single space. */
function folded(line: string): string {
  // The continuation's leading space counts toward its 75.
  const parts = [line.slice(0, 75)];
  for (let at = 75; at < line.length; at += 74) parts.push(line.slice(at, at + 74));
  return parts.join("\r\n ");
}

/** The card for the number alert calls come from, or undefined when it is not
 *  a phone number in international form. */
export function alertCallContactCard(callFrom: string): string | undefined {
  const number = normalizePhoneNumber(callFrom);
  if (!number) return undefined;
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:AccordAgents",
    "N:;AccordAgents;;;",
    `TEL;TYPE=VOICE:${number}`,
    "URL:https://accordagents.com",
    "NOTE:Urgent alert calls from AccordAgents",
    `PHOTO;ENCODING=b;TYPE=JPEG:${ALERT_CALL_CONTACT_PHOTO_JPEG_BASE64}`,
    "END:VCARD"
  ].map(folded).join("\r\n") + "\r\n";
}
