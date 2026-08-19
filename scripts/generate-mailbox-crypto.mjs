#!/usr/bin/env node
// W4 generator: src/shared/mailboxCryptoContract.js is the single source for
// the mailbox seal/derive contract. This script copies it verbatim into the
// PWA (between generated markers), emits the runner's embedded copy, and
// regenerates the known-answer fixture. Run after any contract edit and
// commit the outputs together; `--check` fails when any output is stale.
import { readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const canonicalPath = path.join(repoRoot, "src/shared/mailboxCryptoContract.js");
const sharedContractPath = path.join(repoRoot, "src/shared/mailboxSealedPayload.ts");
const mobileAppPath = path.join(repoRoot, "src/mobile/mobile-app.js");
const runnerGeneratedPath = path.join(repoRoot, "src/main/services/mobileMailboxRunnerCrypto.generated.ts");
const vectorsPath = path.join(repoRoot, "scripts/mailbox-contract-vectors.json");

const BEGIN_MARKER = "// >>> generated: mailbox-crypto (edit src/shared/mailboxCryptoContract.js, then run scripts/generate-mailbox-crypto.mjs)";
const END_MARKER = "// <<< generated: mailbox-crypto";

// Fixed inputs make every fixture field deterministic, so regeneration is
// diffable and a changed value is a contract change, never noise.
const VECTOR_SEAL_KEY = "5Vt3qY1uJ9wL7cP0aR8sD2fG4hK6mN1bX3zC5vB7nQk";
const VECTOR_PAYLOAD = { type: "mobile.timeline.events", conversationId: "vector-conversation", events: [{ id: "vector-1", content: "known answer" }] };
const VECTOR_IV_BASE64URL = "AAECAwQFBgcICQoL";

function assertConstantsMatch(canonical, shared) {
  const pairs = [
    ["MAILBOX_AUTH_TOKEN_INFO", /MAILBOX_AUTH_TOKEN_INFO = "([^"]+)"/],
    ["MAILBOX_SCOPE_ID_INFO", /MAILBOX_SCOPE_ID_INFO = "([^"]+)"/],
    ["MAILBOX_SCOPE_ID_PREFIX", /MAILBOX_SCOPE_ID_PREFIX = "([^"]+)"/],
    ["MAILBOX_SCOPE_ID_LENGTH", /MAILBOX_SCOPE_ID_LENGTH = (\d+)/]
  ];
  for (const [name, pattern] of pairs) {
    const inCanonical = pattern.exec(canonical)?.[1];
    const inShared = pattern.exec(shared)?.[1];
    if (!inCanonical || !inShared || inCanonical !== inShared) {
      throw new Error(`Constant ${name} differs between mailboxCryptoContract.js (${inCanonical}) and mailboxSealedPayload.ts (${inShared}).`);
    }
  }
}

function base64UrlToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function computeVectors(canonical) {
  // Execute the canonical text itself so the fixture is derived from the
  // single source, not from a reimplementation.
  const run = new Function(`${canonical}\nreturn globalThis.AccordMailboxCrypto;`);
  const contract = run();
  const access = await contract.deriveAccess(VECTOR_SEAL_KEY);
  const key = await webcrypto.subtle.importKey("raw", base64UrlToBytes(VECTOR_SEAL_KEY), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(VECTOR_IV_BASE64URL) },
    key,
    new TextEncoder().encode(JSON.stringify(VECTOR_PAYLOAD))
  );
  const sealedSample = {
    v: 1,
    alg: "A256GCM",
    iv: VECTOR_IV_BASE64URL,
    ct: Buffer.from(ciphertext).toString("base64url")
  };
  const opened = await contract.openEnvelope(sealedSample, VECTOR_SEAL_KEY);
  if (JSON.stringify(opened) !== JSON.stringify(VECTOR_PAYLOAD)) {
    throw new Error("Canonical contract failed to open its own fixture sample.");
  }
  return {
    sealKey: VECTOR_SEAL_KEY,
    expectedToken: access.token,
    expectedScopeId: access.scopeId,
    sealedSample,
    sealedSamplePayload: VECTOR_PAYLOAD
  };
}

function injectMobileBlock(mobileApp, canonical) {
  const begin = mobileApp.indexOf(BEGIN_MARKER);
  const end = mobileApp.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error("mobile-app.js is missing the generated mailbox-crypto markers.");
  }
  const indented = canonical.trimEnd().split("\n").map((line) => (line ? `  ${line}` : line)).join("\n");
  return `${mobileApp.slice(0, begin + BEGIN_MARKER.length)}\n${indented}\n  ${mobileApp.slice(end)}`;
}

function runnerGeneratedSource(canonical) {
  return `// GENERATED FILE — do not edit. Source: src/shared/mailboxCryptoContract.js
// Regenerate with: node scripts/generate-mailbox-crypto.mjs

export const MOBILE_MAILBOX_RUNNER_CRYPTO_SNIPPET: string = ${JSON.stringify(canonical.trimEnd())};
`;
}

async function main() {
  const check = process.argv.includes("--check");
  const canonical = await readFile(canonicalPath, "utf8");
  const shared = await readFile(sharedContractPath, "utf8");
  assertConstantsMatch(canonical, shared);

  const outputs = [];
  const mobileApp = await readFile(mobileAppPath, "utf8");
  outputs.push([mobileAppPath, injectMobileBlock(mobileApp, canonical), mobileApp]);
  const runnerCurrent = await readFile(runnerGeneratedPath, "utf8").catch(() => "");
  outputs.push([runnerGeneratedPath, runnerGeneratedSource(canonical), runnerCurrent]);
  const vectors = `${JSON.stringify(await computeVectors(canonical), null, 2)}\n`;
  const vectorsCurrent = await readFile(vectorsPath, "utf8").catch(() => "");
  outputs.push([vectorsPath, vectors, vectorsCurrent]);

  const stale = outputs.filter(([, next, current]) => next !== current);
  if (check) {
    if (stale.length > 0) {
      console.error(`Stale generated mailbox-crypto outputs: ${stale.map(([file]) => path.relative(repoRoot, file)).join(", ")}. Run node scripts/generate-mailbox-crypto.mjs and commit.`);
      process.exit(1);
    }
    console.log("mailbox-crypto generated outputs are current.");
    return;
  }
  for (const [file, next] of stale) {
    await writeFile(file, next, "utf8");
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
  if (stale.length === 0) {
    console.log("mailbox-crypto generated outputs already current.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
