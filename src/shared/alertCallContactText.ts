// What Add to contacts and Save logo say and are called, apart from the
// card itself, so a screen that only shows the words does not carry the photo.

export const ALERT_CALL_CONTACT_FILE_NAME = "AccordAgents.vcf";
export const ALERT_CALL_CONTACT_MIME = "text/vcard";
export const ALERT_CALL_LOGO_FILE_NAME = "AccordAgents logo.png";
/** What Add to contacts or Save logo on the computer came to; Save logo is
 *  canceled when she closes the save dialog. */
export type OpenAlertCallContactResult = { ok: true } | { ok: false; message: string };
export type SaveAlertCallLogoResult = OpenAlertCallContactResult | { ok: false; canceled: true };

// A contact she saved by hand before the button existed gets the logo too
// (Mia, 2026-11-27): which contact a Mac's import treats as the same one is
// not documented, so the logo can always be saved and set by hand; the iPhone's
// contact sheet offers Add to Existing Contact.
export const ALERT_CALL_CONTACT_HINT = "Save the number alert calls come from, with the AccordAgents name and logo, so you recognize the call. Already saved the number? Save the logo and set it as that contact's photo.";
export const ALERT_CALL_CONTACT_PHONE_HINT = "Save the number alert calls come from, with the AccordAgents name and logo, so you recognize the call. Already saved the number? Choose Add to Existing Contact to put the logo on it, or save the logo and set it as its photo.";
