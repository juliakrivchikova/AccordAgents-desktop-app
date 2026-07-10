import { createHash } from "node:crypto";

import type { CodexExecOptions } from "./codexExec";
import type { ParticipantConfig } from "../../shared/types";

export const REMOTE_SESSION_PROTOCOL_VERSION = 3;
export const REMOTE_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
export const REMOTE_STOP_DRAIN_LEASE_MS = 30_000;
export const REMOTE_STOP_DRAIN_SHUTDOWN_LEASE_MS = 5 * 60_000;
export const REMOTE_OPERATION_LEASE_MS = 30_000;

export function remoteWorkerOperationLeaseShellScript(): string {
  return String.raw`set -eu
root=$1
action=$2
lease_id=$3
owner_id=$4
kind=$5
ttl_ms=$6

case "$lease_id:$owner_id:$kind" in
  *[!A-Za-z0-9._:-]*) printf '%s' '{"ok":false,"status":"invalid-lease-identity"}'; exit 2 ;;
esac

operations_dir="$root/operations"
drain_path="$root/drain.json"
mkdir -p "$operations_dir"
boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)
boot_id=$(printf '%s' "$boot_id" | tr -cd 'A-Za-z0-9._:-')
[ -n "$boot_id" ] || boot_id=unknown

iso_epoch() {
  normalized=$(printf '%s' "$1" | sed 's/\.[0-9][0-9]*Z$/Z/')
  date -u -d "$normalized" +%s 2>/dev/null ||
    date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$normalized" +%s 2>/dev/null ||
    printf 0
}

epoch_iso() {
  date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null ||
    date -u -r "$1" '+%Y-%m-%dT%H:%M:%SZ'
}

drain_is_valid() {
  [ -f "$drain_path" ] || return 1
  drain_boot=$(sed -n 's/.*"bootId":"\([^"]*\)".*/\1/p' "$drain_path" | head -n 1)
  [ -n "$drain_boot" ] || return 0
  [ "$drain_boot" = "$boot_id" ] || return 1
  drain_expires=$(sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p' "$drain_path" | head -n 1)
  [ -n "$drain_expires" ] || return 0
  drain_epoch=$(iso_epoch "$drain_expires")
  [ "$drain_epoch" -gt "$(date +%s)" ]
}

lease_path="$operations_dir/$lease_id.json"
if [ "$action" = release ]; then
  if [ -f "$lease_path" ] && grep -Fq "\"leaseId\":\"$lease_id\"" "$lease_path" && grep -Fq "\"ownerId\":\"$owner_id\"" "$lease_path"; then
    rm -f "$lease_path"
  fi
  printf '%s' '{"ok":true,"status":"released"}'
  exit 0
fi

if drain_is_valid; then
  printf '%s' '{"ok":false,"status":"draining"}'
  exit 4
fi

if [ "$action" = renew ]; then
  if [ ! -f "$lease_path" ] || ! grep -Fq "\"leaseId\":\"$lease_id\"" "$lease_path" || ! grep -Fq "\"ownerId\":\"$owner_id\"" "$lease_path"; then
    printf '%s' '{"ok":false,"status":"lease-missing"}'
    exit 10
  fi
elif [ "$action" != acquire ]; then
  printf '%s' '{"ok":false,"status":"unknown-action"}'
  exit 2
fi

now_epoch=$(date +%s)
ttl_seconds=$(( (ttl_ms + 999) / 1000 ))
[ "$ttl_seconds" -ge 5 ] || ttl_seconds=5
issued_at=$(epoch_iso "$now_epoch")
expires_at=$(epoch_iso $((now_epoch + ttl_seconds)))
lease_json=$(printf '{"leaseId":"%s","ownerId":"%s","kind":"%s","bootId":"%s","issuedAt":"%s","expiresAt":"%s"}' "$lease_id" "$owner_id" "$kind" "$boot_id" "$issued_at" "$expires_at")
tmp_path="$lease_path.$$.tmp"
umask 077
printf '%s' "$lease_json" > "$tmp_path"
mv -f "$tmp_path" "$lease_path"

if drain_is_valid; then
  rm -f "$lease_path"
  printf '%s' '{"ok":false,"status":"draining"}'
  exit 4
fi

status=acquired
[ "$action" = renew ] && status=renewed
printf '{"ok":true,"status":"%s","lease":%s}' "$status" "$lease_json"
`;
}

export function remoteParticipantSessionKey(conversationId: string, participantId: string): string {
  return createHash("sha256")
    .update(conversationId)
    .update("\0")
    .update(participantId)
    .digest("hex")
    .slice(0, 32);
}

