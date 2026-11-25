export const BLOB_PATH = /^\/v1\/blobs\/(sha256:[0-9a-f]{64})$/;

/** A key Twilio posts: a few dozen form fields. */
export const TWILIO_MAX_BODY_BYTES = 16 * 1024;

/** A pairing request is a key, a signature and a token. */
export const ENROLL_MAX_BODY_BYTES = 16 * 1024;

/** A socket that did not answer the last ping by the next one is dead (a
 *  laptop that slept, a phone that lost its network) and is closed. */
export const HEARTBEAT_MS = 30_000;

/** A device that cannot keep up with its room is disconnected rather than
 *  buffered without end; it reconnects and continues. */
export const ROOM_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Requests slower than this are logged; the rest only count. */
export const SLOW_REQUEST_MS = 500;

/** Search text and cursors are plain text. */
export const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export const ROOM_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** How long a body a phone put up is kept before a message names it. */
export const PHONE_UPLOAD_PIN_MS = 30 * 24 * 60 * 60_000;

export const UPLOAD_PIN_MS = 24 * 60 * 60_000;

/** Pairing attempts per address, and from everywhere, in a minute. */
export const ENROLL_ATTEMPTS_PER_ADDRESS = 10;

export const ENROLL_ATTEMPTS_ALL = 600;

/** What the hub answers a signed request from a device not on its roster. */
export const HUB_NOT_ON_ROSTER = "This device is not on the hub's roster.";
