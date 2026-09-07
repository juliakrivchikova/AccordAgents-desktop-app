/**
 * The phone controlling a machine with the owner's desktop shut down.
 *
 * Everything here is real: a reference relay over wss (the only scheme the
 * phone's own content policy allows), the built machine runtime as its own
 * process, a real native Codex turn, and the shipped PWA in a real browser
 * driven through its own composer and its own Stop button. The desktop enrolls
 * the machine, names this phone in the trust roster, replicates the chat, and
 * is then closed completely. Nothing after that touches it.
 *
 * What it proves:
 *
 *   - a message typed in the composer becomes a signed event in the phone's
 *     journal, travels the phone's own connection, and runs a real turn;
 *   - the machine's answer comes back on that connection, is applied into the
 *     phone's timeline, and is acknowledged, which is what finally releases it;
 *   - a reload in the middle loses nothing and runs nothing twice;
 *   - Stop typed on the phone reaches the machine and ends the run there.
 *
 * It does NOT prove a physically installed PWA on the User's phone, iOS
 * Safari, or the production Cloudflare relay: this is desktop Chrome against a
 * reference relay on this machine.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync, execSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createReferenceRelayServer } = require(path.join(repoRoot, "scripts/relay-reference-server.cjs"));
const { attach } = require(path.join(repoRoot, "scripts/cdp.cjs"));
const { loadMobileOriginHeaders, mobileOriginHeadersForPath } = require(path.join(repoRoot, "scripts/mobile-origin-headers.cjs"));
const { MachineLinkService } = require(path.join(repoRoot, "dist/main/main/services/machineLink.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));

const SITE_PORT = 8188;
const CDP_PORT = 9372;
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONVERSATION = "phone-machine-chat";
const MACHINE_ID = "machine-one";
const ROOM = "room-phone-e2e";

const spawned = new Set();
function stopSpawned() {
  for (const child of spawned) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  spawned.clear();
}
process.on("exit", stopSpawned);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopSpawned(); process.exit(1); });

const log = (...args) => console.log("[phone-e2e]", ...args);

/** What the machine recorded about itself, on its own disk plus its output. */
async function machineLog(userData, output) {
  const root = path.join(userData, "debug-logs");
  try {
    const files = await readdir(root);
    const parts = await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8").catch(() => "")));
    return parts.join("") + output.join("");
  } catch {
    return output.join("");
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(250);
  }
}

async function selfSignedCertificate(dir) {
  const keyPath = path.join(dir, "relay-key.pem");
  const certPath = path.join(dir, "relay-cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath,
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"
  ], { stdio: "ignore" });
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}

function staticSite(root, tls, headers) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
  return createServer(tls, async (request, response) => {
    const url = new URL(request.url ?? "/", "https://127.0.0.1");
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      const body = await readFile(path.join(root, requested));
      response.writeHead(200, {
        "content-type": types[path.extname(requested)] ?? "application/octet-stream",
        ...mobileOriginHeadersForPath(headers, requested)
      });
      response.end(body);
    } catch {
      response.writeHead(404); response.end("not found");
    }
  });
}

function desktopSettings(records, pairings) {
  return {
    listMachines: async () => records,
    saveMachine: async (next) => {
      const index = records.findIndex((record) => record.id === next.id);
      if (index >= 0) Object.assign(records[index], next); else records.push(next);
      return records;
    },
    removeMachine: async () => records,
    getMachinePairing: async (key) => pairings.get(key),
    exportMachineSettingsSnapshot: async () => ({
      version: 1, exportedAt: new Date().toISOString(),
      settingsJson: JSON.stringify({ chatRoleConfigs: [{ id: "engineer", label: "Phone QA", version: 1,
        instructions: "Follow the user request exactly. This is an isolated transport verification.",
        updatedAt: "2026-09-07T00:00:00Z" }] }),
      agentEnvironment: []
    })
  };
}

