import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  awsWorkerPrivateKeyPath,
  deleteAwsWorkerKeyMaterial,
  generateOrLoadAwsWorkerKeyMaterial
} from "./awsWorkerKeyMaterial";

async function tempKeyDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "accordagents-key-test-"));
}

test("generateOrLoadAwsWorkerKeyMaterial creates and then reuses a device key", async () => {
  const keyDir = await tempKeyDir();
  const first = await generateOrLoadAwsWorkerKeyMaterial({
    keyDir,
    suffix: () => "device-a",
    now: () => new Date("2026-07-03T00:00:00.000Z")
  });
  assert.equal(first.keyName, "accordagents-worker-device-a");
  assert.equal(first.reused, false);
  assert.match(first.publicKeyOpenSsh, /^ssh-ed25519 /);
  await access(first.privateKeyPath, constants.R_OK);
  await access(`${first.privateKeyPath}.pub`, constants.R_OK);

  const second = await generateOrLoadAwsWorkerKeyMaterial({
    keyDir,
    suffix: () => {
      throw new Error("suffix should not be needed when local key files are valid");
    }
  });
  assert.equal(second.keyName, first.keyName);
  assert.equal(second.privateKeyPath, first.privateKeyPath);
  assert.equal(second.publicKeyOpenSsh, first.publicKeyOpenSsh);
  assert.equal(second.reused, true);
});

test("generateOrLoadAwsWorkerKeyMaterial rotates when manifest key files are missing", async () => {
  const keyDir = await tempKeyDir();
  const first = await generateOrLoadAwsWorkerKeyMaterial({ keyDir, suffix: () => "device-a" });
  await unlink(`${first.privateKeyPath}.pub`);
  const second = await generateOrLoadAwsWorkerKeyMaterial({ keyDir, suffix: () => "device-b" });
  assert.equal(second.keyName, "accordagents-worker-device-b");
  assert.equal(second.reused, false);
  const manifest = JSON.parse(await readFile(path.join(keyDir, "device-key.json"), "utf8")) as { keyName: string };
  assert.equal(manifest.keyName, "accordagents-worker-device-b");
});

test("awsWorkerPrivateKeyPath supports the legacy unsuffixed key name", async () => {
  const keyDir = await tempKeyDir();
  assert.equal(
    awsWorkerPrivateKeyPath(keyDir, "accordagents-worker"),
    path.join(keyDir, "accordagents-worker.pem")
  );
});

test("deleteAwsWorkerKeyMaterial removes key files and current manifest", async () => {
  const keyDir = await tempKeyDir();
  const key = await generateOrLoadAwsWorkerKeyMaterial({ keyDir, suffix: () => "device-a" });
  await deleteAwsWorkerKeyMaterial(keyDir, key.keyName);
  await assert.rejects(() => access(key.privateKeyPath, constants.F_OK), /ENOENT/);
  await assert.rejects(() => access(`${key.privateKeyPath}.pub`, constants.F_OK), /ENOENT/);
  await assert.rejects(() => access(path.join(keyDir, "device-key.json"), constants.F_OK), /ENOENT/);
});
