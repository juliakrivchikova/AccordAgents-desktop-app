// W4: the mailbox seal/derive contract has one source. These tests pin all
// consumers to it by value: the canonical text must reproduce the committed
// known-answer fixture, every generated copy must be current and verbatim,
// and (in mailboxAccess.test.ts) the desktop implementation must produce the
// same fixture values.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadCanonicalContract() {
  const canonical = await readFile(path.join(repoRoot, "src/shared/mailboxCryptoContract.js"), "utf8");
  const run = new Function(`${canonical}\nreturn globalThis.AccordMailboxCrypto;`);
  return { canonical, contract: run() };
}

test("generated mailbox-crypto outputs are current", async () => {
  await execFileAsync(process.execPath, ["scripts/generate-mailbox-crypto.mjs", "--check"], { cwd: repoRoot });
});

test("canonical contract reproduces the committed known-answer fixture", async () => {
  const { contract } = await loadCanonicalContract();
  const vectors = JSON.parse(await readFile(path.join(repoRoot, "scripts/mailbox-contract-vectors.json"), "utf8"));
  const access = await contract.deriveAccess(vectors.sealKey);
  assert.equal(access.token, vectors.expectedToken);
  assert.equal(access.scopeId, vectors.expectedScopeId);
  const opened = await contract.openEnvelope(vectors.sealedSample, vectors.sealKey);
  assert.deepEqual(opened, vectors.sealedSamplePayload);
  const roundTrip = await contract.openEnvelope(await contract.sealToEnvelope(vectors.sealedSamplePayload, vectors.sealKey), vectors.sealKey);
  assert.deepEqual(roundTrip, vectors.sealedSamplePayload);
});

test("the PWA and runner embed the canonical contract verbatim", async () => {
  const { canonical } = await loadCanonicalContract();
  const body = canonical.trimEnd();
  const mobileApp = await readFile(path.join(repoRoot, "src/mobile/mobile-app.js"), "utf8");
  const indented = body.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n");
  assert.ok(mobileApp.includes(indented), "mobile-app.js must contain the canonical contract text");
  const runnerGenerated = await readFile(path.join(repoRoot, "src/main/services/mobileMailboxRunnerCrypto.generated.ts"), "utf8");
  assert.ok(runnerGenerated.includes(JSON.stringify(body)), "runner generated module must embed the canonical contract text");
});
