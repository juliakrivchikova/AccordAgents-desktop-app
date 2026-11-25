import type { ArtifactResult } from "../../../shared/types";
import type { ArtifactCommittedChange } from "./dependencies";
import { errorMessage, invalid, ok } from "./results";
import type { ArtifactServiceDeps } from "./dependencies";

/** Runs one change of a conversation's documents at a time and tells what it committed. */
export class ArtifactMutations {
  constructor(private readonly deps: Pick<ArtifactServiceDeps, "commitWithChange" | "logger" | "now" | "onChanged" | "postNote" | "store">) {}

  async commit<T>(change: ArtifactCommittedChange, condition: string, write: (sql?: string) => Promise<T>): Promise<T> {
    if (!this.deps.commitWithChange) return write();
    return this.deps.commitWithChange(change, (statement) => write(statement.onlyIfSql(condition)));
  }

  async flushPendingArtifactEvents(): Promise<void> {
    if (!this.deps.postNote) {
      return;
    }
    let cursor: { createdAt: string; id: string } | undefined;
    while (true) {
      const pending = await this.deps.store.listPendingEvents(100, cursor);
      if (pending.length === 0) {
        return;
      }
      for (const event of pending) {
        try {
          await this.deps.postNote(event.conversationId, event.id, event.content);
          await this.deps.store.markEventDelivered(event.id, this.now());
        } catch (error) {
          this.log("artifacts.post-note-error", {
            conversationId: event.conversationId,
            eventId: event.id,
            message: errorMessage(error)
          });
        }
      }
      const last = pending[pending.length - 1]!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
  }

  async operationResult<T = unknown>(
    conversationId: string,
    actor: string,
    operationKind: string,
    operationId: string,
    requestHash: string
  ): Promise<ArtifactResult<{ artifactId: string; draftId?: string; value?: T }> | undefined> {
    const existing = await this.deps.store.getOperation(conversationId, actor, operationKind, operationId);
    if (!existing) {
      return undefined;
    }
    if (existing.requestHash !== requestHash) {
      return invalid(`operationId "${operationId}" was already used with a different request.`);
    }
    if (!existing.applied) {
      return invalid(`operationId "${operationId}" exists but its mutation did not complete.`);
    }
    try {
      const parsed = JSON.parse(existing.resultJson) as { artifactId?: unknown; draftId?: unknown; value?: unknown };
      if (typeof parsed.artifactId !== "string") {
        return invalid("Stored operation result is invalid.");
      }
      return ok({
        artifactId: parsed.artifactId,
        draftId: typeof parsed.draftId === "string" ? parsed.draftId : undefined,
        value: parsed.value as T | undefined
      });
    } catch {
      return invalid("Stored operation result is invalid.");
    }
  }

  withMutation<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    return this.deps.store.withMutation(conversationId, fn);
  }

  notifyChanged(conversationId: string): void {
    try {
      this.deps.onChanged?.(conversationId);
    } catch (error) {
      this.log("artifacts.on-changed-error", { conversationId, message: errorMessage(error) });
    }
  }

  now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private log(event: string, payload: Record<string, unknown>): void {
    try {
      this.deps.logger?.(event, payload);
    } catch {
      // Logging must never break artifact operations.
    }
  }
}
