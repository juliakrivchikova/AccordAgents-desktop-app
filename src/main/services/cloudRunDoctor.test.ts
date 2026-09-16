import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { CloudRunDoctorService, codexAuthProbeShell, enabledCloudProviders } from "./cloudRunDoctor";
import { shellQuotePosix } from "./cloudRunWorkers";
import type { CloudRunSshExecRequest } from "./cloudRunDoctor";
import { isTransientSshError, runWithSshRetries } from "./sshRetry";
import { CommandError } from "./command";

function commandError(fields: { stderr?: string; exitCode?: number | null; timedOut?: boolean; message?: string }): CommandError {
  return new CommandError(fields.message ?? "command failed", {
    command: "ssh",
    args: [],
    stdout: "",
    stderr: fields.stderr ?? "",
    exitCode: fields.exitCode ?? 255,
    timedOut: fields.timedOut ?? false
  });
}

const WORKER = { host: "worker.example", user: "ubuntu", identityFile: "/tmp/key.pem" };

const FULLY_PROVISIONED = [
  "rsync=ok", "git=ok", "gh=ok", "java=ok", "node=ok", "codex=ok", "claude=ok",
  "build-essential=ok", "sudo=ok", "userns=0",
  "git-name=Dev Example", "git-email=dev@example.com", "persistent-storage=ok",
  "storage-detail=/dev/root ext4 | /dev/root ext4", "codex-auth=ok", "claude-auth=ok"
].join("\n");

function doctorWith(handler: (request: CloudRunSshExecRequest) => Promise<string>, extra = {}): {
  service: CloudRunDoctorService;
  commands: string[];
} {
  const commands: string[] = [];
  const service = new CloudRunDoctorService({
    sshExec: async (request) => {
      commands.push(request.command);
      return handler(request);
    },
    localGitIdentity: async () => ({ name: "Local Dev", email: "local@example.com" }),
    ...extra
  });
  return { service, commands };
}

test("AWS check, setup, login and recheck stay in the resolved environment", async () => {
  const calls: CloudRunSshExecRequest[] = [];
  let resolutions = 0;
  let signedIn = false;
  const service = new CloudRunDoctorService({
    environmentForWorker: async (_worker, readOnly) => {
      assert.equal(readOnly, resolutions === 0, "diagnosis only reads ownership; setup may establish it");
      resolutions += 1;
      return { profileHome: "/srv/home/profile", workerRoot: "/srv/home" };
    },
    sshExec: async request => {
      calls.push(request);
      if (request.command.includes("login --device-auth")) {
        signedIn = true;
        return "Successfully logged in";
      }
      return signedIn ? FULLY_PROVISIONED : FULLY_PROVISIONED.replace("codex-auth=ok", "codex-auth=missing");
    }
  });
  assert.equal((await service.diagnose(WORKER)).ok, false);
  assert.equal((await service.setup(WORKER)).ok, true);
  assert.equal(resolutions, 2, "one resolution per action, including setup's probes");
  assert.ok(calls.every(call => call.worker.profileHome === "/srv/home/profile"));
  assert.ok(calls.some(call => call.command.includes("login --device-auth")));
  assert.ok(calls.filter(call => call.command.includes("worker_root=")).every(call => call.command.includes("'/srv/home'")));
});

test("an explicit legacy profile does not get replaced by a new environment", async () => {
  const { service } = doctorWith(async request => {
    assert.equal(request.worker.profileHome, undefined);
    return FULLY_PROVISIONED;
  }, { environmentForWorker: async () => { throw new Error("must not reinterpret a remembered legacy profile"); } });
  assert.equal((await service.diagnose(WORKER, { profileHome: undefined })).ok, true);
});

test("Claude login stays in its resolved profile and ready requires a successful native status after the reply", async () => {
  for (const statusPass of [false, true]) {
    let signedIn = false;
    let replied = false;
    const service = new CloudRunDoctorService({
      environmentForWorker: async () => ({ profileHome: "/srv/claude-profile", workerRoot: "/srv/claude" }),
      sshExec: async request => {
        assert.equal(request.worker.profileHome, "/srv/claude-profile");
        if (request.command.includes('["auth", "login"]')) {
          request.onStdout?.("https://claude.ai/oauth/authorize?state=native-state\n");
          await new Promise<void>(resolve => request.inputStream!.once("data", chunk => {
            assert.equal(String(chunk), "code#native-state\n"); replied = true; signedIn = statusPass; resolve();
          }));
          return "Login successful.";
        }
        return signedIn ? FULLY_PROVISIONED : FULLY_PROVISIONED.replace("claude-auth=ok", "claude-auth=missing");
      }
    });
    const report = await service.setup(WORKER, p => {
      if (p.authRequestId) service.submitAuthCode(p.authRequestId, "code#native-state");
    }, { requiredProviderKind: "claude-code" });
    assert.equal(replied, true); assert.equal(report.ok, statusPass);
    assert.equal(report.checks.find(check => check.id === "claude-auth")?.status, statusPass ? "pass" : "fail");
  }
});

