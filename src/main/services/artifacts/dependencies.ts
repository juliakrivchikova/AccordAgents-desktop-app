import type { ArtifactEventRecord, ArtifactStore } from "../artifactStore";

export interface ArtifactServiceDeps {
  store: ArtifactStore;
  // Current member set for a chat ("user" + chat member handles), or undefined
  // when the conversation does not exist or is not a chat.
  getMembers(conversationId: string): Promise<string[] | undefined>;
  // Post a brief linked note into the chat timeline. Never receives artifact bodies.
  postNote?(conversationId: string, eventId: string, content: string): Promise<void>;
  // Notify the renderer that this chat's artifact list changed.
  onChanged?(conversationId: string): void;
  logger?(event: string, payload: Record<string, unknown>): void;
  now?(): string;
  /**
   * Commits whatever records a change INSIDE the transaction that makes it:
   * `write` receives the statement to include and returns whether its own
   * change committed. On the User's server this places the change in the
   * server's order (its feed), so a document that changed is never left
   * without the entry every device learns it from, and an entry never
   * announces a change that did not happen.
   */
  commitWithChange?<T>(
    change: ArtifactCommittedChange,
    write: (statement: { sql: string; onlyIfSql: (condition: string) => string }) => Promise<T>
  ): Promise<T>;
}

/** A change about to commit: the document, and the chat note it posts. */
export interface ArtifactCommittedChange {
  conversationId: string;
  artifactId: string;
  /** The note's outbox row is written in the same transaction; its presence
   *  is what tells that this very call changed something. */
  event?: ArtifactEventRecord;
  /** A draft the change wrote. */
  draftId?: string;
}
