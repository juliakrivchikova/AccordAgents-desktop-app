import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  REMOTE_SESSION_PROTOCOL_VERSION,
  remoteSessionControlScript,
  remoteSessionInstallerScript,
  remoteSessionSupervisorScript,
  remoteWorkerOperationLeaseShellScript
} from "./remoteSessionSupervisorScript";

const execFileAsync = promisify(execFile);

test("generated remote session scripts parse as valid Node programs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-session-script-"));
  const supervisor = path.join(root, "session-supervisor.js");
  const control = path.join(root, "session-control.js");
  const installer = path.join(root, "session-installer.js");
  await writeFile(supervisor, remoteSessionSupervisorScript(), "utf8");
  await writeFile(control, remoteSessionControlScript(), "utf8");
  await writeFile(installer, remoteSessionInstallerScript(), "utf8");
  await execFileAsync(process.execPath, ["--check", supervisor]);
  await execFileAsync(process.execPath, ["--check", control]);
  await execFileAsync(process.execPath, ["--check", installer]);
});

test("control reclaims a lifecycle lock left by a dead process or previous boot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-stale-lock-"));
  const lockDir = path.join(root, "lifecycle.lock");
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await mkdir(lockDir);
  await writeFile(path.join(root, "session-control.js"), remoteSessionControlScript(), "utf8");
  await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
    ownerId: "abandoned",
    pid: 999_999,
    processStartIdentity: "dead",
    bootId: "previous-boot",
    acquiredAt: "2020-01-01T00:00:00.000Z"
  }), "utf8");

  const result = await runControl(root, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "desktop",
    ttlMs: 30_000
  });
  assert.equal(result.code, 0);
  assert.equal(result.value.status, "allow");
});

test("concurrent stale-lock reclaimers preserve mutual exclusion at the stop gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-stale-lock-race-"));
  const lockDir = path.join(root, "lifecycle.lock");
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "session-control.js"), remoteSessionControlScript(), "utf8");

  for (let iteration = 0; iteration < 15; iteration += 1) {
    await rm(path.join(root, "drain.json"), { force: true });
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
      ownerId: `abandoned-${iteration}`,
      pid: 999_999,
      processStartIdentity: "dead",
      bootId: "previous-boot",
      acquiredAt: "2020-01-01T00:00:00.000Z"
    }), "utf8");

    const results = await Promise.all([
      runControl(root, "authorize-stop", {
        protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
        ownerId: `desktop-a-${iteration}`,
        ttlMs: 30_000
      }),
      runControl(root, "authorize-stop", {
        protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
        ownerId: `desktop-b-${iteration}`,
        ttlMs: 30_000
      })
    ]);
    assert.equal(results.filter((result) => result.value.status === "allow").length, 1);
    assert.equal(results.filter((result) => result.value.status === "deny:draining").length, 1);
  }
});

test("worker operation leases fail closed for automatic stop and expire safely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-operation-lease-"));
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "session-control.js"), remoteSessionControlScript(), "utf8");
  const acquired = await runControl(root, "acquire-operation", {
    ownerId: "desktop-a",
    kind: "worker-setup",
    ttlMs: 30_000
  });
  const denied = await runControl(root, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "desktop-b",
    ttlMs: 30_000
  });
  assert.equal(denied.code, 9);
  assert.equal(denied.value.reason, "operation-lease");
  const lease = acquired.value.lease as { leaseId: string };
  await runControl(root, "release-operation", { leaseId: lease.leaseId, ownerId: "desktop-a" });
  const allowed = await runControl(root, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "desktop-b",
    ttlMs: 30_000
  });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.value.status, "allow");
});

