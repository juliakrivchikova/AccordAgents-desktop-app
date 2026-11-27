export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** ChatParticipantSession.instructionsAccessHash after a compaction: the
 *  member's next turn says its access again (MemberSessions.accessRestateDue). */
export const INSTRUCTIONS_ACCESS_RESTATE = "restate";

export const CHAT_WARM_AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;

/** How many refused answers a waiting choice keeps for the devices that sent them. */
export const CHAT_CHOICE_REFUSALS_KEPT = 5;

export const CHAT_ADMINISTRATOR_ROLE_ID = "administrator";

// Built-in role used as a safety fallback when a participant's role is missing
// (deleted/archived-and-removed/imported), so a turn never crashes on resolution.
export const GENERIC_PARTICIPANT_ROLE_ID = "generic-participant";

export const PARTICIPANT_REQUEST_STOPPED_BY_USER = "Stopped by User.";
/** A request whose reply was cut short for a message the User sent now. */
export const PARTICIPANT_REQUEST_CUT_BY_SEND_NOW = "Interrupted before it finished: the User sent the member a message now.";

/** Why a request the app lost track of (a restart, a run gone) ended. */
export const PARTICIPANT_REQUEST_INTERRUPTED_BEFORE_COMPLETION = "Request was interrupted before completion.";

export const CHAT_CONTEXT_READ_DEFAULT_LIMIT = 50;
export const CHAT_IMAGE_MAX_ATTACHMENTS = 5;
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