test("provider requirements are explicit: disabled providers do not prevent readiness", async () => {
  assert.deepEqual(enabledCloudProviders([
    { kind: "codex-cli", enabled: false, label: "Codex" }, { kind: "claude-code", enabled: true, label: "Claude" },
    { kind: "gemini-cli", enabled: true, label: "Gemini" }, { kind: "anthropic", enabled: true, label: "API" }
  ]), ["claude-code"]);
  assert.deepEqual(enabledCloudProviders([]), []);
  const { service } = doctorWith(async () => FULLY_PROVISIONED.replace("claude-auth=ok", "claude-auth=missing"));
  assert.equal((await service.diagnose(WORKER, { requiredProviderKinds: ["codex-cli"] })).ok, true);
  assert.equal((await service.diagnose(WORKER, { requiredProviderKinds: ["codex-cli", "claude-code"] })).ok, false);
});

test("a failed progress save stops setup before side effects, including either native sign-in", async () => {
  for (const provider of ["codex-cli", "claude-code"] as const) {
    let opened = false;
    let authAborted = false;
    const service = new CloudRunDoctorService({
      openExternal: () => { opened = true; },
      sshExec: async request => {
        if (request.command.includes("have rsync")) {
          return FULLY_PROVISIONED.replace(`${provider === "claude-code" ? "claude" : "codex"}-auth=ok`,
            `${provider === "claude-code" ? "claude" : "codex"}-auth=missing`);
        }
        if (!request.command.includes("login --device-auth") && !request.command.includes('["auth", "login"]')) return "";
        return new Promise<string>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => { authAborted = true; reject(new Error("aborted")); });
          request.onStdout?.(provider === "claude-code" ? "https://claude.com/cai/oauth/authorize?state=one\n"
            : "https://auth.openai.com/codex/device\nABCD-EFGH\n");
        });
      }
    });
    const publish = async (p: { authUrl?: string }): Promise<void> => { if (p.authUrl) throw new Error("save failed"); };
    if (provider === "codex-cli") await assert.rejects(service.setup(WORKER, publish, { requiredProviderKind: provider }), /could not save/);
    else assert.equal((await service.setup(WORKER, publish, { requiredProviderKind: provider })).ok, false);
    assert.equal(authAborted, true); assert.equal(opened, false);
  }
  let ran = false;
  const service = new CloudRunDoctorService({ sshExec: async () => { ran = true; return FULLY_PROVISIONED; } });
  await assert.rejects(service.setup(WORKER, async () => { throw new Error("save failed"); }), /save failed/);
  assert.equal(ran, false);
});

test("diagnose reports ready when every probe passes", async () => {
  const { service } = doctorWith(async () => FULLY_PROVISIONED);
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((check) => check.id === "codex-auth")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "userns")?.status, "pass");
  assert.match(report.checks.find((check) => check.id === "persistent-storage")?.detail ?? "", /ext4/);
});