test("worker-wide stop gate protects work and submissions across device roots", async () => {
  const sharedRoot = await mkdtemp(path.join(tmpdir(), "accordagents-shared-worker-gate-"));
  const deviceRoot = path.join(sharedRoot, "devices", "laptop-a");
  const sessionDir = path.join(deviceRoot, "sessions", "session-a");
  await mkdir(path.join(sessionDir, "inbox"), { recursive: true });
  await writeFile(path.join(sharedRoot, "session-control.js"), remoteSessionControlScript(), "utf8");
  await writeFile(path.join(deviceRoot, "session-control.js"), remoteSessionControlScript(), "utf8");
  await writeFile(path.join(sessionDir, "session-state.json"), JSON.stringify({
    status: "idle",
    queuedRunIds: ["run-a"]
  }), "utf8");
  await writeFile(path.join(sessionDir, "inbox", "turn-run-a.json"), "{}", "utf8");

  const queuedDenied = await runControl(sharedRoot, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "laptop-b",
    ttlMs: 30_000
  });
  assert.equal(queuedDenied.code, 9);
  assert.equal(queuedDenied.value.reason, "warm-session");

  await rm(sessionDir, { recursive: true, force: true });
  const operation = await runOperationLeaseShell(
    deviceRoot,
    "acquire",
    "settings-op",
    "laptop-a",
    "worker-setup"
  );
  assert.equal(operation.code, 0);
  const operationDenied = await runControl(sharedRoot, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "laptop-b",
    ttlMs: 30_000
  });
  assert.equal(operationDenied.code, 9);
  assert.equal(operationDenied.value.reason, "operation-lease");
  await runOperationLeaseShell(deviceRoot, "release", "settings-op", "laptop-a", "worker-setup");

  const allowed = await runControl(sharedRoot, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "laptop-b",
    ttlMs: 30_000
  });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.value.status, "allow");
  const submitDuringDrain = await runControl(deviceRoot, "submit", {});
  assert.equal(submitDuringDrain.code, 4);
  assert.equal(submitDuringDrain.value.status, "draining");
});

test("POSIX worker operation lease works before the Node session protocol is installed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-bootstrap-operation-"));
  const leaseId = "bootstrap-lease";
  const ownerId = "desktop-a";
  const kind = "settings-worker-operation";
  const acquired = await runOperationLeaseShell(root, "acquire", leaseId, ownerId, kind);
  assert.equal(acquired.code, 0);
  assert.equal(acquired.value.status, "acquired");
  assert.equal(await fileExists(path.join(root, "operations", `${leaseId}.json`)), true);

  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "session-control.js"), remoteSessionControlScript(), "utf8");
  const denied = await runControl(root, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "desktop-b",
    ttlMs: 30_000
  });
  assert.equal(denied.code, 9);
  assert.equal(denied.value.reason, "operation-lease");

  const released = await runOperationLeaseShell(root, "release", leaseId, ownerId, kind);
  assert.equal(released.code, 0);
  assert.equal(await fileExists(path.join(root, "operations", `${leaseId}.json`)), false);
});

test("concurrent protocol installers publish only complete versioned scripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-protocol-install-"));
  const installerA = path.join(root, "installer-a.js");
  const installerB = path.join(root, "installer-b.js");
  const installer = remoteSessionInstallerScript();
  await writeFile(installerA, installer, "utf8");
  await writeFile(installerB, installer, "utf8");
  const filesA = {
    "session-control.js": "globalThis.protocolInstall = 'a-control';\n",
    "session-supervisor.js": "globalThis.protocolInstall = 'a-supervisor';\n",
    "run-worker.js": "globalThis.protocolInstall = 'a-worker';\n"
  };
  const filesB = Object.fromEntries(Object.entries(filesA).map(([name, body]) => [name, body.replaceAll("'a-", "'b-")])) as typeof filesA;

  await Promise.all([
    runProgram(installerA, [root], { version: REMOTE_SESSION_PROTOCOL_VERSION, files: filesA }),
    runProgram(installerB, [root], { version: REMOTE_SESSION_PROTOCOL_VERSION, files: filesB })
  ]);

  const protocol = JSON.parse(await readFile(path.join(root, "protocol.json"), "utf8")) as {
    version: number;
    hashes: Record<string, string>;
  };
  assert.equal(protocol.version, REMOTE_SESSION_PROTOCOL_VERSION);
  for (const [name, expectedHash] of Object.entries(protocol.hashes)) {
    const body = await readFile(path.join(root, name), "utf8");
    assert.equal(createHash("sha256").update(body).digest("hex"), expectedHash);
    await execFileAsync(process.execPath, ["--check", path.join(root, name)]);
  }
});

test("supervisor measures idle on the worker and never exits while a run child is active", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-session-harness-"));
  const sessionDir = path.join(root, "sessions", "participant");
  const runDir = path.join(root, "run-1");
  await mkdir(path.join(sessionDir, "inbox"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(root, "session-supervisor.js"), remoteSessionSupervisorScript(), "utf8");
  await writeFile(path.join(runDir, "worker.js"), "setTimeout(() => process.exit(0), 700);\n", "utf8");
  await writeFile(path.join(sessionDir, "session-config.json"), JSON.stringify({
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    sessionKey: "participant",
    conversationId: "conversation",
    participantId: "participant",
    runtimeFingerprint: "fingerprint",
    idleTimeoutMs: 100,
    processCookie: "supervisor-cookie"
  }), "utf8");
  await writeFile(path.join(sessionDir, "inbox", "turn-run-1.json"), JSON.stringify({
    runId: "run-1",
    runDir,
    processCookie: "run-cookie"
  }), "utf8");

  const child = (await import("node:child_process")).spawn(
    process.execPath,
    [path.join(root, "session-supervisor.js")],
    {
      cwd: sessionDir,
      env: { ...process.env, ACCORD_AGENTS_PROCESS_COOKIE: "supervisor-cookie" },
      stdio: "ignore"
    }
  );
  await waitFor(async () => (await state(sessionDir)).activeRunId === "run-1");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, "idle timeout must not stop an active run");
  await waitFor(() => child.exitCode !== null, 3_000);
  const final = await state(sessionDir);
  assert.equal(final.status, "stopped");
  assert.equal(final.stopReason, "idle-timeout");
});

