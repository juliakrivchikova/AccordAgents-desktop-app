import assert from "node:assert/strict";
import test from "node:test";
import { CloudRunDoctorService, isTransientSshError, runWithSshRetries } from "./cloudRunDoctor";
import type { CloudRunSshExecRequest } from "./cloudRunDoctor";
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
  "rsync=ok", "git=ok", "gh=ok", "java=ok", "node=ok", "codex=ok",
  "build-essential=ok", "sudo=ok", "userns=0",
  "git-name=Dev Example", "git-email=dev@example.com", "persistent-storage=ok",
  "storage-detail=/dev/root ext4 | /dev/root ext4", "codex-auth=ok"
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

test("diagnose reports ready when every probe passes", async () => {
  const { service } = doctorWith(async () => FULLY_PROVISIONED);
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((check) => check.id === "codex-auth")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "userns")?.status, "pass");
  assert.match(report.checks.find((check) => check.id === "persistent-storage")?.detail ?? "", /ext4/);
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
