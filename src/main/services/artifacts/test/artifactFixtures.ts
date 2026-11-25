// What the document tests set up.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArtifactService } from "../../artifacts";
import { ArtifactStore } from "../../artifactStore";
import { resolveSqliteExecutable } from "../../sqliteCli";
import type { ArtifactError, ArtifactReadResult, ArtifactResult, PublishedArtifactReadResult } from "../../../../shared/types";

export const CONVERSATION_ID = "chat-1";

export const MEMBERS = ["user", "gera", "codex", "drew"];

export const SQLITE_EXECUTABLE = resolveSqliteExecutable({ appPath: process.cwd() });

interface Harness {
  dbPath: string;
  store: ArtifactStore;
  service: ArtifactService;
  notes: string[];
  changed: string[];
  cleanup: () => Promise<void>;
}

export async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "artifact-service-"));
  const dbPath = path.join(dir, "artifacts.sqlite3");
  const { store, service, notes, changed } = attach(dbPath);
  return {
    dbPath,
    store,
    service,
    notes,
    changed,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

// A second attach() over the same dbPath simulates an app restart (or another
// writer that does not share the first service's in-memory mutation queue).
export function attach(
  dbPath: string,
  getMembers: (conversationId: string) => Promise<string[] | undefined> = async (conversationId) => (
    conversationId === CONVERSATION_ID ? [...MEMBERS] : undefined
  )
): { store: ArtifactStore; service: ArtifactService; notes: string[]; changed: string[] } {
  const store = new ArtifactStore(dbPath, SQLITE_EXECUTABLE);
  const notes: string[] = [];
  const changed: string[] = [];
  const service = new ArtifactService({
    store,
    getMembers,
    postNote: async (_conversationId, _eventId, content) => {
      notes.push(content);
    },
    onChanged: (conversationId) => {
      changed.push(conversationId);
    }
  });
  return { store, service, notes, changed };
}

export function expectOk<T>(result: ArtifactResult<T>): T {
  assert.ok(result.ok, `expected ok result, got: ${result.ok ? "" : JSON.stringify(result.error)}`);
  return result.value;
}

export function expectError<T>(result: ArtifactResult<T>, code: ArtifactError["code"]): ArtifactError {
  assert.ok(!result.ok, `expected ${code} error, got ok result`);
  assert.equal(result.error.code, code, `expected ${code}, got ${result.error.code}: ${result.error.message}`);
  return result.error;
}

export function expectPublished(result: ArtifactReadResult): PublishedArtifactReadResult {
  assert.equal(result.lifecycle, "published", "expected a published artifact result");
  if (result.lifecycle !== "published") {
    throw new Error("Expected a published artifact result.");
  }
  return result;
}