test("restarted supervisor does not dequeue another turn while a detached run is live", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-session-restart-"));
  const sessionDir = path.join(root, "sessions", "participant");
  const firstRunDir = path.join(root, "run-1");
  const secondRunDir = path.join(root, "run-2");
  const secondStarted = path.join(root, "run-2-started");
  await mkdir(path.join(sessionDir, "inbox"), { recursive: true });
  await mkdir(firstRunDir, { recursive: true });
  await mkdir(secondRunDir, { recursive: true });
  await writeFile(path.join(root, "session-supervisor.js"), remoteSessionSupervisorScript(), "utf8");
  await writeFile(path.join(secondRunDir, "worker.js"), `require("node:fs").writeFileSync(${JSON.stringify(secondStarted)}, "started");\n`, "utf8");
  await writeFile(path.join(sessionDir, "session-config.json"), JSON.stringify({
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    sessionKey: "participant",
    conversationId: "conversation",
    participantId: "participant",
    runtimeFingerprint: "fingerprint",
    idleTimeoutMs: 300,
    processCookie: "supervisor-cookie"
  }), "utf8");
  await writeFile(path.join(sessionDir, "ledger.json"), JSON.stringify({
    "run-1": { status: "running" }
  }), "utf8");
  const detached = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  detached.unref();
  await writeFile(path.join(firstRunDir, "state.json"), JSON.stringify({
    status: "running",
    pid: detached.pid,
    pgid: detached.pid
  }), "utf8");
  await writeFile(path.join(sessionDir, "inbox", "turn-run-2.json"), JSON.stringify({
    runId: "run-2",
    runDir: secondRunDir,
    processCookie: "run-2-cookie"
  }), "utf8");

  const supervisor = spawn(process.execPath, [path.join(root, "session-supervisor.js")], {
    cwd: sessionDir,
    env: { ...process.env, ACCORD_AGENTS_PROCESS_COOKIE: "supervisor-cookie" },
    stdio: "ignore"
  });
  try {
    await waitFor(async () => (await state(sessionDir)).activeRunId === "run-1");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await fileExists(secondStarted), false);
    detached.kill("SIGKILL");
    await writeFile(path.join(firstRunDir, "state.json"), JSON.stringify({ status: "completed" }), "utf8");
    await waitFor(() => fileExists(secondStarted), 3_000);
  } finally {
    if (detached.pid) {
      try { process.kill(detached.pid, "SIGKILL"); } catch {}
    }
    if (supervisor.exitCode === null) {
      supervisor.kill("SIGTERM");
    }
  }
});

test("supervisor recovers a durable inbox turn after crashing between ledger update and spawn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-session-crash-recovery-"));
  const sessionDir = path.join(root, "sessions", "participant");
  const runDir = path.join(root, "run-recover");
  const started = path.join(root, "recovered-run-started");
  await mkdir(path.join(sessionDir, "inbox"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(root, "session-supervisor.js"), remoteSessionSupervisorScript(), "utf8");
  await writeFile(path.join(runDir, "worker.js"), `require("node:fs").writeFileSync(${JSON.stringify(started)}, "started");\n`, "utf8");
  await writeFile(path.join(sessionDir, "session-config.json"), JSON.stringify({
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    sessionKey: "participant",
    conversationId: "conversation",
    participantId: "participant",
    runtimeFingerprint: "fingerprint",
    idleTimeoutMs: 5_000,
    processCookie: "supervisor-cookie"
  }), "utf8");
  await writeFile(path.join(sessionDir, "ledger.json"), JSON.stringify({
    "run-recover": {
      status: "starting",
      runDir,
      processCookie: "run-cookie",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      acceptanceSequence: 1
    }
  }), "utf8");
  await writeFile(path.join(sessionDir, "inbox", "turn-run-recover.json"), JSON.stringify({
    runId: "run-recover",
    runDir,
    processCookie: "run-cookie",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    acceptanceSequence: 1
  }), "utf8");

  const supervisor = spawn(process.execPath, [path.join(root, "session-supervisor.js")], {
    cwd: sessionDir,
    env: { ...process.env, ACCORD_AGENTS_PROCESS_COOKIE: "supervisor-cookie" },
    stdio: "ignore"
  });
  try {
    await waitFor(() => fileExists(started), 3_000);
    assert.equal(await fileExists(path.join(sessionDir, "inbox", "turn-run-recover.json")), false);
  } finally {
    if (supervisor.exitCode === null) supervisor.kill("SIGTERM");
  }
});