test("the worker probe asks codex login status first and falls back to app-server account/read", async () => {
  const { service, commands } = doctorWith(async () => FULLY_PROVISIONED);
  await service.diagnose({ ...WORKER, codexPath: "/opt/codex/bin/codex" });
  const probe = commands.find((command) => command.includes("codex-auth="));
  assert.ok(probe, "the probe script must report codex-auth");
  assert.match(probe, /'\/opt\/codex\/bin\/codex' login status >\/dev\/null 2>&1 \|\| codex_account_ready/);
  assert.match(probe, /'\/opt\/codex\/bin\/codex' app-server --listen stdio:\/\//);
  assert.match(probe, /"method":"account\/read","id":2,"params":\{"refreshToken":false\}/);
});

test("the codex-auth probe shell mirrors local readiness against a fake codex", { timeout: 30_000 }, async (t) => {
  if (process.platform === "win32" || spawnSync("sh", ["-c", "command -v timeout"], { encoding: "utf8" }).status !== 0) {
    t.skip("needs a POSIX shell with coreutils timeout, like the Ubuntu worker");
    return;
  }
  const cases: Array<{ mode: FakeCodexMode; expected: string; appServerStarts: boolean }> = [
    { mode: "logged-in", expected: "codex-auth=ok", appServerStarts: false },
    { mode: "no-openai-auth", expected: "codex-auth=ok", appServerStarts: true },
    { mode: "account", expected: "codex-auth=ok", appServerStarts: true },
    { mode: "signed-out", expected: "codex-auth=missing", appServerStarts: true },
    { mode: "error", expected: "codex-auth=missing", appServerStarts: true },
    { mode: "silent", expected: "codex-auth=missing", appServerStarts: true }
  ];
  for (const { mode, expected, appServerStarts } of cases) {
    const fake = await fakeCodex(t, mode);
    const startedAt = performance.now();
    const result = spawnSync("sh", ["-c", codexAuthProbeShell(fake.executablePath)], { encoding: "utf8", timeout: 20_000 });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(result.stdout.trim(), expected, `${mode}: ${result.stderr}`);
    assert.equal(await fake.appServerStarted(), appServerStarts, `${mode} must ${appServerStarts ? "" : "not "}start app-server`);
    if (mode === "silent") {
      assert.ok(elapsedMs >= 8_000 && elapsedMs < 12_000, `silent app-server must give up after 8s, took ${elapsedMs}ms`);
    } else {
      assert.ok(elapsedMs < 5_000, `${mode} must settle without waiting, took ${elapsedMs}ms`);
    }
    assert.equal(await fake.appServerRunning(), false, `${mode} must leave no app-server behind`);
  }
});

test("diagnose fails closed when worker or Codex sessions use volatile storage", async () => {
  const volatile = FULLY_PROVISIONED
    .replace("persistent-storage=ok", "persistent-storage=missing")
    .replace("/dev/root ext4 | /dev/root ext4", "tmpfs tmpfs | tmpfs tmpfs");
  const { service, commands } = doctorWith(async () => volatile);
  const report = await service.diagnose(
    { ...WORKER, workerRoot: "~/.accordagents/remote-runs" },
    { requirePersistentStorage: true }
  );
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === "persistent-storage")?.status, "fail");
  assert.match(commands[0], /findmnt/);
  assert.match(commands[0], /lsblk/);
  assert.match(commands[0], /vol\[0-9a-fA-F\]/);
  assert.match(commands[0], /CODEX_HOME/);
});

test("diagnose warns instead of blocking a manually managed SSH worker on volatile storage", async () => {
  const volatile = FULLY_PROVISIONED.replace("persistent-storage=ok", "persistent-storage=missing");
  const { service } = doctorWith(async () => volatile);
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((check) => check.id === "persistent-storage")?.status, "warn");
});

test("diagnose treats Claude checks as optional until a Claude run requires them", async () => {
  const missingClaude = FULLY_PROVISIONED
    .replace("claude=ok", "claude=missing")
    .replace("claude-auth=ok", "claude-auth=missing");
  const { service } = doctorWith(async () => missingClaude);
  const codexReport = await service.diagnose(WORKER);
  assert.equal(codexReport.ok, true);
  assert.equal(codexReport.checks.find((check) => check.id === "claude")?.status, "warn");
  assert.equal(codexReport.checks.find((check) => check.id === "claude-auth")?.status, "warn");

  const claudeReport = await service.diagnose(WORKER, { requiredProviderKind: "claude-code" });
  assert.equal(claudeReport.ok, false);
  assert.equal(claudeReport.checks.find((check) => check.id === "claude")?.status, "fail");
  assert.equal(claudeReport.checks.find((check) => check.id === "claude-auth")?.status, "fail");
});

