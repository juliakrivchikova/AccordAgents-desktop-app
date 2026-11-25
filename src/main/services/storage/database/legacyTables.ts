/**
 * The order of signed events every device kept before the User's server
 * owned the chats, and everything only it used: the events and their
 * projections, the native turn commands built on them, the per-device
 * delivery queues, the phone's turn claims, a removed machine's deletion
 * targets, the server's order, folding, readers and retention bookkeeping,
 * and a device's held places. Tables that refer to others come first.
 */
export const LEGACY_EVENT_TABLES = [
  "native_commands",
  "native_run_cancellations",
  "native_run_outcomes",
  "native_session_executors",
  "device_event_outbox",
  "device_event_inbox",
  "device_event_applied_heads",
  "device_replica_copies",
  "device_replica_inventory",
  "chat_event_projections",
  "phone_turn_claims",
  "conversation_deletion_targets",
  "hub_client_held_events",
  "hub_log",
  "hub_fold_state",
  "hub_device_cursors",
  "hub_reader_floors",
  "hub_device_reads",
  "hub_pair_machines",
  "hub_chain_marks",
  "hub_prune_state",
  "hub_retention_candidates",
  "device_event_blob_gc",
  "device_event_blob_gc_refs",
  "chat_events"
] as const;

/** Bodies: a device kept the large payloads of its events here; only the
 *  User's server keeps bodies now (pictures, avatars). */
export const LEGACY_BODY_TABLES = ["device_event_blob_fragments", "device_event_blob_pins", "device_event_blobs"] as const;

/** Where a device stood in the old order (hub_client_state keys). */
export const LEGACY_CLIENT_STATE_KEYS = ["pushed-rowid", "pulled-hub-seq", "hub-id", "given-up", "dismissed-notices"] as const;

/** The old order's logical clock (schema_meta). */
export const LEGACY_META_KEYS = ["chat-event-clock-v1"] as const;

/** Rows deleted per transaction while a legacy table is emptied, and the
 *  pause between two batches (other work gets the database meanwhile): an
 *  event row is a few KB with four indexes, so a batch holds the database
 *  for a fraction of a second. */
export const LEGACY_DROP_BATCH_ROWS = 500;

export const LEGACY_DROP_PAUSE_MS = 100;