test("automatic-stop drain blocks submissions until its lease expires or the worker restarts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-session-control-"));
  const controlPath = path.join(root, "session-control.js");
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(controlPath, remoteSessionControlScript(), "utf8");
  await writeFile(path.join(root, "session-supervisor.js"), remoteSessionSupervisorScript(), "utf8");
  await writeFile(path.join(root, "run-worker.js"), "setTimeout(() => process.exit(0), 20);\n", "utf8");

  const authorized = await runControl(root, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "desktop-a",
    ttlMs: 30_000
  });
  assert.equal(authorized.value.status, "allow");

  const sessionDir = path.join(root, "sessions", "participant");
  const blocked = await runControl(root, "ensure", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    sessionKey: "participant",
    sessionDir,
    conversationId: "conversation",
    participantId: "participant",
    runtimeFingerprint: "fingerprint",
    idleTimeoutMs: 10_000
  });
  assert.equal(blocked.code, 4);
  assert.equal(blocked.value.status, "draining");

  const lease = JSON.parse(await readFile(path.join(root, "drain.json"), "utf8")) as Record<string, unknown>;
  await writeFile(path.join(root, "drain.json"), JSON.stringify({
    ...lease,
    bootId: "previous-ec2-boot",
    expiresAt: "2999-01-01T00:00:00.000Z"
  }), "utf8");
  const relaunched = await runControl(root, "ensure", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    sessionKey: "participant",
    sessionDir,
    conversationId: "conversation",
    participantId: "participant",
    runtimeFingerprint: "fingerprint",
    idleTimeoutMs: 10_000
  });
  assert.equal(relaunched.code, 0);
  assert.equal(relaunched.value.status, "launched");
  assert.equal(await fileExists(path.join(root, "drain.json")), false);
  const listed = await runControl(root, "list-sessions", {});
  assert.equal(listed.value.status, "listed");
  assert.equal((listed.value.sessions as Array<Record<string, unknown>>).length, 1);
  assert.equal((listed.value.sessions as Array<Record<string, unknown>>)[0].sessionKey, "participant");

  const runDir = path.join(root, "run-1");
  const turn = {
    sessionDir,
    runId: "run-1",
    runDir,
    prompt: "Run once.",
    invocation: {
      runId: "run-1",
      conversationId: "conversation",
      participantId: "participant",
      args: [],
      input: "Run once.",
      env: {},
      codexPath: "codex",
      finalPath: path.join(runDir, "final.txt"),
      maxRuntimeMs: 10_000
    },
    contextSnapshot: null
  };
  const accepted = await runControl(root, "submit", turn);
  const duplicate = await runControl(root, "submit", turn);
  assert.equal(accepted.value.status, "accepted");
  assert.equal(duplicate.value.status, "duplicate");
  await waitFor(() => fileExists(path.join(runDir, "wrapper.pid")));
  await waitFor(async () => !(await state(sessionDir)).activeRunId);
  const terminalDuplicate = await runControl(root, "submit", turn);
  assert.equal(terminalDuplicate.value.status, "duplicate");
  assert.ok(["completed", "failed", "cancelled"].includes(String(terminalDuplicate.value.runStatus)));

  const deniedWhileWarm = await runControl(root, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "desktop-b",
    ttlMs: 30_000
  });
  assert.equal(deniedWhileWarm.code, 9);
  assert.equal(deniedWhileWarm.value.status, "deny:busy");
  assert.equal(deniedWhileWarm.value.reason, "warm-session");

  const stopped = await runControl(root, "stop-session", { sessionDir });
  assert.equal(stopped.value.status, "stopped");
});

