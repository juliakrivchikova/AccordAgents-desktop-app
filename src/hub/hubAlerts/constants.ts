import { URGENT_ALERT_ACKNOWLEDGEABLE_STATES, URGENT_ALERT_OPEN_STATES } from "../../shared/urgentAlerts";

export const OPEN_STATES: readonly string[] = URGENT_ALERT_OPEN_STATES;

/** States Got it still ends: an alert nobody answered can still be seen. */
export const ACKNOWLEDGEABLE: ReadonlySet<string> = new Set(URGENT_ALERT_ACKNOWLEDGEABLE_STATES);

export const PHONE_KEYS_REFUSED = "Twilio no longer accepts these keys. Connect the phone again.";
