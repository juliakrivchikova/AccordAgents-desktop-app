/** How often a waiting tool call tells the CLI it is still running. Claude
 *  Code drops a plain JSON answer after 60 s and an idle stream after 5 min
 *  (2.1.280), so a call that waits for the User answers as a stream and
 *  reports progress well inside that. */
export const APP_MCP_WAITING_PROGRESS_MS = 20_000;

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MAX_MCP_BODY_BYTES = 1_000_000;