test("diagnose fails on required gaps and warns on optional gaps", async () => {
  const probe = [
    "rsync=ok", "git=ok", "gh=missing", "java=missing", "node=ok", "codex=missing",
    "build-essential=missing", "sudo=ok", "userns=1",
    "git-name=", "git-email=", "persistent-storage=ok", "codex-auth=missing"
  ].join("\n");
  const { service } = doctorWith(async () => probe);
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, false);
  const byId = new Map(report.checks.map((check) => [check.id, check.status]));
  assert.equal(byId.get("codex"), "fail");
  assert.equal(byId.get("codex-auth"), "fail");
  assert.equal(byId.get("userns"), "fail");
  assert.equal(byId.get("gh"), "warn");
  assert.equal(byId.get("java"), "warn");
  assert.equal(byId.get("build-essential"), "warn");
  assert.equal(byId.get("git-identity"), "warn");
});

test("diagnose classifies public-key failures as likely AWS key mismatches", async () => {
  const { service } = doctorWith(async () => {
    throw new Error("Permission denied (publickey).");
  });
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, false);
  assert.match(report.message, /SSH connection failed/);
  assert.match(report.message, /private key is missing or does not match/);
  assert.match(report.message, /Delete and recreate the AWS worker/);
  assert.equal(report.checks[0].id, "connect");
});

test("diagnose classifies missing identity files as likely AWS key mismatches", async () => {
  const { service } = doctorWith(async () => {
    throw new Error("Warning: Identity file /tmp/key.pem not accessible: No such file or directory.");
  });
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, false);
  assert.match(report.message, /private key is missing or does not match/);
});

test("diagnose keeps generic connection errors generic", async () => {
  const { service } = doctorWith(async () => {
    throw new Error("Connection timed out.");
  });
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, false);
  assert.match(report.message, /SSH connection failed: Connection timed out/);
  assert.doesNotMatch(report.message, /Delete and recreate/);
});

test("diagnose caps connection-check retries", async () => {
  let observedAttempts: number | undefined;
  const { service } = doctorWith(async (request) => {
    observedAttempts = request.retryAttempts;
    return FULLY_PROVISIONED;
  });

  await service.diagnose(WORKER);

  assert.equal(observedAttempts, 1);
});

test("setup installs only the missing pieces and re-diagnoses", async () => {
  let probes = 0;
  const { service, commands } = doctorWith(async (request) => {
    if (request.command.includes("have rsync")) {
      probes += 1;
      return probes === 1
        ? [
            "rsync=missing", "git=ok", "gh=missing", "java=missing", "node=ok", "codex=missing",
            "build-essential=ok", "sudo=ok", "userns=1",
            "git-name=", "git-email=", "persistent-storage=ok", "codex-auth=ok"
          ].join("\n")
        : FULLY_PROVISIONED;
    }
    return "";
  });
  const report = await service.setup(WORKER);
  const joined = commands.join("\n");
  assert.match(joined, /apt-get install -y -qq rsync gh openjdk-21-jdk/);
  assert.doesNotMatch(joined, /install -y -qq[^\n]*git\b(?![-])/);
  assert.match(joined, /npm install -g @openai\/codex/);
  assert.match(joined, /apparmor_restrict_unprivileged_userns=0/);
  assert.match(joined, /git config --global user\.name 'Local Dev'/);
  assert.equal(report.ok, true);
});

test("setup installs Claude Code for Claude-required workers and surfaces auth as a user step", async () => {
  let probes = 0;
  const progress: string[] = [];
  const { service, commands } = doctorWith(async (request) => {
    if (request.command.includes("have rsync")) {
      probes += 1;
      return probes === 1
        ? [
            "rsync=ok", "git=ok", "gh=ok", "java=ok", "node=ok", "codex=missing", "claude=missing",
            "build-essential=ok", "sudo=ok", "userns=0",
            "git-name=Dev", "git-email=dev@example.com", "persistent-storage=ok",
            "codex-auth=missing", "claude-auth=missing"
          ].join("\n")
        : FULLY_PROVISIONED
          .replace("codex=ok", "codex=missing")
          .replace("codex-auth=ok", "codex-auth=missing")
          .replace("claude-auth=ok", "claude-auth=missing");
    }
    return "";
  });

  const report = await service.setup(WORKER, (event) => {
    progress.push(`${event.stage}:${event.message}`);
  }, { requiredProviderKind: "claude-code" });
  const joined = commands.join("\n");

  assert.match(joined, /npm install -g @anthropic-ai\/claude-code/);
  assert.doesNotMatch(joined, /npm install -g @openai\/codex/);
  assert.doesNotMatch(joined, /login --device-auth/);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === "claude")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "claude-auth")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "codex")?.status, "warn");
  assert.equal(report.checks.find((check) => check.id === "codex-auth")?.status, "warn");
  assert.equal(progress.some((message) => message.includes("Installing the Claude Code CLI")), true);
  assert.equal(progress.some((message) => message.includes("Starting Claude sign-in")), true);
  assert.match(joined, /\["auth", "login"\]/);
});

