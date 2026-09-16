/**
 * A choice raised by a member that lives on a machine, answered from another
 * device while the owner's desktop is connected.
 *
 * This is the configuration the User hit and the one no existing check covers:
 * the phone-machine e2e proves the path with the desktop CLOSED, where the
 * phone commands the machine directly. With the desktop present the answer
 * takes the desktop route instead -- published as a chat action and forwarded
 * over the machine link -- and that is what is exercised here.
 *
 * Real: a reference relay, the built machine runtime as its own process, the
 * desktop's own MachineLinkService, storage and event log. Replaced: the
 * Electron shell (the same wiring is constructed here) and the browser, so
 * this is a transport/ownership check, not a phone UI check.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const { createReferenceRelayServer } = require(path.join(repoRoot, "scripts/relay-reference-server.cjs"));
const { MachineLinkService } = require(path.join(repoRoot, "dist/main/main/services/machineLink.js"));
const { StorageService } = require(path.join(repoRoot, "dist/main/main/services/storage.js"));
const { ChatEventLogService } = require(path.join(repoRoot, "dist/main/main/services/chatEventLog.js"));

const CONVERSATION = "cloud-choice-repro";
const MACHINE_ID = "machine-one";
const ROOM = "room-choice-repro";
const PARTICIPANT_ID = "p-one";
const CHOICE_ID = "choice-repro-1";
const CHOICE_MESSAGE_ID = "m-choice-1";

const spawned = new Set();
function stopSpawned() {
  for (const child of spawned) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  spawned.clear();
}
process.on("exit", stopSpawned);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopSpawned(); process.exit(1); });

const log = (...args) => console.log("[choice-repro]", ...args);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await wait(250);
  }
}

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
      settingsJson: JSON.stringify({ chatRoleConfigs: [{ id: "engineer", label: "Choice QA", version: 1,
        instructions: "Isolated transport verification.", updatedAt: "2026-09-07T00:00:00Z" }] }),
      agentEnvironment: []
    })
  };
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "accord-choice-repro-"));
  const relay = createReferenceRelayServer({});
  const address = await relay.listen();
  log("relay", address.url);

  const ownerStorage = new StorageService({ dbPath: path.join(dir, "owner.sqlite3") });
  const ownerLog = new ChatEventLogService(ownerStorage);
  const owner = await ownerLog.getOrCreateDeviceIdentity();
  const pairing = {
    version: 1, purpose: "machine-host",
    issuer: { originId: owner.originId, keyId: owner.keyId, publicKeyDerBase64: owner.publicKeyDerBase64 },
    rendezvousId: ROOM, stableRoutingId: "route-choice-repro",
    relaySealKeyBase64: Buffer.alloc(32, 43).toString("base64url"),
    relayUrl: address.url,
    capabilities: [{ scope: "device", canRead: true, canWrite: true, canRunCloudParticipants: true, canListConversations: true }],
    fingerprint: "CHOICE-REPRO", createdAt: new Date().toISOString(),
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
  ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ACCORD_AGENTS_DEBUG_LOGS: "1" } });
  machineChild.stdout.on("data", (chunk) => machineOutput.push(String(chunk)));
  machineChild.stderr.on("data", (chunk) => machineOutput.push(String(chunk)));
  spawned.add(machineChild);

  const ownerLink = new MachineLinkService(desktopSettings(records, pairings), { write: async () => undefined }, {
    eventStorage: ownerStorage, eventLog: ownerLog, appVersion: "choice-repro",
    desktopDeviceId: owner.originId, reconnectDelayMs: 50,
    trustedDevices: async () => []
  });
  await ownerLink.start();

  if (!await waitFor(() => ownerLink.isMachineConnected(MACHINE_ID), 90_000, "machine connection")) {
    console.error("[choice-repro] machine output:", machineOutput.join("").split("\n").slice(-25).join("\n"));
    throw new Error("the desktop never reached the machine");
  }
  log("machine connected");
  assert.ok(await waitFor(() => Boolean(records[0].deviceId), 60_000), "the machine never introduced itself");

  // The chat as both sides hold it: one member whose home is the machine, and
  // the question that member asked, still waiting for an answer.
  const participant = { id: PARTICIPANT_ID, handle: "one", kind: "codex-cli", roleConfigId: "engineer", homeMachineId: MACHINE_ID };
  const now = new Date().toISOString();
  const conversation = {
    id: CONVERSATION, kind: "chat", title: "Choice repro",
    createdAt: now, updatedAt: now,
    messages: [
      { id: "seed-1", role: "user", content: "Setting up.", status: "done", createdAt: now },
      {
        id: CHOICE_MESSAGE_ID, role: "participant", participantId: PARTICIPANT_ID, participantHandle: "one",
        content: "I need one decision before I continue.", status: "done", createdAt: now,
        metadata: {
          pendingChoice: {
            id: CHOICE_ID, title: "Investment horizon", question: "Which horizon?",
            options: [{ id: "o1", label: "Long term" }, { id: "o2", label: "Short term" }],
            status: "pending"
          }
        }
      }
    ],
    findings: [], metadata: { participants: [participant] }
  };
  await ownerLink.replicateConversation(conversation);
  await ownerStorage.saveConversation(conversation);

  const machineQuery = (db, sql) => {
    try { return JSON.parse(execFileSync("sqlite3", ["-json", path.join(machineUserData, db), sql], { encoding: "utf8" }) || "[]"); }
    catch (error) { return [{ error: String(error && error.message || error).slice(0, 200) }]; }
  };
  const machineHasChoice = () => {
    const rows = machineQuery("accordagents.sqlite3",
      `select payload_json as payload from conversation_messages where conversation_id='${CONVERSATION}';`);
    return rows.some((row) => typeof row.payload === "string" && row.payload.includes(CHOICE_ID));
  };
  if (!await waitFor(machineHasChoice, 90_000)) {
    console.error("[choice-repro] machine tail:", (await machineLog(machineUserData, machineOutput)).split("\n").slice(-25).join("\n"));
    console.error("[choice-repro] machine conversations:", JSON.stringify(machineQuery("accordagents.sqlite3",
      "select id from conversations;")));
    throw new Error("the machine never received the chat carrying the pending choice");
  }
  log("the machine holds the pending choice");

  // Exactly what main.ts does for an answer that arrives from a phone:
  // publishChatAction, then apply locally. Nothing here is a shortcut for the
  // machine's side -- it receives the same signed event the desktop sends.
  const operationId = `choice:${CHOICE_ID}:o1`;
  const request = {
    conversationId: CONVERSATION,
    kind: "choice.answered",
    payload: {
      operationId,
      targetKey: `choice:${CHOICE_ID}`,
      stateId: "o1",
      detail: { sourceMessageId: CHOICE_MESSAGE_ID, selectedOptionId: "o1" }
    },
    eventId: `chat-action:${operationId}`
  };
  const published = await ownerLink.publishChatAction(request);
  log("published to", published, "machine(s)");
  assert.equal(published, 1, "the desktop did not forward the answer to the machine at all");

  const recorded = await ownerStorage.getChatEvent(request.eventId);
  assert.ok(recorded, "the answer was not recorded as a durable event on the desktop");
  log("recorded on the desktop as", recorded.eventId);

  // The machine's own record is the proof: it must apply the answer to the
  // member that raised it.
  const applied = await waitFor(async () => {
    const text = await machineLog(machineUserData, machineOutput);
    return /machine-host\.action\.applied/.test(text) && text.includes(CHOICE_ID);
  }, 90_000);

  const text = await machineLog(machineUserData, machineOutput);
  const interesting = text.split("\n").filter((line) =>
    /choice|action|chat-action|owns|deferred|unshown/i.test(line)).slice(-25).join("\n");
  log("machine lines:\n" + interesting);

  
  log("machine chat_events:", JSON.stringify(machineQuery("accordagents.sqlite3",
    "select kind, log_scope_id, event_id from chat_events order by rowid desc limit 12;")));
  const stored = machineQuery("accordagents.sqlite3",
    `select json_extract(payload_json,'$.metadata') as meta from conversation_messages where message_id='${CHOICE_MESSAGE_ID}';`);
  log("machine's copy of the choice:", JSON.stringify(stored));

  assert.ok(applied, "the machine never applied the answer to the choice its own member raised");
  log("PASS: the machine applied the answer");
}

main().then(() => { stopSpawned(); process.exit(0); })
  .catch((error) => { console.error("[choice-repro] FAILED:", error.message); stopSpawned(); process.exit(1); });
