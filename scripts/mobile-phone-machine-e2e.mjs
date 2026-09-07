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
import { spawn, execFileSync } from "node:child_process";
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
const { readPosixProcessTableSync } = require(path.join(repoRoot, "dist/main/main/services/processTermination.js"));

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

/** A single-quoted SQL literal, for the machine's own sqlite record. */
function sqlText(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

/**
 * Whether a process the machine recorded is still alive.
 *
 * Read with the machine's own process table reader, so the start time compared
 * here is the one it wrote. A bare pid check would call a reused pid a
 * surviving provider, and a different reader's format would call a live one
 * gone -- both are the wrong answer, in opposite directions.
 */
function processStillRunning(recorded) {
  if (!recorded || !Number.isInteger(recorded.pid)) return false;
  const table = readPosixProcessTableSync();
  if (!table) throw new Error("The process table could not be read; a Stop cannot be called proven.");
  const row = table.get(recorded.pid);
  return Boolean(row && row.startedAt === recorded.startedAt);
}

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
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const sitePort = site.address().port;
  log("site https://127.0.0.1:" + sitePort);

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
  const startMachine = () => {
    const child = spawn(process.execPath, [
      path.join(repoRoot, "dist/machine/accordagents-machine.cjs"),
      "--enrollment", enrollmentPath, "--user-data", machineUserData, "--name", "Machine one"
    ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ACCORD_AGENTS_DEBUG_LOGS: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
    child.stdout.on("data", (chunk) => machineOutput.push(String(chunk)));
    child.stderr.on("data", (chunk) => machineOutput.push(String(chunk)));
    spawned.add(child);
    return child;
  };
  let machineChild = startMachine();

  const profile = await mkdtemp(path.join(tmpdir(), "aa-phone-e2e-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--window-size=430,860", `https://127.0.0.1:${sitePort}/?qa=1`
  ], { stdio: "ignore" });
  spawned.add(chrome);

  let app;
  let attachError;
  let cdpPort;
  for (let attempt = 0; attempt < 60 && !app; attempt += 1) {
    try {
      cdpPort = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      app = await attach({ port: cdpPort, title: "AccordAgents" });
    }
    catch (error) { attachError = error; await wait(500); }
  }
  if (!app) {
    const targets = cdpPort ? await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json()).catch(() => []) : [];
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
      endpoint: "https://127.0.0.1:${sitePort}/",
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
  app = await attach({ port: cdpPort, title: "AccordAgents" });

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
        fingerprint: pairing.fingerprint
      })}] });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  })()`);
  await evaluate("location.reload()");
  await wait(3000);
  app = await attach({ port: cdpPort, title: "AccordAgents" });

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

  /**
   * What the member said on this phone, from the phone's own store.
   *
   * Reading the whole screen was wrong and hid the defect this found: the
   * User's own prompt contains the token being looked for, so every check
   * passed whether or not the machine's answer ever arrived.
   */
  const participantSaid = async (token) => evaluate(`(async () => {
    const TOKEN_PLACEHOLDER = ${JSON.stringify(token)};
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("accordagents-mobile-control");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise((resolve) => {
      const tx = db.transaction("timeline", "readonly");
      const all = tx.objectStore("timeline").getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => resolve([]);
    });
    db.close();
    return rows.some((row) => row.role === "participant" && String(row.content || "").includes(TOKEN_PLACEHOLDER));
  })()`);
  const reply = async () => evaluate(`(() => {
    const list = document.getElementById("message-list");
    return list ? list.innerText : "";
  })()`);
  await waitFor(() => participantSaid("PHONE_MACHINE_EXECUTED"), 180_000,
    "the machine's real answer to be stored on the phone as the member's own message");
  // And rendered, not only stored.
  await waitFor(async () => evaluate(`[...document.querySelectorAll("#message-list > *")]
    .some((item) => (item.innerText || "").includes("PHONE_MACHINE_EXECUTED") && !(item.innerText || "").includes("Reply with exactly"))`),
    30_000, "the member's answer to be a row of its own on the phone");
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
  app = await attach({ port: cdpPort, title: "AccordAgents" });
  await waitFor(() => participantSaid("PHONE_MACHINE_EXECUTED"), 30_000, "the answer to survive a reload");
  await wait(4000);
  const runsAfter = await runCount();
  assert.equal(runsAfter, runsBefore, "a reload must not run the member again");
  log("reload kept the answer and ran nothing twice");

  // --- 3. Stop, typed on the phone, ends the run on the machine -------------
  //
  // Nothing here is optional. A Stop control that never appears, a machine
  // that never confirms, a terminal the phone does not keep, an unacknowledged
  // command or a provider process still alive is a failure, not a note.
  await evaluate(`(() => {
    const input = document.getElementById("composer-input");
    input.value = ${JSON.stringify("@one Start your response with PHONE_STOP_STARTED, then print the numbers from 1 to 500, one per line. Print them directly; no tools or explanation.")};
    document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  })()`);
  await waitFor(async () => (await runCount()) > runsAfter, 120_000, "the second turn to start on the machine");
  log("second turn is running on the machine");

  // The member has to be visibly working on the phone before Stop means
  // anything: a control offered for a run that never streamed proves nothing.
  const screen = async () => evaluate(`(() => {
    const list = document.getElementById("message-list");
    return list ? list.innerText : "";
  })()`);
  await waitFor(() => participantSaid("PHONE_STOP_STARTED"), 240_000,
    "the member's own streamed text to reach the phone before Stop");
  log("streamed output is on the phone's screen");

  const stopRunId = await (async () => {
    let found = null;
    for (let attempt = 0; attempt < 120 && !found; attempt += 1) {
      // Clicked and read back in one go: what the row says the instant the
      // User taps is the claim being checked, and a re-render between two
      // round trips would hide it.
      found = await evaluate(`(() => {
        const button = document.querySelector("#message-list .message-stop");
        if (!button || button.disabled) return null;
        const runId = button.dataset.runId || "";
        button.click();
        const after = document.querySelector("#message-list .message-stop");
        return JSON.stringify({ runId: runId, text: after ? after.innerText : "", disabled: after ? after.disabled : null });
      })()`);
      if (!found) await wait(1000);
    }
    return found;
  })();
  assert.ok(stopRunId, "no Stop control was offered for a member that was visibly running");
  const tapped = JSON.parse(stopRunId);
  log("Stop tapped for", tapped.runId);

  // Sent is not stopped. The row says the Stop is on its way, and does not
  // offer to send it again while it is.
  assert.match(tapped.text, /Stopping/, "the row must say the Stop is being delivered, not that it is done");
  assert.equal(tapped.disabled, true, "and must not offer the same Stop again while it is being delivered");

  await waitFor(async () => (await machineLog(machineUserData, machineOutput)).includes("machine.turn.cancel"), 60_000,
    "the machine to receive the phone's Stop");
  log("the machine received the phone's Stop");

  // The machine's own record: the run finished, and its provider process and
  // every descendant it claimed are closed.
  const query = (db, sql) => {
    try { return JSON.parse(execFileSync("sqlite3", ["-json", path.join(machineUserData, db), sql], { encoding: "utf8" }) || "[]"); }
    catch { return []; }
  };
  await waitFor(() => query("accordagents.sqlite3", `select run_id,phase from native_commands where run_id=${sqlText(tapped.runId)};`)
    .some((row) => row.phase === "finished"), 120_000, "the machine to finish the stopped run");
  // The guardian closes the lease once the process is actually gone, which is
  // shortly after the run is marked finished. Bounded, because "eventually" is
  // not a closure: if it never closes, the Stop is not proven.
  const leaseRows = () => query("native-processes.sqlite3", "select scope,phase,receipt from native_provider_processes;");
  try {
    await waitFor(() => { const rows = leaseRows(); return rows.length > 0 && rows.every((row) => row.phase === "closed"); },
      90_000, "the machine's provider leases to close after Stop");
  } catch (error) {
    console.error("[phone-e2e] leases:", JSON.stringify(leaseRows().map((row) => ({ scope: row.scope, phase: row.phase }))));
    throw error;
  }
  const leases = leaseRows();
  assert.ok(leases.length > 0, "the machine recorded no provider process at all");
  // And in the operating system, not only in the record.
  for (const lease of leases) {
    const receipt = JSON.parse(lease.receipt || "{}");
    for (const process of [receipt.provider, ...(receipt.descendants || [])].filter(Boolean)) {
      assert.equal(processStillRunning(process), false,
        `a provider process from the stopped run is still alive: ${JSON.stringify(process)}`);
    }
  }
  log("the machine's provider processes and descendants are gone");

  // The phone kept the outcome, and owes the machine nothing for it.
  await waitFor(async () => {
    const text = await screen();
    return /Stopped|stopped/.test(text);
  }, 60_000, "the phone to show that the run was stopped");
  await waitFor(async () => (await owed()) === 0, 60_000, "the phone's Stop to be acknowledged and drained");
  log("the stop is acknowledged and nothing is owed");

  // A reload must not resurrect a control for a run that has ended.
  await evaluate("location.reload()");
  await wait(3000);
  app = await attach({ port: cdpPort, title: "AccordAgents" });
  await waitFor(async () => (await screen()).length > 0, 30_000, "the phone to come back after the reload");
  const revived = await evaluate(`document.querySelectorAll("#message-list .message-stop:not([disabled])").length`);
  assert.equal(revived, 0, "a finished run must not be offered for stopping again after a reload");
  const runsAfterStop = await runCount();

  // A dropped connection and a machine restart must not re-run it either.
  await evaluate(`(() => { window.dispatchEvent(new Event("offline")); return true; })()`);
  machineChild.kill("SIGTERM");
  await wait(2000);
  machineChild = startMachine();
  await waitFor(async () => (await machineLog(machineUserData, machineOutput)).includes("machine-host.trust.applied") ||
    (await machineLog(machineUserData, machineOutput)).includes("machine.hello"), 60_000, "the machine to come back");
  await evaluate(`(() => { window.dispatchEvent(new Event("online")); return true; })()`);
  await wait(8000);
  assert.equal(await runCount(), runsAfterStop, "a restart must not run the stopped turn again");
  log("machine restart replayed nothing");

  // --- 4. A reply too large for one event, through the phone's own store ---
  //
  // Anything over 32 KiB travels as a reference plus fragments. The phone has
  // to keep those in IndexedDB, put them back together, check the whole body
  // against the hash the event claims, and only then apply it. A body that is
  // incomplete must not be acknowledged, or the machine would drop what the
  // phone cannot read.
  // A long paste, both ways. Past one fragment, so the phone has to take a
  // body apart to send it and put one back together to read it, keeping the
  // pieces in its own IndexedDB in between and checking the whole thing
  // against the hash the event claims before applying it.
  const longBody = "LONGBODY ".repeat(100_000) + "LONGBODY_END";
  assert.ok(longBody.length > 800 * 1024, "the check needs a body that takes several fragments");
  await evaluate(`(() => {
    const input = document.getElementById("composer-input");
    input.value = ${JSON.stringify(longBody)};
    document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  })()`);
  const longRowBytes = async () => evaluate(`(async () => {
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
    const timeline = await read("timeline");
    const blobs = await read("machineBlobs");
    db.close();
    const held = timeline.filter((row) => String(row.content || "").includes("LONGBODY_END"))
      .sort((left, right) => String(right.content || "").length - String(left.content || "").length)[0];
    return JSON.stringify({ bytes: held ? String(held.content || "").length : 0, heldFragments: blobs.length });
  })()`);
  // Sent as fragments: the phone kept them while the event was unacknowledged.
  await waitFor(async () => JSON.parse(await longRowBytes()).heldFragments > 1, 120_000,
    "the phone to hold the body it is sending as more than one fragment");
  log("the phone split the paste into", JSON.parse(await longRowBytes()).heldFragments, "fragments to send it");
  await waitFor(async () => JSON.parse(await longRowBytes()).bytes > 800 * 1024, 300_000,
    "the whole long body to come back through the phone's fragment store");
  const longRow = JSON.parse(await longRowBytes());
  await waitFor(async () => (await owed()) === 0, 90_000, "the long message to be fully acknowledged");
  // The same body went out and came back, so one set of bytes is named by two
  // events. They are kept while either still needs them -- deleting them on
  // the first acknowledgement is what used to lose a body still being applied
  // -- and released when the last reference is gone.
  await waitFor(async () => JSON.parse(await longRowBytes()).heldFragments === 0, 120_000,
    "the fragments to be released once no event still names them");
  log("a", longRow.bytes, "byte body came back through the phone's fragment store, was applied, and its fragments released");

  // A second tab over the same storage, and a reload: neither re-runs held work.
  const runsBeforeTab = await runCount();
  await app.send("Target.createTarget", { url: `https://127.0.0.1:${sitePort}/?qa=1` });
  await wait(6000);
  assert.equal(await runCount(), runsBeforeTab, "a second tab must not re-run anything the first one holds");
  log("a second tab ran nothing again");

  // --- 5. A permission the member asks for, answered on the phone ----------
  //
  // The member runs in a read-only sandbox, so writing a file is something it
  // has to ask for. With the desktop closed there is nobody else to ask.
  const approvalRuns = await runCount();
  await evaluate(`(() => {
    const input = document.getElementById("composer-input");
    input.value = ${JSON.stringify("@one Create a file called phone-approval-qa.txt containing the single word hello, in the current working directory. Do it now.")};
    document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  })()`);
  await waitFor(async () => (await runCount()) > approvalRuns, 120_000, "the permission turn to reach the machine");
  const card = async () => evaluate(`(() => {
    const host = document.getElementById("control-cards");
    const first = host && host.querySelector(".control-card");
    if (!first) return "";
    return JSON.stringify({
      id: first.dataset.cardId, kind: first.dataset.cardKind,
      text: (first.innerText || "").replace(/\\s+/g, " ").slice(0, 120),
      options: [...first.querySelectorAll("[data-option-id]")].map((button) => button.dataset.optionId)
    });
  })()`);
  let raised = "";
  for (let attempt = 0; attempt < 240 && !raised; attempt += 1) {
    raised = await card();
    if (!raised) await wait(1000);
  }
  let approvalProven = false;
  if (raised) {
    const shown = JSON.parse(raised);
    log("the member asked for permission on the phone:", shown.text);
    assert.ok(shown.options.length > 0, "a permission card with no options is a card the User cannot answer");
    const tapped = await evaluate(`(() => {
      const host = document.getElementById("control-cards");
      const allow = host.querySelector('[data-option-id="allow"]') || host.querySelector("[data-option-id]");
      if (!allow) return false;
      allow.click();
      return true;
    })()`);
    assert.ok(tapped, "the card offered nothing to tap");
    // Sent is not applied. The card states that it has handed the answer over
    // and is waiting, and never claims the member was told.
    let state = "";
    for (let attempt = 0; attempt < 60 && !/[Ss]ent|[Ww]aiting/.test(state); attempt += 1) {
      state = await evaluate(`(() => {
        const held = document.querySelector("#control-cards .control-card-state");
        return held ? held.innerText : "";
      })()`);
      if (!/[Ss]ent|[Ww]aiting/.test(state)) await wait(500);
    }
    assert.match(state, /[Ss]ent|[Ww]aiting/, `the card must say the answer was sent and is waiting: ${state}`);
    assert.doesNotMatch(state, /applied|approved|answered/i,
      "and must not claim the member was told before the machine says so");
    await waitFor(async () => (await machineLog(machineUserData, machineOutput)).includes("permission.decided"), 120_000,
      "the machine to receive the phone's permission answer");
    log("the machine applied the phone's permission answer");
    approvalProven = true;
  } else {
    log("NOT PROVEN: the member never asked for permission in this run; the card path was not exercised");
  }

  // --- 5b. A choice the member asks, answered on the phone -----------------
  //
  // A member raises a choice by writing one in its own message, so this is the
  // real path: the machine's member asks, the machine's copy holds the pending
  // choice, and the phone is the only place there is to answer it.
  const choiceRuns = await runCount();
  await evaluate(`(() => {
    const input = document.getElementById("composer-input");
    input.value = ${JSON.stringify([
      "@one End your reply with exactly these three lines, as plain text, not inside a code block",
      "and with nothing after them. When I later answer, reply exactly CHOICE_NATIVE_ORCHID:",
      "user choice: Which colour?",
      "O1: Orchid",
      "O2: Indigo"
    ].join("\n"))};
    document.getElementById("composer-form").dispatchEvent(new Event("submit", { cancelable: true }));
    return true;
  })()`);
  await waitFor(async () => (await runCount()) > choiceRuns, 120_000, "the choice turn to reach the machine");
  let choiceCard = "";
  for (let attempt = 0; attempt < 240 && !choiceCard; attempt += 1) {
    choiceCard = await evaluate(`(() => {
      const held = [...document.querySelectorAll("#control-cards .control-card")]
        .find((item) => item.dataset.cardKind === "choice");
      if (!held) return "";
      return JSON.stringify({ id: held.dataset.cardId,
        text: (held.innerText || "").replace(/\\s+/g, " ").slice(0, 100),
        options: [...held.querySelectorAll("[data-option-id]")].map((button) => button.dataset.optionId) });
    })()`);
    if (!choiceCard) await wait(1000);
  }
  let choiceProven = false;
  if (choiceCard) {
    const shown = JSON.parse(choiceCard);
    log("the member asked a choice on the phone:", shown.text);
    assert.ok(shown.options.length >= 2, "a choice with no options is a question the User cannot answer");
    await evaluate(`(() => {
      const held = [...document.querySelectorAll("#control-cards .control-card")]
        .find((item) => item.dataset.cardKind === "choice");
      held.querySelector("[data-option-id]").click();
      return true;
    })()`);
    // The proof is the row the answer had to claim before it could reach the
    // member, not a line in a log: that row is the admission itself.
    await waitFor(() => query("accordagents.sqlite3",
      "select approval_id from native_approval_effects where approval_id like 'choice:%';").length > 0,
      120_000, "the machine to admit the phone's choice answer at its durable boundary");
    const claims = query("accordagents.sqlite3",
      "select approval_id as approvalId, runtime_id as runtimeId from native_approval_effects where approval_id like 'choice:%';");
    assert.equal(claims.length, 1, "one answer, one claim");
    // Admission alone precedes validation/dispatch in old builds and cannot
    // prove the choice resumed a provider. Require its saved selection, a
    // non-uncertain receipt and the provider's new answer after this tap.
    await waitFor(() => query("accordagents.sqlite3", `select message_id from conversation_messages
      where conversation_id=${sqlText(CONVERSATION)}
        and json_extract(payload_json, '$.metadata.pendingChoice.id')=${sqlText(shown.id)}
        and json_extract(payload_json, '$.metadata.pendingChoice.status')='answered';`).length === 1,
      120_000, "the chosen option to be saved by its home machine");
    await waitFor(() => query("accordagents.sqlite3", `select event_id from chat_events
      where event_id=${sqlText("chat-action:receipt:" + claims[0].approvalId)}
        and coalesce(json_extract(payload_json, '$.uncertain'), 0)=0;`).length === 1,
      120_000, "the machine's confirmed choice execution receipt");
    await waitFor(() => query("accordagents.sqlite3", `select message_id from conversation_messages
      where conversation_id=${sqlText(CONVERSATION)}
        and json_extract(payload_json, '$.role')='participant'
        and json_extract(payload_json, '$.content') like '%CHOICE_NATIVE_ORCHID%'
        and json_extract(payload_json, '$.metadata.pendingChoice.id') is null;`).length > 0,
      120_000, "the provider's new response after applying the phone's choice");
    log("the machine saved and applied the phone's choice answer:", claims[0].approvalId);
    choiceProven = true;
  } else {
    // Say what the member actually wrote, so this is diagnosable rather than
    // just absent.
    const said = await evaluate(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("accordagents-mobile-control");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve) => {
        const tx = db.transaction("timeline", "readonly");
        const all = tx.objectStore("timeline").getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => resolve([]);
      });
      db.close();
      const last = rows.filter((row) => row.role === "participant").slice(-1)[0];
      return last ? String(last.content || "").slice(-300) : "(no participant row)";
    })()`);
    log("NOT PROVEN: the member did not raise a choice. Its last words were:", JSON.stringify(said));
  }

  // --- 6. The desktop comes back and learns what happened without it -------
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

  assert.ok(approvalProven, "the machine-raised permission card was not exercised");
  assert.ok(choiceProven, "the machine-raised choice card was not exercised");
  assert.ok(learned, "the returning desktop did not receive the phone's message");
  log("PASS - phone turn, acknowledgement, reload, Stop, permission and choice with the desktop closed");
  if (!learned) log("REMAINDER: the returning desktop did not pick up the phone's message in this run");
  machineChild.kill("SIGTERM");
  chrome.kill("SIGTERM");
  await relay.close();
  await new Promise((resolve) => site.close(resolve));
  await wait(500);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  return { learned, approvalProven, choiceProven };
}

main().then((result) => {
  stopSpawned();
  if (!result.approvalProven) console.error("[phone-e2e] REMAINDER: the machine-raised permission card was not exercised");
  if (!result.choiceProven) console.error("[phone-e2e] REMAINDER: the machine-raised choice card was not exercised");
  process.exit(result.learned ? 0 : 2);
}).catch((error) => {
  console.error("[phone-e2e] FAILED", error);
  stopSpawned();
  process.exit(1);
});