test("setup drives codex device-auth and surfaces url + code to the user", async () => {
  const progress: Array<{ authUrl?: string; authCode?: string }> = [];
  let opened: string | undefined;
  let probes = 0;
  const { service } = doctorWith(
    async (request) => {
      if (request.command.includes("have rsync")) {
        probes += 1;
        return probes === 1
          ? [
              "rsync=ok", "git=ok", "gh=ok", "java=ok", "node=ok", "codex=ok",
              "build-essential=ok", "sudo=ok", "userns=0",
              "git-name=Dev", "git-email=dev@example.com", "persistent-storage=ok", "codex-auth=missing"
            ].join("\n")
          : FULLY_PROVISIONED;
      }
      if (request.command.includes("login --device-auth")) {
        assert.equal(request.keepAlive, "none");
        request.onStdout?.("Open \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n");
        request.onStdout?.("Enter this one-time code\n   \u001b[94mKIAK-7ETT8\u001b[0m\n");
        return "";
      }
      return "";
    },
    { openExternal: (url: string) => { opened = url; } }
  );
  await service.setup(WORKER, (event) => {
    if (event.authUrl) {
      progress.push({ authUrl: event.authUrl, authCode: event.authCode });
    }
  });
  assert.equal(opened, "https://auth.openai.com/codex/device");
  assert.equal(progress.at(-1)?.authUrl, "https://auth.openai.com/codex/device");
  assert.equal(progress.at(-1)?.authCode, "KIAK-7ETT8");
});

test("setup without sudo skips installs and reports remaining gaps", async () => {
  const { service, commands } = doctorWith(async (request) => {
    if (request.command.includes("have rsync")) {
      return [
        "rsync=missing", "git=ok", "gh=ok", "java=ok", "node=ok", "codex=ok",
        "build-essential=ok", "sudo=missing", "userns=0",
        "git-name=Dev", "git-email=dev@example.com", "persistent-storage=ok", "codex-auth=ok"
      ].join("\n");
    }
    return "";
  });
  const report = await service.setup(WORKER);
  assert.doesNotMatch(commands.join("\n"), /apt-get install/);
  assert.equal(report.checks.find((check) => check.id === "rsync")?.status, "fail");
});

test("isTransientSshError retries connection failures but not auth/command failures", () => {
  assert.equal(isTransientSshError(commandError({ stderr: "kex_exchange_identification: Connection timed out" })), true);
  assert.equal(isTransientSshError(commandError({ stderr: "ssh: connect to host x port 22: Connection refused" })), true);
  assert.equal(isTransientSshError(commandError({ timedOut: true })), true);
  assert.equal(isTransientSshError(commandError({ stderr: "client_loop: send disconnect: Broken pipe" })), true);
  // Non-transient: a real auth failure or command error must NOT be retried.
  assert.equal(isTransientSshError(commandError({ stderr: "Permission denied (publickey)." })), false);
  assert.equal(isTransientSshError(commandError({ stderr: "sudo: a password is required", exitCode: 1 })), false);
  assert.equal(isTransientSshError(new Error("boom")), false);
});

test("runWithSshRetries retries a transient failure then succeeds", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await runWithSshRetries(async () => {
    calls += 1;
    if (calls < 3) throw commandError({ stderr: "Connection timed out during banner exchange" });
    return "ok";
  }, { baseDelayMs: 1, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
});

test("runWithSshRetries gives up after the attempt cap and rethrows", async () => {
  let calls = 0;
  await assert.rejects(
    () => runWithSshRetries(async () => { calls += 1; throw commandError({ stderr: "banner exchange", message: "banner exchange" }); },
      { attempts: 4, sleep: async () => {} }),
    /banner exchange/
  );
  assert.equal(calls, 4);
});

test("runWithSshRetries does not retry a non-transient failure", async () => {
  let calls = 0;
  await assert.rejects(
    () => runWithSshRetries(async () => { calls += 1; throw commandError({ stderr: "Permission denied (publickey).", message: "Permission denied (publickey)." }); },
      { sleep: async () => {} }),
    /Permission denied/
  );
  assert.equal(calls, 1);
});

test("runWithSshRetries stops when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    () => runWithSshRetries(async () => { calls += 1; return "unreached"; }, { signal: controller.signal, sleep: async () => {} })
  );
  assert.equal(calls, 0);
});

