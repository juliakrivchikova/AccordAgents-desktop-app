export const SQLITE_MIGRATION_TIMEOUT_MS = 120_000;

/** A message row that may be a member's reply not ended yet: its JSON (as
 *  JSON.stringify writes it) holds a pending status somewhere. A superset —
 *  a nested status matches too — that the exact check then narrows. It never
 *  parses the row, so it cannot fail on one, and it is the condition of the
 *  partial index `idx_conversation_messages_pending_reply`: a query uses that
 *  index only while it states this very expression. The index is made once
 *  by name, so a change here needs a new index name as well. */
export const pendingReplyRowHintSql = (column: string): string => `instr(${column}, '"status":"pending"') > 0`;