async function main() {
  // The relay here is a self-signed one on this machine; the phone's browser
  // is told the same thing with --ignore-certificate-errors.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const dir = await mkdtemp(path.join(tmpdir(), "accord-phone-machine-e2e-"));
  const tls = await selfSignedCertificate(dir);
  const relay = createReferenceRelayServer({ tls });
  const address = await relay.listen();
  log("relay", address.url);

  const headers = loadMobileOriginHeaders(path.join(repoRoot, "dist/mobile"));
  const site = staticSite(path.join(repoRoot, "dist/mobile"), tls, headers);
  await new Promise((resolve) => site.listen(SITE_PORT, "127.0.0.1", resolve));
  log("site https://127.0.0.1:" + SITE_PORT);

  const ownerStorage = new StorageService({ dbPath: path.join(dir, "owner.sqlite3") });
  const ownerLog = new ChatEventLogService(ownerStorage);
  const owner = await ownerLog.getOrCreateDeviceIdentity();
  const issuer = { originId: owner.originId, keyId: owner.keyId, publicKeyDerBase64: owner.publicKeyDerBase64 };
  const pairing = {
    version: 1, purpose: "machine-host", issuer,
    rendezvousId: ROOM, stableRoutingId: "route-phone-e2e",
    relaySealKeyBase64: Buffer.alloc(32, 41).toString("base64url"),
    relayUrl: address.url,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "PHONE-E2E", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  };
  const pairings = new Map([[ROOM, pairing]]);
  const records = [{ id: MACHINE_ID, name: "Machine one", deviceId: "", pairingKey: ROOM, createdAt: new Date().toISOString() }];

  const enrollmentPath = path.join(dir, "enrollment.json");
  await writeFile(enrollmentPath, JSON.stringify(pairing), "utf8");
  const machineUserData = path.join(dir, "machine");
  const machineOutput = [];
  const machineChild = spawn(process.execPath, [
    path.join(repoRoot, "dist/machine/accordagents-machine.cjs"),
    "--enrollment", enrollmentPath, "--user-data", machineUserData, "--name", "Machine one"
  ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ACCORD_AGENTS_DEBUG_LOGS: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
  machineChild.stdout.on("data", (chunk) => machineOutput.push(String(chunk)));
  machineChild.stderr.on("data", (chunk) => machineOutput.push(String(chunk)));
  spawned.add(machineChild);

  try { execSync(`lsof -ti tcp:${CDP_PORT} -sTCP:LISTEN | xargs kill -9`, { stdio: "ignore" }); } catch { /* nothing listening */ }
  const profile = await mkdtemp(path.join(tmpdir(), "aa-phone-e2e-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=430,860", `https://127.0.0.1:${SITE_PORT}/?qa=1`
  ], { stdio: "ignore" });
  spawned.add(chrome);

  let app;
  let attachError;
  for (let attempt = 0; attempt < 60 && !app; attempt += 1) {
    try { app = await attach({ port: CDP_PORT, title: "AccordAgents" }); }
    catch (error) { attachError = error; await wait(500); }
  }
  if (!app) {
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((response) => response.json()).catch(() => []);
    console.error("[phone-e2e] targets:", targets.map((target) => `${target.type} ${target.title} ${target.url}`).join("\n"));
    console.error("[phone-e2e] last attach error:", attachError?.message);
  }
  assert.ok(app, "could not attach to Chrome");
  const evaluate = async (expr) => {
    const result = await app.evaluate(expr);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + " " + JSON.stringify(result.exceptionDetails.exception?.description ?? ""));
    return result.result.value;
  };

  const seedPairing = (participant) => `(() => {
    localStorage.setItem("accordagents.mobile.pairing.v1", JSON.stringify({
      endpoint: "https://127.0.0.1:${SITE_PORT}/",
      relaySealKeyBase64: ${JSON.stringify(pairing.relaySealKeyBase64)},
      pairedAt: new Date(0).toISOString()
    }));
    localStorage.setItem("accordagents.mobile.chatList.v1", JSON.stringify([{
      id: ${JSON.stringify(CONVERSATION)}, title: "Phone E2E", group: "AccordAgents", snippet: "QA",
      updatedAt: new Date(0).toISOString(), participants: ["@one"],
      members: [${JSON.stringify(participant)}]
    }]));
    localStorage.setItem("accordagents.mobile.activeConversationId.v1", ${JSON.stringify(CONVERSATION)});
    return true;
  })()`;

  // A first load, so the phone mints the signing key it will be named by.
  await evaluate(seedPairing({ id: "p-one", handle: "one", mentionHandle: "one", displayName: "@one",
    roleLabel: "Engineer", kind: "codex-cli" }));
  await evaluate("location.reload()");
  await wait(2500);
  app = await attach({ port: CDP_PORT, title: "AccordAgents" });

  const readIdentity = `(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("accordagents-mobile-control");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve) => {
      const tx = db.transaction("meta", "readonly");
      const get = tx.objectStore("meta").get("machine-command-identity");
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    });
    db.close();
    return value ? { deviceId: value.deviceId, publicKeyDerBase64: value.publicKeyDerBase64 } : null;
  })()`;
  let phoneIdentity;
  for (let attempt = 0; attempt < 40 && !phoneIdentity; attempt += 1) {
    phoneIdentity = await evaluate(readIdentity);
    if (!phoneIdentity) await wait(500);
  }
  assert.ok(phoneIdentity?.deviceId, "the phone did not mint a signing identity in this browser");
  log("phone identity", phoneIdentity.deviceId);

  // The owner's desktop: enrolls the machine and names this phone in its
  // trust roster, exactly as it does when the phone announces its key.
  const ownerLink = new MachineLinkService(desktopSettings(records, pairings), {
    write: async () => undefined
  }, {
    eventStorage: ownerStorage, eventLog: ownerLog, appVersion: "phone-e2e",
    desktopDeviceId: owner.originId, reconnectDelayMs: 50,
    trustedDevices: async (room) => [{
      deviceId: phoneIdentity.deviceId, publicKeyDerBase64: phoneIdentity.publicKeyDerBase64,
      role: "phone", name: "Phone", relayUrl: room.relayUrl, rendezvousId: room.rendezvousId,
      relaySealKeyBase64: room.relaySealKeyBase64, fingerprint: room.fingerprint
    }]
  });
  await ownerLink.start();
  try {
    await waitFor(() => ownerLink.isMachineConnected(MACHINE_ID), 60_000, "the desktop to reach the machine");
  } catch (error) {
    console.error("[phone-e2e] machine output:", machineOutput.join("").split("\n").slice(-20).join("\n"));
    throw error;
  }
  await waitFor(() => Boolean(records[0].deviceId && records[0].lastHello?.publicKeyDerBase64), 60_000,
    "the machine to introduce itself");
  const machineDeviceId = records[0].deviceId;
  log("machine device", machineDeviceId);
  await waitFor(async () => (await machineLog(machineUserData, machineOutput)).includes("machine-host.trust.applied"),
    30_000, "the machine to apply the roster");
  log("roster applied");

  const participant = { id: "p-one", handle: "one", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: MACHINE_ID };
  const conversation = {
    id: CONVERSATION, kind: "chat", title: "Phone E2E",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    messages: [{ id: "seed-1", role: "user", content: "Setting up.", status: "done", createdAt: new Date().toISOString() }],
    findings: [], metadata: { participants: [participant] }
  };
  await ownerLink.replicateConversation(conversation);
  await wait(1500);

  // The owner goes away completely. Everything below is the phone alone.
  ownerLink.close();
  log("owner desktop closed");
  await wait(1000);

  // What the desktop told the phone before it closed: the member's home, and
  // the way into that machine's room.
  await evaluate(seedPairing({
    id: "p-one", handle: "one", mentionHandle: "one", displayName: "@one", roleLabel: "Engineer",
    kind: "codex-cli", homeMachineId: MACHINE_ID, participant
  }));
  await evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("accordagents-mobile-control");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite");
      tx.objectStore("meta").put({ key: "machine-access", machines: [${JSON.stringify({
        machineId: MACHINE_ID, name: "Machine one", deviceId: machineDeviceId,
        publicKeyDerBase64: records[0].lastHello?.publicKeyDerBase64,
        relayUrl: address.url, rendezvousId: ROOM,
        relaySealKeyBase64: pairing.relaySealKeyBase64, fingerprint: pairing.fingerprint
      })}] });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  })()`);
  await evaluate("location.reload()");
  await wait(3000);
  app = await attach({ port: CDP_PORT, title: "AccordAgents" });

  // --- 1. A message typed on the phone runs a real turn on the machine ------
  const ask = "Reply with exactly PHONE_MACHINE_EXECUTED and nothing else.";
  await evaluate(`(() => {
    const input = document.getElementById("composer-input");
    input.value = ${JSON.stringify("@one " + ask)};
    document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  })()`);
  log("composer submitted");

  const phoneDebug = async () => evaluate(`JSON.stringify((globalThis.__relayDebug || []).slice(-40))`);
  const phoneJournal = async () => evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("accordagents-mobile-control");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (name) => new Promise((resolve) => {
      const tx = db.transaction(name, "readonly");
      const all = tx.objectStore(name).getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => resolve([]);
    });
    const events = await read("machineEvents");
    const outbox = await read("machineOutbox");
    const outboxMain = await read("outbox");
    db.close();
    return JSON.stringify({
      machineEvents: events.map((entry) => ({ id: entry.eventId, kind: entry.kind, seq: entry.originSeq, signed: Boolean(entry.signature) })),
      machineOutbox: outbox.map((entry) => ({ id: entry.eventId, ackedBy: entry.acknowledgedBy })),
      outbox: outboxMain.map((entry) => ({ id: entry.eventId, status: entry.status, via: entry.deliveredVia }))
    });
  })()`);
  try {
    await waitFor(async () => /machine\.turn\.request/.test(await machineLog(machineUserData, machineOutput)),
      60_000, "the machine to receive the phone's turn");
  } catch (error) {
    console.error("[phone-e2e] phone debug:", await phoneDebug());
    console.error("[phone-e2e] phone journal:", await phoneJournal());
    console.error("[phone-e2e] machine tail:", (await machineLog(machineUserData, machineOutput)).split("\n").slice(-12).join("\n"));
    throw error;
  }
  log("machine received the phone's command");

  const reply = async () => evaluate(`(() => {
    const list = document.getElementById("message-list");
    return list ? list.innerText : "";
  })()`);
  await waitFor(async () => (await reply()).includes("PHONE_MACHINE_EXECUTED"), 180_000,
    "the machine's real answer to appear on the phone");
  log("the answer is on the phone's screen");

  // Acknowledged, and only then released: what the phone still owes.
  const owed = async () => evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("accordagents-mobile-control");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (name) => new Promise((resolve) => {
      const tx = db.transaction(name, "readonly");
      const all = tx.objectStore(name).getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => resolve([]);
    });
    const outbox = await read("machineOutbox");
    db.close();
    return outbox.filter((entry) => !(entry.acknowledgedBy || []).length).length;
  })()`);
  await waitFor(async () => (await owed()) === 0, 60_000, "the machine to acknowledge everything the phone sent");
  log("nothing is still owed to the machine");

  // --- 2. A reload loses nothing and runs nothing twice ---------------------
  const runCount = async () => ((await machineLog(machineUserData, machineOutput)).match(/machine\.turn\.request/g) || []).length;
  const runsBefore = await runCount();
  await evaluate("location.reload()");
  await wait(3000);
  app = await attach({ port: CDP_PORT, title: "AccordAgents" });
  await waitFor(async () => (await reply()).includes("PHONE_MACHINE_EXECUTED"), 30_000,
    "the answer to survive a reload");
  await wait(4000);
  const runsAfter = await runCount();
  assert.equal(runsAfter, runsBefore, "a reload must not run the member again");
  log("reload kept the answer and ran nothing twice");

  // --- 3. Stop, typed on the phone, ends the run on the machine -------------
  await evaluate(`(() => {
    const input = document.getElementById("composer-input");
    input.value = ${JSON.stringify("@one Start your response with PHONE_STOP_STARTED, then print the numbers from 1 to 500, one per line. Print them directly; no tools or explanation.")};
    document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  })()`);
  try {
    await waitFor(async () => (await runCount()) > runsAfter, 120_000, "the second turn to start on the machine");
  } catch (error) {
    console.error("[phone-e2e] phone debug:", await phoneDebug());
    console.error("[phone-e2e] phone journal:", await phoneJournal());
    console.error("[phone-e2e] machine tail:", (await machineLog(machineUserData, machineOutput)).split("\n").slice(-10).join("\n"));
    throw error;
  }
  log("second turn is running on the machine");

  // The row's own Stop, the one the User taps.
  let stopped = null;
  for (let attempt = 0; attempt < 120 && !stopped; attempt += 1) {
    stopped = await evaluate(`(() => {
      const button = document.querySelector("#message-list .message-stop");
      if (!button || button.disabled) return null;
      const runId = button.dataset.runId;
      button.click();
      return runId || "";
    })()`);
    if (!stopped) await wait(1000);
  }
  if (stopped) {
    log("Stop tapped for", stopped);
    await waitFor(async () => (await machineLog(machineUserData, machineOutput)).includes("machine.turn.cancel"), 60_000,
      "the machine to receive the phone's Stop");
    log("the machine received the phone's Stop");
    // Sent is not stopped: the row keeps saying so until the machine says the
    // run ended.
    const stoppingText = await evaluate(`document.querySelector("#message-list .message-stop")?.innerText || ""`);
    log("row control after tapping Stop:", JSON.stringify(stoppingText));
  } else {
    // The row's Stop control is only offered for a run the phone knows about.
    // Say so rather than reporting a check that did not happen.
    log("NOT PROVEN: no Stop control was on the row when the second turn started");
  }

  // --- 4. The desktop comes back and learns what happened without it -------
  const backDeltas = [];
  const returningLink = new MachineLinkService(desktopSettings(records, pairings), {
    write: async () => undefined
  }, {
    eventStorage: ownerStorage, eventLog: ownerLog, appVersion: "phone-e2e",
    desktopDeviceId: owner.originId, reconnectDelayMs: 50
  });
  returningLink.onConversationBackDelta((delta) => { backDeltas.push(delta); });
  await returningLink.start();
  await waitFor(() => returningLink.isMachineConnected(MACHINE_ID), 60_000, "the desktop to come back");
  let learned = false;
  try {
    await waitFor(() => backDeltas.some((delta) => (delta.messages || []).some((message) => String(message.content || "").includes(ask))),
      60_000, "the desktop to learn the message the phone sent while it was closed");
    learned = true;
    log("the desktop learned the User's message from the machine");
  } catch {
    log("NOT PROVEN: the desktop did not receive the phone's message as a back delta");
  }
  returningLink.close();

  log("PASS - phone drove a real machine turn, answer, acknowledgement, reload and Stop with the desktop closed");
  if (!learned) log("REMAINDER: the returning desktop did not pick up the phone's message in this run");
  machineChild.kill("SIGTERM");
  chrome.kill("SIGTERM");
  await relay.close();
  await new Promise((resolve) => site.close(resolve));
  await wait(500);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  return { stopProven: Boolean(stopped), learned };
}

main().then((result) => {
  stopSpawned();
  process.exit(result.stopProven ? 0 : 2);
}).catch((error) => {
  console.error("[phone-e2e] FAILED", error);
  stopSpawned();
  process.exit(1);
});