test("idle cleanup escalates a refusing supervisor and removes it only after verified exit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-session-stop-race-"));
  const sessionDir = path.join(root, "sessions", "participant");
  const processCookie = "refusing-supervisor";
  const readyPath = path.join(root, "refusing-supervisor-ready");
  await mkdir(path.join(sessionDir, "inbox"), { recursive: true });
  await writeFile(path.join(root, "session-control.js"), remoteSessionControlScript(), "utf8");
  const refusing = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready"); setInterval(() => {}, 1000)`], {
    env: { ...process.env, ACCORD_AGENTS_PROCESS_COOKIE: processCookie },
    detached: true,
    stdio: "ignore"
  });
  refusing.unref();
  await waitFor(() => fileExists(readyPath));
  await writeFile(path.join(sessionDir, "session-state.json"), JSON.stringify({
    status: "idle",
    supervisorPid: refusing.pid,
    processCookie,
    queuedRunIds: []
  }), "utf8");

  try {
    const stopped = await runControl(root, "stop-session", { sessionDir, remove: true });
    assert.equal(stopped.code, 0);
    assert.equal(stopped.value.status, "stopped");
    assert.equal(await fileExists(path.join(sessionDir, "session-state.json")), false);
  } finally {
    if (refusing.pid) {
      try { process.kill(refusing.pid, "SIGKILL"); } catch {}
    }
  }
});

test("automatic stop fails closed for a malformed run manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-session-orphan-"));
  const runDir = path.join(root, "orphan-run");
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(root, "session-control.js"), remoteSessionControlScript(), "utf8");
  await writeFile(path.join(runDir, "invocation.json"), JSON.stringify({ processCookie: "never-launched" }), "utf8");

  const authorized = await runControl(root, "authorize-stop", {
    protocolVersion: REMOTE_SESSION_PROTOCOL_VERSION,
    ownerId: "desktop-a",
    ttlMs: 30_000
  });
  assert.equal(authorized.code, 9);
  assert.equal(authorized.value.status, "deny:busy");
  assert.equal(authorized.value.reason, "malformed-run");
});

test("cancel-run never signals a reused pid whose process cookie does not match", {
  skip: process.platform !== "linux" ? "Linux /proc identity verification" : false
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-pid-reuse-"));
  const runDir = path.join(root, "run-reused-pid");
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await mkdir(runDir);
  await writeFile(path.join(root, "session-control.js"), remoteSessionControlScript(), "utf8");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: { ...process.env, ACCORD_AGENTS_PROCESS_COOKIE: "unrelated-cookie" },
    detached: true,
    stdio: "ignore"
  });
  unrelated.unref();
  await waitFor(() => processAlive(unrelated.pid));
  await writeFile(path.join(runDir, "wrapper.pid"), String(unrelated.pid), "utf8");
  await writeFile(path.join(runDir, "invocation.json"), JSON.stringify({ processCookie: "expected-cookie" }), "utf8");
  await writeFile(path.join(runDir, "state.json"), JSON.stringify({
    runId: "run-reused-pid",
    status: "running",
    pid: unrelated.pid,
    pgid: unrelated.pid,
    processCookie: "expected-cookie"
  }), "utf8");
  try {
    const cancelled = await runControl(root, "cancel-run", {
      runId: "run-reused-pid",
      runDir,
      reason: "test"
    });
    assert.equal(cancelled.code, 0);
    assert.equal(cancelled.value.status, "cancelled");
    assert.equal(processAlive(unrelated.pid), true);
  } finally {
    if (unrelated.pid) {
      try { process.kill(-unrelated.pid, "SIGKILL"); } catch {}
    }
  }
});

async function state(sessionDir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(sessionDir, "session-state.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for supervisor harness state.");
}

async function runControl(
  root: string,
  action: string,
  payload: Record<string, unknown>
): Promise<{ code: number; value: Record<string, unknown> }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "session-control.js"), root, action], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code: code ?? -1, value: JSON.parse(stdout || "{}") as Record<string, unknown> });
      } catch {
        reject(new Error(`Control script returned invalid JSON: ${stdout}\n${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function runOperationLeaseShell(
  root: string,
  action: "acquire" | "renew" | "release",
  leaseId: string,
  ownerId: string,
  kind: string
): Promise<{ code: number; value: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-s", "--", root, action, leaseId, ownerId, kind, "30000"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code: code ?? -1, value: JSON.parse(stdout || "{}") as Record<string, unknown> });
      } catch {
        reject(new Error(`Operation lease shell returned invalid JSON: ${stdout}\n${stderr}`));
      }
    });
    child.stdin.end(remoteWorkerOperationLeaseShellScript());
  });
}

async function runProgram(
  program: string,
  args: string[],
  payload: Record<string, unknown>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [program, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `program exited ${code}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
