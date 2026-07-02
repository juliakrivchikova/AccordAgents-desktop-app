import assert from "node:assert/strict";
import test from "node:test";
import { CloudRunDoctorService } from "./cloudRunDoctor";
import type { CloudRunSshExecRequest } from "./cloudRunDoctor";

const WORKER = { host: "worker.example", user: "ubuntu", identityFile: "/tmp/key.pem" };

const FULLY_PROVISIONED = [
  "rsync=ok", "git=ok", "gh=ok", "node=ok", "codex=ok",
  "build-essential=ok", "sudo=ok", "userns=0",
  "git-name=Dev Example", "git-email=dev@example.com", "codex-auth=ok"
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
});

test("diagnose fails on required gaps and warns on optional gaps", async () => {
  const probe = [
    "rsync=ok", "git=ok", "gh=missing", "node=ok", "codex=missing",
    "build-essential=missing", "sudo=ok", "userns=1",
    "git-name=", "git-email=", "codex-auth=missing"
  ].join("\n");
  const { service } = doctorWith(async () => probe);
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, false);
  const byId = new Map(report.checks.map((check) => [check.id, check.status]));
  assert.equal(byId.get("codex"), "fail");
  assert.equal(byId.get("codex-auth"), "fail");
  assert.equal(byId.get("userns"), "fail");
  assert.equal(byId.get("gh"), "warn");
  assert.equal(byId.get("build-essential"), "warn");
  assert.equal(byId.get("git-identity"), "warn");
});

test("diagnose surfaces a clean connection error", async () => {
  const { service } = doctorWith(async () => {
    throw new Error("Permission denied (publickey).");
  });
  const report = await service.diagnose(WORKER);
  assert.equal(report.ok, false);
  assert.match(report.message, /SSH connection failed/);
  assert.equal(report.checks[0].id, "connect");
});

test("setup installs only the missing pieces and re-diagnoses", async () => {
  let probes = 0;
  const { service, commands } = doctorWith(async (request) => {
    if (request.command.includes("have rsync")) {
      probes += 1;
      return probes === 1
        ? [
            "rsync=missing", "git=ok", "gh=missing", "node=ok", "codex=missing",
            "build-essential=ok", "sudo=ok", "userns=1",
            "git-name=", "git-email=", "codex-auth=ok"
          ].join("\n")
        : FULLY_PROVISIONED;
    }
    return "";
  });
  const report = await service.setup(WORKER);
  const joined = commands.join("\n");
  assert.match(joined, /apt-get install -y -qq rsync gh/);
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
              "rsync=ok", "git=ok", "gh=ok", "node=ok", "codex=ok",
              "build-essential=ok", "sudo=ok", "userns=0",
              "git-name=Dev", "git-email=dev@example.com", "codex-auth=missing"
            ].join("\n")
          : FULLY_PROVISIONED;
      }
      if (request.command.includes("login --device-auth")) {
        request.onStdout?.("Open https://auth.openai.com/device and enter WXYZ-1234\n");
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
  assert.equal(opened, "https://auth.openai.com/device");
  assert.equal(progress[0]?.authUrl, "https://auth.openai.com/device");
  assert.equal(progress[0]?.authCode, "WXYZ-1234");
});

test("setup without sudo skips installs and reports remaining gaps", async () => {
  const { service, commands } = doctorWith(async (request) => {
    if (request.command.includes("have rsync")) {
      return [
        "rsync=missing", "git=ok", "gh=ok", "node=ok", "codex=ok",
        "build-essential=ok", "sudo=missing", "userns=0",
        "git-name=Dev", "git-email=dev@example.com", "codex-auth=ok"
      ].join("\n");
    }
    return "";
  });
  const report = await service.setup(WORKER);
  assert.doesNotMatch(commands.join("\n"), /apt-get install/);
  assert.equal(report.checks.find((check) => check.id === "rsync")?.status, "fail");
});