export function remoteParticipantRuntimeFingerprint(input: {
  participant: ParticipantConfig;
  repoPath?: string;
  kind?: string;
  options?: CodexExecOptions;
  codexPath?: string;
}): string {
  const options = input.options ?? {};
  const environment = Object.entries(options.extraEnv ?? {})
    .filter(([key]) => key !== "ACCORD_AGENTS_MCP_TOKEN")
    .sort(([left], [right]) => left.localeCompare(right));
  const stable = {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    participant: {
      kind: input.participant.kind,
      model: input.participant.model,
      reasoningEffort: input.participant.reasoningEffort
    },
    repoPath: input.repoPath,
    kind: input.kind,
    codexPath: input.codexPath,
    role: options.role?.instructions,
    agentMode: options.agentMode,
    permissions: options.permissions,
    environment
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function recoverableLockHelpers(): string {
  return String.raw`
function lockBootId() {
  try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return "unknown"; }
}
function lockSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function processStartIdentity(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0 || process.platform !== "linux") { return undefined; }
  try {
    const stat = fs.readFileSync("/proc/" + Number(pid) + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    return stat.slice(close + 2).split(" ")[19];
  } catch { return undefined; }
}
function processAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) { return false; }
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function readLockJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } }
function writeLockJsonAtomic(file, value) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
function lockOwnerAlive(owner) {
  if (!owner || owner.bootId !== lockBootId() || !processAlive(Number(owner.pid))) { return false; }
  const currentStart = processStartIdentity(Number(owner.pid));
  return !owner.processStartIdentity || !currentStart || owner.processStartIdentity === currentStart;
}
function lockStatIdentity(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    return { dev: String(stat.dev), ino: String(stat.ino), ctimeMs: String(stat.ctimeMs) };
  } catch { return undefined; }
}
function staleLockObservation(lockPath) {
  const owner = readLockJson(path.join(lockPath, "owner.json"));
  const stat = lockStatIdentity(lockPath);
  if (!stat) { return undefined; }
  if (owner) {
    if (owner.bootId === lockBootId() && lockOwnerAlive(owner)) { return undefined; }
  } else {
    try { if (Date.now() - fs.statSync(lockPath).mtimeMs <= 10000) { return undefined; } } catch { return undefined; }
  }
  const identity = crypto.createHash("sha256").update(JSON.stringify({ owner: owner || null, stat })).digest("hex");
  return { owner, stat, identity };
}
function sameLockObservation(lockPath, observation) {
  const stat = lockStatIdentity(lockPath);
  if (!stat || stat.dev !== observation.stat.dev || stat.ino !== observation.stat.ino || stat.ctimeMs !== observation.stat.ctimeMs) { return false; }
  const owner = readLockJson(path.join(lockPath, "owner.json"));
  return JSON.stringify(owner || null) === JSON.stringify(observation.owner || null);
}
function sweepPriorBootLockQuarantines(lockPath) {
  const parent = path.dirname(lockPath);
  const prefix = path.basename(lockPath) + ".reclaimed.";
  const currentBootToken = crypto.createHash("sha256").update(lockBootId()).digest("hex").slice(0, 16);
  let entries = [];
  try { entries = fs.readdirSync(parent); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) { continue; }
    const reclaimedBootToken = entry.slice(prefix.length).split(".")[0];
    if (reclaimedBootToken === currentBootToken) { continue; }
    const quarantine = path.join(parent, entry);
    try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch {}
  }
}
function quarantineStaleLock(lockPath, observation) {
  if (!sameLockObservation(lockPath, observation)) { return false; }
  const bootToken = crypto.createHash("sha256").update(lockBootId()).digest("hex").slice(0, 16);
  const quarantine = lockPath + ".reclaimed." + bootToken + "." + observation.identity;
  try {
    fs.renameSync(lockPath, quarantine);
    return true;
  } catch (error) {
    if (error && ["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) { return false; }
    throw error;
  }
}
function acquireRecoverableLock(lockPath, timeoutMs) {
  sweepPriorBootLockQuarantines(lockPath);
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    const owner = {
      ownerId: crypto.randomUUID(),
      pid: process.pid,
      processStartIdentity: processStartIdentity(process.pid),
      bootId: lockBootId(),
      acquiredAt: new Date().toISOString()
    };
    try {
      fs.mkdirSync(lockPath);
      writeLockJsonAtomic(path.join(lockPath, "owner.json"), owner);
      return { lockPath, ownerId: owner.ownerId };
    } catch (error) {
      if (!error || error.code !== "EEXIST") { throw error; }
      const observation = staleLockObservation(lockPath);
      if (observation && quarantineStaleLock(lockPath, observation)) {
        continue;
      }
    }
    if (Date.now() >= deadline) { break; }
    lockSleep(25);
  } while (true);
  return undefined;
}
function releaseRecoverableLock(lock) {
  if (!lock) { return; }
  const owner = readLockJson(path.join(lock.lockPath, "owner.json"));
  if (!owner || owner.ownerId !== lock.ownerId) { return; }
  try { fs.rmSync(lock.lockPath, { recursive: true, force: true }); } catch {}
}
`;
}

export function remoteSessionSupervisorScript(): string {
  return String.raw`const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");

const sessionDir = process.cwd();
const root = path.dirname(path.dirname(sessionDir));
const lifecycleLockDir = path.join(root, "lifecycle.lock");
const config = JSON.parse(fs.readFileSync("session-config.json", "utf8"));
const inboxDir = path.join(sessionDir, "inbox");
const ledgerPath = path.join(sessionDir, "ledger.json");
const statePath = path.join(sessionDir, "session-state.json");
let activeChild;
let activeRunId;
let activeRunDir;
let activeProcessCookie;
let queue = [];
let stopping = false;
let lastActivityAt = Date.now();

${recoverableLockHelpers()}

function now() { return new Date().toISOString(); }
function writeJsonAtomic(file, value) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function processGroupAlive(pgid) {
  if (!Number.isFinite(Number(pgid)) || Number(pgid) <= 0) { return false; }
  try { process.kill(-Number(pgid), 0); return true; } catch { return false; }
}
function pidFile(file) {
  try { return Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10); } catch { return undefined; }
}
function processMatches(pid, cookie) {
  if (!processAlive(pid)) { return false; }
  if (!cookie || process.platform !== "linux") { return true; }
  try {
    return fs.readFileSync("/proc/" + Number(pid) + "/environ", "utf8")
      .split("\0").includes("ACCORD_AGENTS_PROCESS_COOKIE=" + cookie);
  } catch { return false; }
}
function groupMatches(pgid, cookie) {
  if (!processGroupAlive(pgid)) { return false; }
  if (!cookie || process.platform !== "linux") { return true; }
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) { continue; }
    try {
      const stat = fs.readFileSync("/proc/" + entry + "/stat", "utf8");
      const close = stat.lastIndexOf(")");
      if (Number(stat.slice(close + 2).split(" ")[2]) !== Number(pgid)) { continue; }
      if (fs.readFileSync("/proc/" + entry + "/environ", "utf8")
        .split("\0").includes("ACCORD_AGENTS_PROCESS_COOKIE=" + cookie)) { return true; }
    } catch {}
  }
  return false;
}
function anyCookieProcess(cookie) {
  if (!cookie || process.platform !== "linux") { return false; }
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) { continue; }
      try {
        if (fs.readFileSync("/proc/" + entry + "/environ", "utf8")
          .split("\0").includes("ACCORD_AGENTS_PROCESS_COOKIE=" + cookie)) { return true; }
      } catch {}
    }
  } catch {}
  return false;
}
function ledger() { return readJson(ledgerPath, {}); }
function writeLedger(value) {
  const entries = Object.entries(value).slice(-1000);
  writeJsonAtomic(ledgerPath, Object.fromEntries(entries));
}
function inboxTurns() {
  let files = [];
  try { files = fs.readdirSync(inboxDir).filter((name) => name.endsWith(".json")); } catch { return []; }
  return files.flatMap((filename) => {
    const file = path.join(inboxDir, filename);
    try {
      const turn = JSON.parse(fs.readFileSync(file, "utf8"));
      return turn && typeof turn.runId === "string" && typeof turn.runDir === "string"
        ? [{ ...turn, inboxFile: file }]
        : [];
    } catch { return []; }
  }).sort((left, right) => Number(left.acceptanceSequence || 0) - Number(right.acceptanceSequence || 0));
}
function state(patch) {
  const previous = readJson(statePath, {});
  writeJsonAtomic(statePath, {
    ...previous,
    protocolVersion: config.protocolVersion,
    sessionKey: config.sessionKey,
    conversationId: config.conversationId,
    participantId: config.participantId,
    runtimeFingerprint: config.runtimeFingerprint,
    supervisorPid: process.pid,
    supervisorPgid: process.pid,
    processCookie: config.processCookie,
    status: activeRunId ? "running" : stopping ? "stopped" : "idle",
    accepting: !stopping,
    activeRunId,
    queuedRunIds: queue.map((item) => item.runId),
    lastActivityAt: new Date(lastActivityAt).toISOString(),
    heartbeat: now(),
    ...patch
  });
}
function runTerminal(runDir) {
  const runState = readJson(path.join(runDir, "state.json"), {});
  const exit = readJson(path.join(runDir, "exit.json"), {});
  return Boolean(exit.status) || Boolean(runState.status && runState.status !== "running" && runState.status !== "unknown");
}
function runWorkLive(runDir, cookie) {
  const runState = readJson(path.join(runDir, "state.json"), {});
  const wrapperPid = pidFile(path.join(runDir, "wrapper.pid"));
  return processMatches(wrapperPid, cookie) ||
    processMatches(Number(runState.pid), cookie) ||
    groupMatches(Number(runState.pgid), cookie) ||
    anyCookieProcess(cookie);
}
function terminalizeLaunchFailure(turn, message) {
  const completedAt = now();
  const runState = readJson(path.join(turn.runDir, "state.json"), {});
  writeJsonAtomic(path.join(turn.runDir, "exit.json"), {
    runId: turn.runId,
    status: "failed",
    error: message,
    completedAt
  });
  writeJsonAtomic(path.join(turn.runDir, "state.json"), {
    ...runState,
    runId: turn.runId,
    conversationId: config.conversationId,
    participantId: config.participantId,
    processCookie: turn.processCookie,
    status: "failed",
    error: message,
    completedAt,
    lastHeartbeat: completedAt
  });
  const next = ledger();
  next[turn.runId] = {
    ...(next[turn.runId] || {}),
    status: "failed",
    runDir: turn.runDir,
    processCookie: turn.processCookie,
    error: message,
    completedAt
  };
  writeLedger(next);
  try { fs.unlinkSync(turn.inboxFile); } catch {}
}
function clearActive(runState) {
  const next = ledger();
  if (activeRunId) {
    next[activeRunId] = {
      ...(next[activeRunId] || {}),
      status: runState.status || "completed",
      providerSessionId: runState.providerSessionId,
      completedAt: runState.completedAt || now()
    };
    writeLedger(next);
  }
  activeChild = undefined;
  activeRunId = undefined;
  activeRunDir = undefined;
  activeProcessCookie = undefined;
  lastActivityAt = Date.now();
  state({ providerSessionId: runState.providerSessionId, providerSessionValid: runState.providerSessionValid });
}
function reconcileActive() {
  if (!activeRunId || !activeRunDir) { return; }
  if (runWorkLive(activeRunDir, activeProcessCookie)) { return; }
  const runState = readJson(path.join(activeRunDir, "state.json"), {});
  if (runTerminal(activeRunDir)) {
    clearActive(runState);
    return;
  }
  const turn = {
    runId: activeRunId,
    runDir: activeRunDir,
    processCookie: activeProcessCookie,
    inboxFile: path.join(inboxDir, "turn-" + activeRunId + ".json")
  };
  terminalizeLaunchFailure(turn, "Remote run process exited without a terminal record.");
  clearActive(readJson(path.join(activeRunDir, "state.json"), {}));
}

fs.mkdirSync(inboxDir, { recursive: true });
for (const [runId, entry] of Object.entries(ledger())) {
  if (!entry || (entry.status !== "starting" && entry.status !== "running")) { continue; }
  const candidateDir = typeof entry.runDir === "string" ? entry.runDir : path.join(root, runId);
  const cookie = entry.processCookie || readJson(path.join(candidateDir, "invocation.json"), {}).processCookie;
  if (runWorkLive(candidateDir, cookie)) {
    activeRunId = runId;
    activeRunDir = candidateDir;
    activeProcessCookie = cookie;
    break;
  }
  if (!runTerminal(candidateDir)) {
    const inboxFile = path.join(inboxDir, "turn-" + runId + ".json");
    if (fs.existsSync(inboxFile)) {
      const next = ledger();
      next[runId] = { ...entry, status: "accepted" };
      writeLedger(next);
    } else {
      terminalizeLaunchFailure({
        runId,
        runDir: candidateDir,
        processCookie: cookie,
        inboxFile
      }, "Remote run launch was interrupted after its durable descriptor was consumed.");
    }
  }
}
state({ startedAt: now() });

function acceptInbox() {
  const accepted = ledger();
  for (const turn of inboxTurns()) {
    lastActivityAt = Date.now();
    if (activeRunId === turn.runId || queue.some((item) => item.runId === turn.runId)) { continue; }
    const existing = accepted[turn.runId];
    if (existing && ["completed", "failed", "cancelled"].includes(existing.status)) {
      try { fs.unlinkSync(turn.inboxFile); } catch {}
      continue;
    }
    if (existing && (existing.status === "starting" || existing.status === "running")) {
      if (runWorkLive(turn.runDir, turn.processCookie)) {
        if (!activeRunId) {
          activeRunId = turn.runId;
          activeRunDir = turn.runDir;
          activeProcessCookie = turn.processCookie;
        }
        continue;
      }
      accepted[turn.runId] = { ...existing, status: "accepted" };
    }
    accepted[turn.runId] = {
      ...(existing || {}),
      status: "accepted",
      acceptedAt: turn.acceptedAt || now(),
      acceptanceSequence: turn.acceptanceSequence,
      runDir: turn.runDir,
      processCookie: turn.processCookie
    };
    queue.push(turn);
  }
  writeLedger(accepted);
}

function startNext() {
  if (activeChild || activeRunId || stopping || queue.length === 0) { return; }
  const turn = queue.shift();
  activeRunId = turn.runId;
  activeRunDir = turn.runDir;
  activeProcessCookie = turn.processCookie;
  lastActivityAt = Date.now();
  const accepted = ledger();
  accepted[turn.runId] = {
    ...(accepted[turn.runId] || {}),
    status: "starting",
    runDir: turn.runDir,
    processCookie: turn.processCookie,
    startingAt: now()
  };
  writeLedger(accepted);
  let spawned = false;
  let child;
  try {
    child = cp.spawn(process.execPath, ["worker.js"], {
      cwd: turn.runDir,
      env: { ...process.env, ACCORD_AGENTS_PROCESS_COOKIE: turn.processCookie || "" },
      detached: true,
      stdio: "ignore"
    });
    activeChild = child;
    if (child.pid) { fs.writeFileSync(path.join(turn.runDir, "wrapper.pid"), String(child.pid)); }
    child.once("spawn", () => {
      spawned = true;
      const next = ledger();
      next[turn.runId] = {
        ...(next[turn.runId] || {}),
        status: "running",
        runDir: turn.runDir,
        processCookie: turn.processCookie,
        startedAt: now()
      };
      writeLedger(next);
      try { fs.unlinkSync(turn.inboxFile); } catch {}
      state({});
    });
    child.once("error", (error) => {
      if (!spawned) {
        terminalizeLaunchFailure(turn, error instanceof Error ? error.message : String(error));
        clearActive(readJson(path.join(turn.runDir, "state.json"), {}));
      }
    });
    child.once("exit", () => {
      if (activeChild === child) { activeChild = undefined; }
      reconcileActive();
    });
    child.unref();
    state({});
  } catch (error) {
    terminalizeLaunchFailure(turn, error instanceof Error ? error.message : String(error));
    clearActive(readJson(path.join(turn.runDir, "state.json"), {}));
  }
}

function idleExpired() {
  return !activeChild && !activeRunId && queue.length === 0 && inboxTurns().length === 0 &&
    Date.now() - lastActivityAt >= Math.max(1, Number(config.idleTimeoutMs));
}

const tick = setInterval(() => {
  state({});
  const lock = acquireRecoverableLock(lifecycleLockDir, 0);
  if (!lock) { return; }
  let exitAfterRelease = false;
  try {
    reconcileActive();
    acceptInbox();
    startNext();
    if (idleExpired()) {
      stopping = true;
      state({ status: "stopped", accepting: false, stoppedAt: now(), stopReason: "idle-timeout" });
      clearInterval(tick);
      exitAfterRelease = true;
    }
  } finally {
    releaseRecoverableLock(lock);
  }
  if (exitAfterRelease) { process.exit(0); }
}, 250);

process.on("SIGTERM", () => {
  const lock = acquireRecoverableLock(lifecycleLockDir, 5000);
  if (!lock) { return; }
  let exitAfterRelease = false;
  try {
    reconcileActive();
    acceptInbox();
    if (activeChild || activeRunId || queue.length > 0 || inboxTurns().length > 0) {
      state({ stopDeniedAt: now(), stopReason: "active-work" });
      return;
    }
    stopping = true;
    state({ status: "stopped", accepting: false, stoppedAt: now(), stopReason: "requested-idle-stop" });
    clearInterval(tick);
    exitAfterRelease = true;
  } finally {
    releaseRecoverableLock(lock);
  }
  if (exitAfterRelease) { process.exit(0); }
});
`;
}

export function remoteSessionControlScript(): string {
  return String.raw`const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const root = path.resolve(process.argv[2]);
const action = process.argv[3];
const payloadText = fs.readFileSync(0, "utf8").trim();
const payload = payloadText ? JSON.parse(payloadText) : {};
const lockDir = path.join(root, "lifecycle.lock");
const drainPath = path.join(root, "drain.json");
const operationsDir = path.join(root, "operations");

${recoverableLockHelpers()}

function now() { return new Date().toISOString(); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } }
function writeJsonAtomic(file, value) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
function output(value) { process.stdout.write(JSON.stringify(value)); }
function bootId() { return lockBootId(); }
function alive(pid) { return processAlive(pid); }
function pidFile(file) {
  try { return Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10); } catch { return undefined; }
}
function groupAlive(pgid) {
  if (!Number.isFinite(Number(pgid)) || Number(pgid) <= 0) { return false; }
  try { process.kill(-Number(pgid), 0); return true; } catch { return false; }
}
function listFiles(dir, suffix) {
  try { return fs.readdirSync(dir).filter((name) => !suffix || name.endsWith(suffix)); } catch { return []; }
}
function groupMatches(pgid, cookie) {
  if (!groupAlive(pgid)) { return false; }
  if (!cookie || process.platform !== "linux") { return true; }
  for (const entry of listFiles("/proc")) {
    if (!/^\d+$/.test(entry)) { continue; }
    try {
      const stat = fs.readFileSync(path.join("/proc", entry, "stat"), "utf8");
      const close = stat.lastIndexOf(")");
      if (Number(stat.slice(close + 2).split(" ")[2]) !== Number(pgid)) { continue; }
      if (fs.readFileSync(path.join("/proc", entry, "environ"), "utf8")
        .split("\0").includes("ACCORD_AGENTS_PROCESS_COOKIE=" + cookie)) { return true; }
    } catch {}
  }
  return false;
}
function processMatches(pid, cookie) {
  if (!alive(pid)) { return false; }
  if (!cookie || process.platform !== "linux") { return true; }
  try {
    return fs.readFileSync("/proc/" + Number(pid) + "/environ", "utf8")
      .split("\0").includes("ACCORD_AGENTS_PROCESS_COOKIE=" + cookie);
  } catch { return false; }
}
function anyCookieProcess(cookie) {
  if (!cookie || process.platform !== "linux") { return false; }
  for (const entry of listFiles("/proc")) {
    if (!/^\d+$/.test(entry)) { continue; }
    try {
      if (fs.readFileSync("/proc/" + entry + "/environ", "utf8")
        .split("\0").includes("ACCORD_AGENTS_PROCESS_COOKIE=" + cookie)) { return true; }
    } catch {}
  }
  return false;
}
function cookiePids(cookie) {
  if (!cookie || process.platform !== "linux") { return []; }
  const result = [];
  for (const entry of listFiles("/proc")) {
    if (!/^\d+$/.test(entry)) { continue; }
    try {
      if (fs.readFileSync("/proc/" + entry + "/environ", "utf8")
        .split("\0").includes("ACCORD_AGENTS_PROCESS_COOKIE=" + cookie)) { result.push(Number(entry)); }
    } catch {}
  }
  return result;
}
function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
function assertedSessionDir(value) {
  const resolved = path.resolve(String(value || ""));
  if (!inside(path.join(root, "sessions"), resolved)) { throw new Error("invalid-session-dir"); }
  return resolved;
}
function assertedRunDir(value) {
  const resolved = path.resolve(String(value || ""));
  if (!inside(root, resolved) || inside(path.join(root, "sessions"), resolved)) { throw new Error("invalid-run-dir"); }
  return resolved;
}
function drain() {
  const value = readJson(drainPath);
  if (!value) { return undefined; }
  if (value.bootId !== bootId() || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    try { fs.unlinkSync(drainPath); } catch {}
    return undefined;
  }
  return value;
}
function liveOperationLeases() {
  fs.mkdirSync(operationsDir, { recursive: true });
  const live = [];
  for (const name of listFiles(operationsDir, ".json")) {
    const file = path.join(operationsDir, name);
    const lease = readJson(file);
    if (!lease || lease.bootId !== bootId() || !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.now()) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    live.push(lease);
  }
  return live;
}
function sessionHasActiveWork(sessionDir, state) {
  if (!state) { return listFiles(sessionDir).length > 0; }
  if (state.activeRunId) {
    const activeDir = path.join(root, String(state.activeRunId));
    if (runBusy(activeDir, readJson(path.join(activeDir, "state.json")))) { return true; }
  }
  if (Array.isArray(state.queuedRunIds) && state.queuedRunIds.length > 0) { return true; }
  if (listFiles(path.join(sessionDir, "inbox"), ".json").length > 0) { return true; }
  return false;
}
function sessionBusy(sessionDir, state) {
  if (sessionHasActiveWork(sessionDir, state)) { return true; }
  if (!state) { return false; }
  return processMatches(Number(state.supervisorPid), state.processCookie) && state.status !== "stopped";
}
function runBusy(runDir, state) {
  const exit = readJson(path.join(runDir, "exit.json"));
  if (exit && ["completed", "failed", "cancelled"].includes(exit.status)) { return false; }
  const invocationPath = path.join(runDir, "invocation.json");
  const statePath = path.join(runDir, "state.json");
  const invocation = readJson(invocationPath);
  const wrapperPid = pidFile(path.join(runDir, "wrapper.pid"));
  if (!state) {
    if (wrapperPid || fs.existsSync(statePath) || fs.existsSync(invocationPath) || listFiles(runDir).length > 0) {
      if (invocation && (processMatches(wrapperPid, invocation.processCookie) || groupMatches(wrapperPid, invocation.processCookie))) { return true; }
      return true;
    }
    return false;
  }
  if (state.status !== "running" && state.status !== "unknown" && state.status !== "accepted") { return false; }
  const cookie = state.processCookie || (invocation && invocation.processCookie);
  if (!cookie) { return true; }
  return processMatches(wrapperPid, cookie) || processMatches(Number(state.pid), cookie) ||
    groupMatches(Number(state.pgid), cookie) || anyCookieProcess(cookie);
}
function anyRegisteredWork() {
  const operations = liveOperationLeases();
  if (operations.length > 0) { return { busy: true, reason: "operation-lease", id: operations[0].leaseId }; }
  const sessionsRoot = path.join(root, "sessions");
  for (const name of listFiles(sessionsRoot)) {
    const dir = path.join(sessionsRoot, name);
    if (sessionBusy(dir, readJson(path.join(dir, "session-state.json")))) { return { busy: true, reason: "warm-session", id: name }; }
  }
  for (const name of listFiles(root)) {
    if (
      ["sessions", "mirrors", "operations", "lifecycle.lock", "protocol-install.lock"].includes(name) ||
      name.startsWith("lifecycle.lock.reclaimed.") ||
      name.startsWith("protocol-install.lock.reclaimed.") ||
      name.startsWith("session-") ||
      name === "drain.json" ||
      name === "protocol.json"
    ) { continue; }
    const dir = path.join(root, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) { continue; }
    const state = readJson(path.join(dir, "state.json"));
    if (runBusy(dir, state)) { return { busy: true, reason: state ? "active-run" : "malformed-run", id: name }; }
  }
  return { busy: false };
}
function terminateVerified(pid, pgid, cookie) {
  const signal = (kind) => {
    if (processMatches(pid, cookie)) { try { process.kill(Number(pid), kind); } catch {} }
    if (groupMatches(pgid, cookie)) { try { process.kill(-Number(pgid), kind); } catch {} }
    for (const ownedPid of cookiePids(cookie)) { try { process.kill(ownedPid, kind); } catch {} }
  };
  signal("SIGTERM");
  for (let index = 0; index < 40 && (processMatches(pid, cookie) || groupMatches(pgid, cookie) || anyCookieProcess(cookie)); index += 1) { lockSleep(50); }
  if (processMatches(pid, cookie) || groupMatches(pgid, cookie) || anyCookieProcess(cookie)) {
    signal("SIGKILL");
    for (let index = 0; index < 40 && (processMatches(pid, cookie) || groupMatches(pgid, cookie) || anyCookieProcess(cookie)); index += 1) { lockSleep(50); }
  }
  return !processMatches(pid, cookie) && !groupMatches(pgid, cookie) && !anyCookieProcess(cookie);
}
function removeProviderSessions(ids) {
  const safeIds = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && /^[A-Za-z0-9-]{16,80}$/.test(id)))];
  if (safeIds.length === 0) { return; }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  for (const relative of ["sessions", "archived_sessions"]) {
    const base = path.join(codexHome, relative);
    const stack = [base];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const candidate = path.join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(candidate); continue; }
        if (safeIds.some((id) => entry.name.includes(id))) { try { fs.unlinkSync(candidate); } catch {} }
      }
    }
  }
}
function removeOwnedRunDirs(sessionDir, sessionState, extraRunIds) {
  const config = readJson(path.join(sessionDir, "session-config.json")) || sessionState || {};
  const ledger = readJson(path.join(sessionDir, "ledger.json")) || {};
  const runIds = new Set([...(Array.isArray(extraRunIds) ? extraRunIds : []), ...Object.keys(ledger)]);
  const providerSessionIds = [];
  for (const runId of runIds) {
    const entry = ledger[runId] || {};
    const runDir = entry.runDir ? path.resolve(entry.runDir) : path.join(root, String(runId));
    if (!inside(root, runDir) || inside(path.join(root, "sessions"), runDir)) { continue; }
    const invocation = readJson(path.join(runDir, "invocation.json"));
    const state = readJson(path.join(runDir, "state.json"));
    if (!invocation || invocation.conversationId !== config.conversationId || invocation.participantId !== config.participantId) { continue; }
    if (runBusy(runDir, state)) { throw new Error("owned-run-still-active"); }
    if (state && state.providerSessionId) { providerSessionIds.push(state.providerSessionId); }
    if (entry.providerSessionId) { providerSessionIds.push(entry.providerSessionId); }
    fs.rmSync(runDir, { recursive: true, force: true });
  }
  return providerSessionIds;
}
function runStatus(sessionDir, runId) {
  const ledger = readJson(path.join(sessionDir, "ledger.json")) || {};
  const entry = ledger[runId];
  if (entry && ["completed", "failed", "cancelled"].includes(entry.status)) { return entry.status; }
  if (entry) { return entry.status; }
  return undefined;
}

const lock = acquireRecoverableLock(lockDir, 5000);
if (!lock) { output({ ok: false, status: "lock-timeout" }); process.exit(3); }
try {
  (function execute() {
  if (action === "ensure") {
    if (drain()) { output({ ok: false, status: "draining" }); process.exitCode = 4; return; }
    const sessionDir = assertedSessionDir(payload.sessionDir);
    fs.mkdirSync(path.join(sessionDir, "inbox"), { recursive: true });
    const previous = readJson(path.join(sessionDir, "session-state.json"));
    const live = previous && processMatches(Number(previous.supervisorPid), previous.processCookie);
    const heartbeatFresh = previous && Number.isFinite(Date.parse(previous.heartbeat)) && Date.now() - Date.parse(previous.heartbeat) < 15000;
    if (live && heartbeatFresh && previous.accepting !== false && previous.runtimeFingerprint === payload.runtimeFingerprint) {
      output({ ok: true, status: "warm", state: previous });
    } else if (live && sessionHasActiveWork(sessionDir, previous)) {
      output({ ok: false, status: "busy-runtime-mismatch", state: previous }); process.exitCode = 5;
    } else {
      if (live) {
        const stopped = terminateVerified(Number(previous.supervisorPid), Number(previous.supervisorPgid), previous.processCookie);
        if (!stopped) { output({ ok: false, status: "busy-stale-session", state: previous }); process.exitCode = 5; return; }
      }
      const processCookie = crypto.randomUUID();
      writeJsonAtomic(path.join(sessionDir, "session-config.json"), {
        protocolVersion: payload.protocolVersion,
        sessionKey: payload.sessionKey,
        conversationId: payload.conversationId,
        participantId: payload.participantId,
        runtimeFingerprint: payload.runtimeFingerprint,
        idleTimeoutMs: payload.idleTimeoutMs,
        processCookie
      });
      const child = require("node:child_process").spawn(process.execPath, [path.join(root, "session-supervisor.js")], {
        cwd: sessionDir,
        env: { ...process.env, ACCORD_AGENTS_PROCESS_COOKIE: processCookie },
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      fs.writeFileSync(path.join(sessionDir, "supervisor.pid"), String(child.pid));
      let ready;
      for (let index = 0; index < 80; index += 1) {
        ready = readJson(path.join(sessionDir, "session-state.json"));
        if (ready && ready.processCookie === processCookie && processMatches(Number(ready.supervisorPid), processCookie)) { break; }
        lockSleep(50);
      }
      if (!ready || ready.processCookie !== processCookie || !processMatches(Number(ready.supervisorPid), processCookie)) {
        output({ ok: false, status: "supervisor-not-ready" }); process.exitCode = 11;
      } else { output({ ok: true, status: "launched", pid: child.pid, state: ready }); }
    }
  } else if (action === "submit") {
    if (drain()) { output({ ok: false, status: "draining" }); process.exitCode = 4; return; }
    const sessionDir = assertedSessionDir(payload.sessionDir);
    const sessionState = readJson(path.join(sessionDir, "session-state.json"));
    if (!sessionState || sessionState.accepting === false || !processMatches(Number(sessionState.supervisorPid), sessionState.processCookie)) {
      output({ ok: false, status: "stale-session" }); process.exitCode = 6;
    } else if (typeof payload.runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.runId)) {
      output({ ok: false, status: "invalid-run-id" }); process.exitCode = 6;
    } else {
      const ledger = readJson(path.join(sessionDir, "ledger.json")) || {};
      const inboxPath = path.join(sessionDir, "inbox", "turn-" + payload.runId + ".json");
      const duplicateStatus = runStatus(sessionDir, payload.runId);
      if (ledger[payload.runId] || sessionState.activeRunId === payload.runId || fs.existsSync(inboxPath)) {
        output({ ok: true, status: "duplicate", runStatus: duplicateStatus, state: sessionState });
      } else {
        const runDir = assertedRunDir(payload.runDir);
        fs.mkdirSync(runDir, { recursive: true });
        const processCookie = crypto.randomUUID();
        fs.writeFileSync(path.join(runDir, "prompt.txt"), payload.prompt || "");
        writeJsonAtomic(path.join(runDir, "invocation.json"), { ...payload.invocation, processCookie });
        writeJsonAtomic(path.join(runDir, "context-snapshot.json"), payload.contextSnapshot === undefined ? null : payload.contextSnapshot);
        fs.copyFileSync(path.join(root, "run-worker.js"), path.join(runDir, "worker.js"));
        for (const file of ["events.jsonl", "decisions.jsonl", "stdout.log", "stderr.log"]) { fs.closeSync(fs.openSync(path.join(runDir, file), "a")); }
        try { fs.unlinkSync(path.join(runDir, "exit.json")); } catch {}
        const sequencePath = path.join(sessionDir, "acceptance-sequence");
        const acceptanceSequence = (pidFile(sequencePath) || 0) + 1;
        fs.writeFileSync(sequencePath, String(acceptanceSequence));
        writeJsonAtomic(inboxPath, {
          runId: payload.runId,
          runDir,
          processCookie,
          acceptedAt: now(),
          acceptanceSequence
        });
        output({ ok: true, status: "accepted", runStatus: "accepted", acceptanceSequence, state: sessionState });
      }
    }
  } else if (action === "inspect") {
    const sessionDir = assertedSessionDir(payload.sessionDir);
    const state = readJson(path.join(sessionDir, "session-state.json"));
    output({ ok: true, status: state && processMatches(Number(state.supervisorPid), state.processCookie) ? "live" : "stopped", state });
  } else if (action === "inspect-run") {
    const runDir = assertedRunDir(payload.runDir);
    const state = readJson(path.join(runDir, "state.json"));
    output({ ok: true, status: runBusy(runDir, state) ? "live" : "stopped", state });
  } else if (action === "list-sessions") {
    const sessionsRoot = path.join(root, "sessions");
    const sessions = [];
    for (const name of listFiles(sessionsRoot)) {
      const sessionDir = path.join(sessionsRoot, name);
      let stat; try { stat = fs.statSync(sessionDir); } catch { continue; }
      if (!stat.isDirectory()) { continue; }
      const state = readJson(path.join(sessionDir, "session-state.json")) || {};
      const activeRunId = typeof state.activeRunId === "string" && runBusy(path.join(root, state.activeRunId), readJson(path.join(root, state.activeRunId, "state.json"))) ? state.activeRunId : undefined;
      const queuedRunIds = Array.isArray(state.queuedRunIds) ? state.queuedRunIds.filter((value) => typeof value === "string") : [];
      const inboxQueued = listFiles(path.join(sessionDir, "inbox"), ".json").length > 0;
      sessions.push({
        sessionDir,
        sessionKey: typeof state.sessionKey === "string" ? state.sessionKey : name,
        conversationId: state.conversationId,
        participantId: state.participantId,
        protocolVersion: state.protocolVersion,
        runtimeFingerprint: state.runtimeFingerprint,
        status: processMatches(Number(state.supervisorPid), state.processCookie) ? "live" : "stopped",
        activeRunId,
        queuedRunIds,
        hasQueuedTurns: queuedRunIds.length > 0 || inboxQueued,
        providerSessionId: state.providerSessionValid === false ? undefined : state.providerSessionId,
        providerSessionValid: state.providerSessionValid
      });
    }
    output({ ok: true, status: "listed", sessions });
  } else if (action === "stop-session") {
    const sessionDir = assertedSessionDir(payload.sessionDir);
    const state = readJson(path.join(sessionDir, "session-state.json"));
    if (sessionHasActiveWork(sessionDir, state)) { output({ ok: false, status: "busy", state }); process.exitCode = 7; }
    else {
      if (state && processMatches(Number(state.supervisorPid), state.processCookie)) {
        if (!terminateVerified(Number(state.supervisorPid), Number(state.supervisorPgid), state.processCookie)) {
          output({ ok: false, status: "busy", state }); process.exitCode = 7; return;
        }
      }
      let discoveredProviderSessionIds = [];
      if (payload.removeArtifacts === true) {
        discoveredProviderSessionIds = removeOwnedRunDirs(sessionDir, state, payload.runIds);
        removeProviderSessions([...(payload.providerSessionIds || []), ...discoveredProviderSessionIds, state && state.providerSessionId]);
      }
      if (payload.remove === true) { fs.rmSync(sessionDir, { recursive: true, force: true }); }
      output({ ok: true, status: "stopped", removedArtifacts: payload.removeArtifacts === true });
    }
  } else if (action === "cancel-run") {
    const runDir = assertedRunDir(payload.runDir);
    const invocation = readJson(path.join(runDir, "invocation.json"));
    const state = readJson(path.join(runDir, "state.json")) || {};
    const cookie = state.processCookie || (invocation && invocation.processCookie);
    const wrapperPid = pidFile(path.join(runDir, "wrapper.pid"));
    if (!cookie) { output({ ok: false, status: "identity-unknown" }); process.exitCode = 12; return; }
    const stopped = terminateVerified(wrapperPid, Number(state.pgid), cookie);
    if (!stopped) { output({ ok: false, status: "busy" }); process.exitCode = 12; return; }
    if (!readJson(path.join(runDir, "exit.json"))) {
      const completedAt = now();
      writeJsonAtomic(path.join(runDir, "exit.json"), { runId: payload.runId, status: "cancelled", error: payload.reason || "cancelled", completedAt });
      writeJsonAtomic(path.join(runDir, "state.json"), { ...state, runId: payload.runId, status: "cancelled", error: payload.reason || "cancelled", completedAt });
    }
    output({ ok: true, status: "cancelled" });
  } else if (action === "authorize-stop") {
    const existing = drain();
    if (existing) { output({ ok: false, status: "deny:draining" }); process.exitCode = 8; return; }
    const leaseId = payload.leaseId || crypto.randomUUID();
    const ttlMs = Math.max(5000, Number(payload.ttlMs || 30000));
    const lease = { leaseId, ownerId: payload.ownerId, bootId: bootId(), issuedAt: now(), expiresAt: new Date(Date.now() + ttlMs).toISOString(), protocolVersion: payload.protocolVersion };
    writeJsonAtomic(drainPath, lease);
    let work = anyRegisteredWork(); if (!work.busy) { work = anyRegisteredWork(); }
    if (work.busy) {
      try { fs.unlinkSync(drainPath); } catch {}
      output({ ok: false, status: "deny:busy", ...work }); process.exitCode = 9;
    } else { output({ ok: true, status: "allow", lease }); }
  } else if (action === "renew-stop") {
    const current = drain();
    if (!current || current.leaseId !== payload.leaseId) { output({ ok: false, status: "lease-missing" }); process.exitCode = 10; }
    else {
      current.expiresAt = new Date(Date.now() + Math.max(5000, Number(payload.ttlMs || 30000))).toISOString();
      writeJsonAtomic(drainPath, current); output({ ok: true, status: "renewed", lease: current });
    }
  } else if (action === "release-stop") {
    const current = drain(); if (current && current.leaseId === payload.leaseId) { try { fs.unlinkSync(drainPath); } catch {} }
    output({ ok: true, status: "released" });
  } else if (action === "acquire-operation") {
    if (drain()) { output({ ok: false, status: "draining" }); process.exitCode = 4; return; }
    fs.mkdirSync(operationsDir, { recursive: true });
    const leaseId = crypto.randomUUID();
    const lease = { leaseId, ownerId: payload.ownerId, kind: payload.kind, bootId: bootId(), issuedAt: now(), expiresAt: new Date(Date.now() + Math.max(5000, Number(payload.ttlMs || 30000))).toISOString() };
    writeJsonAtomic(path.join(operationsDir, leaseId + ".json"), lease);
    output({ ok: true, status: "acquired", lease });
  } else if (action === "renew-operation") {
    const file = path.join(operationsDir, String(payload.leaseId || "") + ".json");
    const lease = readJson(file);
    if (!lease || lease.bootId !== bootId()) { output({ ok: false, status: "lease-missing" }); process.exitCode = 10; }
    else {
      lease.expiresAt = new Date(Date.now() + Math.max(5000, Number(payload.ttlMs || 30000))).toISOString();
      writeJsonAtomic(file, lease); output({ ok: true, status: "renewed", lease });
    }
  } else if (action === "release-operation") {
    const file = path.join(operationsDir, String(payload.leaseId || "") + ".json");
    const lease = readJson(file);
    if (lease && (!payload.ownerId || lease.ownerId === payload.ownerId)) { try { fs.unlinkSync(file); } catch {} }
    output({ ok: true, status: "released" });
  } else { output({ ok: false, status: "unknown-action" }); process.exitCode = 2; }
  })();
} finally { releaseRecoverableLock(lock); }
`;
}

export function remoteSessionInstallerScript(): string {
  return String.raw`const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");

const root = path.resolve(process.argv[2]);
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const installLock = path.join(root, "protocol-install.lock");

${recoverableLockHelpers()}

function writeAtomic(file, body) {
  const tmp = file + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function hash(body) { return crypto.createHash("sha256").update(body).digest("hex"); }

fs.mkdirSync(root, { recursive: true });
const lock = acquireRecoverableLock(installLock, 30000);
if (!lock) { process.stdout.write(JSON.stringify({ ok: false, status: "install-lock-timeout" })); process.exit(3); }
try {
  const current = readLockJson(path.join(root, "protocol.json"));
  const expectedHashes = Object.fromEntries(Object.entries(payload.files).map(([name, body]) => [name, hash(body)]));
  const currentMatches = current && current.version === payload.version &&
    Object.entries(expectedHashes).every(([name, value]) => current.hashes && current.hashes[name] === value && fs.existsSync(path.join(root, name)));
  if (!currentMatches) {
    fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    for (const [name, body] of Object.entries(payload.files)) {
      new vm.Script(body, { filename: name });
      writeAtomic(path.join(root, name), body);
    }
    writeAtomic(path.join(root, "protocol.json"), JSON.stringify({ version: payload.version, hashes: expectedHashes, installedAt: new Date().toISOString() }));
  }
  process.stdout.write(JSON.stringify({ ok: true, status: currentMatches ? "current" : "installed", hashes: expectedHashes }));
} finally { releaseRecoverableLock(lock); }
`;
}
