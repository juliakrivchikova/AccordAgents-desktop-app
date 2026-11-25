/** How long a scheduled-script request waits for the machine's answer. */
export const SCRIPTS_REQUEST_TIMEOUT_MS = 20_000;

/** How long one hold of a machine's turns lasts unless renewed, and how
 *  often it is renewed while held. */
export const TURN_HOLD_MS = 15 * 60_000;

export const TURN_HOLD_RENEW_MS = 5 * 60_000;

/** Runs whose live progress is followed per machine, at most. */
export const LIVE_PROGRESS_RUNS_MAX = 64;

/** How long a freshly connected desktop waits for the machine's own hello
 *  before asking for one. */
export const HELLO_REQUEST_GRACE_MS = 750;

/** How long a connected machine gets to answer a hello request before its
 *  last known hello is used instead. */
export const MACHINE_ACTIVITY_TIMEOUT_MS = 15_000;
