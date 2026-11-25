// What the installer's tests set up.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandError } from "../../command";
import type { CloudRunWorkerDoctorReport } from "../../../../shared/types";
import type { MachineInstallRecord, MachineInstallSnapshot, MachineSshTarget } from "../../../../shared/machineInstall";
import { MACHINE_POWER_REFUSED_EXIT_CODE, type AwsMachinePowerConfig } from "../../../../shared/machinePower";
import { MachineInstallerService, readMachineBundle, releaseName, type MachineSshExecRequest } from "../../machineInstaller";
import { machineInstallLayout } from "../../machineInstallScripts";

export const TARGET: MachineSshTarget = { host: "198.51.100.10", user: "ubuntu", identityFile: "/tmp/key.pem" };

export const ENROLLMENT = JSON.stringify({ purpose: "machine-host", hubUrl: "https://hub.example/", key: "SUPER-SECRET-PAIRING-KEY" });

export const LAYOUT = machineInstallLayout({
  installRoot: "/home/ubuntu/accordagents-machine",
  userDataDir: "/home/ubuntu/.accordagents/machine",
  serviceName: "accordagents-machine",
  serviceScope: "system"
});

export function probeOutput(overrides: Record<string, string | undefined> = {}, releases: string[] = []): string {
  const base: Record<string, string | undefined> = {
    home: "/home/ubuntu",
    "install-root": "/home/ubuntu/accordagents-machine",
    "user-data": "/home/ubuntu/.accordagents/machine",
    "service-name": "accordagents-machine",
    node: "v22.11.0",
    sqlite3: "ok",
    git: "ok",
    rsync: "ok",
    npm: "ok",
    python3: "ok",
    systemd: "ok",
    sudo: "ok",
    "login-path": "/home/ubuntu/.npm-global/bin:/usr/bin:/bin",
    "node-path": "/usr/bin/node",
    enrollment: "absent",
    "service-state": "absent",
    "runtime-pids": "",
    "supervisor-pids": "",
    "provider-pids": "",
    ...overrides
  };
  const lines = Object.entries(base)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  for (const release of releases) lines.push(`release=${release}`);
  return `${lines.join("\n")}\n`;
}

export function bundleFixture(version = "1.4.0"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-bundle-"));
  fs.writeFileSync(path.join(dir, "accordagents-machine.cjs"), "#!/usr/bin/env node\n// runtime\n");
  fs.writeFileSync(path.join(dir, "nativeProcessSupervisor.cjs"), "// supervisor\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "accordagents-machine", version }));
  fs.mkdirSync(path.join(dir, "appSkills", "accord"), { recursive: true });
  fs.writeFileSync(path.join(dir, "appSkills", "accord", "SKILL.md"), "# accord\n");
  writePayloadManifest(dir, version);
  return dir;
}

/** The same manifest `scripts/build-machine-bundle.mjs` writes. */
export function writePayloadManifest(dir: string, version: string): void {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === "node_modules" || (!prefix && entry.name === "payload.json")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) {
        const contents = fs.readFileSync(full);
        files.push({ path: relative, bytes: contents.byteLength, sha256: createHash("sha256").update(contents).digest("hex") });
      }
    }
  };
  walk(dir, "");
  fs.writeFileSync(path.join(dir, "payload.json"), JSON.stringify({ manifestVersion: 1, version, files }, null, 2));
}

export interface Harness {
  service: MachineInstallerService;
  calls: MachineSshExecRequest[];
  uploads: Array<{ remoteDir: string }>;
  records: Map<string, MachineInstallRecord>;
  progress: MachineInstallSnapshot[];
  logged: Array<Record<string, unknown>>;
  syncedUp: string[];
  doctorCalls: Array<{ call: string; workerRoot?: string; options?: { requiredProviderKinds?: string[]; profileHome?: string } }>;
  waitedVersion: () => string | undefined;
}

