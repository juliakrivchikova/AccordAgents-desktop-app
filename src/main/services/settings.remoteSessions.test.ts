import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RemoteParticipantSessionHandle } from "../../shared/types";
import { SettingsService } from "./settings";

const HANDLE: RemoteParticipantSessionHandle = {
  sessionKey: "participant-session",
  sessionDir: "/srv/worker/sessions/participant-session",
  worker: { host: "worker.example", user: "ubuntu", workerRoot: "/srv/worker" },
  protocolVersion: 1,
  runtimeFingerprint: "fingerprint",
  updatedAt: "2026-07-09T00:00:00.000Z"
};

test("remote session cleanup tombstones are durable, normalized, and deduplicated", async () => {
  let stored: Record<string, unknown> = {
    roundLimitDefault: 1,
    providers: []
  };
  const service = Object.create(SettingsService.prototype) as any;
  service.remoteSessionCleanupPath = path.join(
    await mkdtemp(path.join(tmpdir(), "accordagents-cleanup-registry-")),
    "remote-session-cleanup.json"
  );
  service.remoteSessionCleanupMutation = Promise.resolve();
  service.readStored = async () => structuredClone(stored);
  service.writeStored = async (next: Record<string, unknown>) => {
    stored = structuredClone(next);
  };

  const first = await service.enqueueRemoteSessionCleanup(HANDLE, "chat-deleted");
  const duplicate = await service.enqueueRemoteSessionCleanup(HANDLE, "participant-removed");
  assert.equal(duplicate.id, first.id);
  const listed = await service.listRemoteSessionCleanupTombstones();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, first.id);
  assert.equal(listed[0].handle.sessionKey, HANDLE.sessionKey);
  assert.equal(listed[0].handle.worker.host, HANDLE.worker.host);

  await service.removeRemoteSessionCleanupTombstone(first.id);
  assert.deepEqual(await service.listRemoteSessionCleanupTombstones(), []);
});

test("concurrent cleanup tombstone mutations do not lose either session", async () => {
  const service = Object.create(SettingsService.prototype) as any;
  service.remoteSessionCleanupPath = path.join(
    await mkdtemp(path.join(tmpdir(), "accordagents-cleanup-race-")),
    "remote-session-cleanup.json"
  );
  service.remoteSessionCleanupMutation = Promise.resolve();
  service.readStored = async () => ({ roundLimitDefault: 1, providers: [] });

  await Promise.all([
    service.enqueueRemoteSessionCleanup(HANDLE, "chat-deleted", {
      conversationId: "chat-a",
      runIds: ["run-a"],
      removeArtifacts: true
    }),
    service.enqueueRemoteSessionCleanup({
      ...HANDLE,
      sessionKey: "participant-session-b",
      sessionDir: "/srv/worker/sessions/participant-session-b"
    }, "participant-removed", {
      conversationId: "chat-b",
      runIds: ["run-b"],
      removeArtifacts: true
    })
  ]);

  const listed = await service.listRemoteSessionCleanupTombstones();
  assert.equal(listed.length, 2);
  assert.deepEqual(new Set(listed.flatMap((item: any) => item.runIds)), new Set(["run-a", "run-b"]));
});