test("runWithSshRetries can stop retrying once output is produced (device-auth safety)", async () => {
  let produced = false;
  let calls = 0;
  await assert.rejects(() => runWithSshRetries(async () => {
    calls += 1;
    if (calls === 1) throw commandError({ stderr: "banner exchange", message: "banner exchange" }); // pre-output drop -> retry
    produced = true; // second attempt emits output, then the connection dies
    throw commandError({ stderr: "banner exchange", message: "banner exchange" });
  }, { sleep: async () => {}, isTransient: (e) => !produced && isTransientSshError(e) }));
  assert.equal(calls, 2); // retried the pre-output failure once, did not retry after output
});

type FakeCodexMode = "logged-in" | "no-openai-auth" | "account" | "signed-out" | "error" | "silent";

interface FakeCodex {
  executablePath: string;
  appServerStarted: () => Promise<boolean>;
  appServerRunning: () => Promise<boolean>;
}

/**
 * A `codex` stand-in for the probe shell: `login status` succeeds only in
 * `logged-in` mode, and `app-server --listen stdio://` answers `account/read`
 * according to the mode (never, for `silent`), records its pid, and like the
 * real server exits once stdin closes.
 */
const fakeCodexAppServerScript = [
  "const fs = require('node:fs');",
  "const mode = process.env.FAKE_CODEX_MODE;",
  "fs.writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));",
  "process.stdout.on('error', () => {});",
  "const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');",
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  let lineBreak = buffer.indexOf('\\n');",
  "  while (lineBreak >= 0) {",
  "    const line = buffer.slice(0, lineBreak);",
  "    buffer = buffer.slice(lineBreak + 1);",
  "    lineBreak = buffer.indexOf('\\n');",
  "    if (!line) continue;",
  "    const request = JSON.parse(line);",
  "    send({ method: 'currentTime/read', id: request.id, params: {} });",
  "    if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'fake-codex' } });",
  "    else if (mode === 'no-openai-auth') send({ id: request.id, result: { account: null, requiresOpenaiAuth: false } });",
  "    else if (mode === 'account') send({ id: request.id, result: { account: { type: 'chatgpt', email: 'private@example.com' }, requiresOpenaiAuth: true } });",
  "    else if (mode === 'signed-out') send({ id: request.id, result: { account: null, requiresOpenaiAuth: true } });",
  "    else if (mode === 'error') send({ id: request.id, error: { code: -32000, message: 'fake account failure' } });",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));"
].join("\n");

async function fakeCodex(t: TestContext, mode: FakeCodexMode): Promise<FakeCodex> {
  const root = await mkdtemp(path.join(tmpdir(), "accordagents-fake-cloud-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, "app-server.js");
  const pidPath = path.join(root, "app-server.pid");
  const executablePath = path.join(root, "codex");
  await writeFile(scriptPath, fakeCodexAppServerScript);
  await writeFile(executablePath, [
    "#!/bin/sh",
    `if [ "$1 $2" = "login status" ]; then [ ${JSON.stringify(mode)} = logged-in ] && echo 'Logged in using ChatGPT' && exit 0; echo 'Not logged in' >&2; exit 1; fi`,
    `[ "$*" = 'app-server --listen stdio://' ] || exit 2`,
    `FAKE_CODEX_MODE=${JSON.stringify(mode)} FAKE_CODEX_PID_FILE=${shellQuotePosix(pidPath)} exec ${shellQuotePosix(process.execPath)} ${shellQuotePosix(scriptPath)}`,
    ""
  ].join("\n"));
  await chmod(executablePath, 0o755);
  const pid = async (): Promise<number | undefined> => {
    const value = Number.parseInt(await readFile(pidPath, "utf8").catch(() => ""), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  return {
    executablePath,
    appServerStarted: async () => (await pid()) !== undefined,
    appServerRunning: async () => {
      const value = await pid();
      if (value === undefined) {
        return false;
      }
      const result = spawnSync("ps", ["-o", "stat=", "-p", String(value)], { encoding: "utf8" });
      return result.status === 0 && result.stdout.trim() !== "" && !result.stdout.trim().startsWith("Z");
    }
  };
}