export function harness(options: {
  probe?: string;
  probeAfter?: string;
  dependenciesFail?: string;
  drain?: string;
  connected?: boolean;
  mirror?: string;
  mirrorCopyError?: string;
  onMirrorCopy?: (request: import("../../remoteMirrorSync").RemoteMirrorSyncRequest) => Promise<void>;
  bundleDir?: string;
  doctor?: CloudRunWorkerDoctorReport;
  ownerFailure?: string | Error;
  probeFailure?: string | Error;
  getEnrollmentJson?: () => Promise<string>;
  restoreEnrollment?: (machineId: string, requested: string, installed: string, installedMachineId?: string) => Promise<string | void>;
  recoveryOutput?: string;
  readRecovery?: () => Promise<string>;
  beforeDrain?: (record: MachineInstallRecord, operationId: string, purpose: "update" | "key") => Promise<string | undefined>;
  machinePower?: (machineId: string) => Promise<AwsMachinePowerConfig | undefined>;
  powerRefusal?: string;
  powerFailure?: { exitCode: number | null; timedOut?: boolean };
  connectedSequence?: boolean[];
  revertFailure?: boolean;
  /** Fails sealing the key on the machine (the AWS check passed). */
  configureFailure?: { exitCode: number | null; timedOut?: boolean };
  adoptIdentity?: (machineId: string, identity: { originId: string; publicKeyDerBase64: string }) => Promise<void>;
  identityKnown?: (machineId: string) => Promise<boolean>;
  identityFailure?: string;
} = {}): Harness {
  const calls: MachineSshExecRequest[] = [];
  const uploads: Array<{ remoteDir: string }> = [];
  const records = new Map<string, MachineInstallRecord>();
  const progress: MachineInstallSnapshot[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const syncedUp: string[] = [];
  let activated = false;
  const doctorCalls: Harness["doctorCalls"] = [];
  let waitedForVersion: string | undefined;
  const bundleDir = options.bundleDir ?? bundleFixture();
  const activeReleaseAfter = releaseName(readMachineBundle(bundleDir));
  const report = options.doctor ?? { ok: true, message: "Machine ready.", checks: [] };
  const service = new MachineInstallerService({
    store: {
      async getMachineInstall(machineId) { return records.get(machineId); },
      async saveMachineInstall(record) { records.set(record.machineId, record); },
      async listMachineInstalls() { return [...records.values()]; }
    },
    doctor: {
      async diagnose(settings, doctorOptions) { doctorCalls.push({ call: "diagnose", workerRoot: settings.workerRoot, options: doctorOptions }); return report; },
      async setup(settings, onProgress, doctorOptions) {
        doctorCalls.push({ call: "setup", workerRoot: settings.workerRoot, options: doctorOptions });
        onProgress?.({ stage: "codex-auth", message: "Approve the Codex sign-in on the machine…", authUrl: "https://auth.example/device", authCode: "ABCD-1234" });
        return options.doctor ?? { ok: true, message: "Machine ready.", checks: [] };
      }
    },
    getEnrollmentJson: options.getEnrollmentJson ?? (async () => ENROLLMENT),
    restoreEnrollment: options.restoreEnrollment,
    waitForConnected: async (_machineId, _timeoutMs, expectAppVersion) => {
      waitedForVersion = expectAppVersion;
      if (options.connectedSequence?.length) return options.connectedSequence.shift()!;
      return options.connected !== false;
    },
    payload: { dir: bundleDir, source: "checkout" },
    machineName: async () => "cloud-box",
    beforeDrain: options.beforeDrain,
    machinePower: options.machinePower,
    adoptIdentity: options.adoptIdentity,
    identityKnown: options.identityKnown,
    now: () => new Date("2026-09-07T00:00:00.000Z"),
    logger: (event, payload) => logged.push({ event, ...payload }),
    sshExec: async (request) => {
      calls.push(request);
      if (request.script.includes(" --device-identity ")) {
        if (options.identityFailure) throw new Error(options.identityFailure);
        return `${JSON.stringify({ originId: "machine-origin", publicKeyDerBase64: "MACHINE-PUBLIC-KEY" })}\n`;
      }
      if (request.script.endsWith(" recover")) return options.readRecovery ? options.readRecovery() : options.recoveryOutput ?? "";
      if (options.ownerFailure && request.script.includes("environment-owner.json")) {
        throw typeof options.ownerFailure === "string" ? new Error(options.ownerFailure) : options.ownerFailure;
      }
      if (request.script.includes("mv -Tf")) activated = true;
      if (options.powerRefusal && request.script.includes("--check-power")) {
        throw new CommandError("ssh failed", { command: "ssh", args: [], stdout: "", stderr: `warning\n${options.powerRefusal}\n`, exitCode: MACHINE_POWER_REFUSED_EXIT_CODE, timedOut: false } as never);
      }
      if (options.powerFailure && request.script.includes("--check-power")) {
        throw new CommandError("ssh failed", { command: "ssh", args: [], stdout: "", stderr: "", exitCode: options.powerFailure.exitCode, timedOut: options.powerFailure.timedOut ?? false } as never);
      }
      if (options.configureFailure && request.script.includes("--configure-power")) {
        throw new CommandError("ssh failed", { command: "ssh", args: [], stdout: "", stderr: "", exitCode: options.configureFailure.exitCode, timedOut: options.configureFailure.timedOut ?? false } as never);
      }
      if (options.revertFailure && request.script.includes("--revert-power")) throw new Error("ssh: connection reset");
      if (request.script.includes("printf 'home=%s")) {
        if (options.probeFailure) throw typeof options.probeFailure === "string" ? new Error(options.probeFailure) : options.probeFailure;
        if (activated) {
          return options.probeAfter ?? probeOutput({
            state: JSON.stringify({ version: "1.4.0", digest: "new" }),
            "active-release": activeReleaseAfter ?? "",
            enrollment: "present",
            "service-scope": "system",
            "service-state": "active"
          });
        }
        return options.probe ?? probeOutput();
      }
      if (request.script.includes("printf 'drained=")) return options.drain ?? "drained=yes\nruntime-pids=\nsupervisor-pids=\nprovider-pids=\n";
      if (options.dependenciesFail && request.script.includes("npm install")) throw new Error(options.dependenciesFail);
      if (request.script.includes("journalctl")) return "machine.service: failed to start\n";
      if (request.script.includes("git -C")) return options.mirror ?? "path=/x\nstate=absent\n";
      return "";
    },
    uploadBundle: async (request) => { uploads.push({ remoteDir: request.remoteDir }); },
    mirrorSync: {
      async syncUp(request) {
        syncedUp.push(request.remotePath);
        await options.onMirrorCopy?.(request);
        if (options.mirrorCopyError) throw new Error(options.mirrorCopyError);
      },
      async syncDown() { throw new Error("syncDown must never run during a machine install."); }
    }
  });
  return { service, calls, uploads, records, progress, logged, syncedUp, doctorCalls, waitedVersion: () => waitedForVersion };
}

// ---- automatic stop key ----------------------------------------------------

export const POWER: AwsMachinePowerConfig = {
  version: 1,
  instanceId: "i-0943b28f7231ab93c",
  credentials: { accessKeyId: "AKIAPOWERKEY000000001", secretAccessKey: "POWER-SECRET-DO-NOT-LOG", region: "us-east-1" }
};

/** The instance itself, reached with its pinned host key. */
export const INSTANCE: MachineSshTarget = { ...TARGET, hostKeyAlias: `accordagents-${POWER.instanceId}` };
