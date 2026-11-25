export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
export const HISTORY_RETENTION_MS = 7 * DAY_MS;
export const UNAPPROVED_PROPOSAL_TTL_MS = 7 * DAY_MS;
export const HISTORY_MAX_ROWS = 500;
export const HISTORY_OUTPUT_TAILS = 20;
export const DEFAULT_TICK_MS = 15_000;
export const STOP_WAIT_MS = 3000;
export const SECRET_MAX_CHARS = 8192;
export const MAX_SECRETS = 16;
export const MAX_MENTIONS = 10;
export const NAME_MAX_CHARS = 80;
export const DESCRIPTION_MAX_CHARS = 600;
export const REASON_MAX_CHARS = 500;

/** An interval script must fail twice in a row before the User is told, so a
 *  network blip right after waking from sleep is not reported. */
export const INTERVAL_FAILURES_BEFORE_NOTICE = 2;

/** At most one "is failing" notice per script per hour, however it flaps. */
export const FAILING_NOTICE_MIN_GAP_MS = HOUR_MS;
