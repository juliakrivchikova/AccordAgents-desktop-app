import type {
  CloudRunWorkerCheck,
  CloudRunWorkerCheckId,
  CloudRunWorkerDoctorReport,
  CloudRunWorkerSettings,
  CloudRunWorkerSetupProgress
} from "../../shared/types";
import {
  buildCloudRunSshTarget,
  cloudRunSshOptionArgs,
  normalizeCloudRunWorkerSettings,
  shellQuotePosix
} from "./cloudRunWorkers";
import { runCommand } from "./command";
import type { RemoteRunWorkerTarget } from "./remoteRuns";

const PROBE_TIMEOUT_MS = 25_000;
const FIX_TIMEOUT_MS = 5 * 60_000;
const DEVICE_AUTH_TIMEOUT_MS = 5 * 60_000;

// Checks whose failure blocks remote runs outright. The rest degrade a
// specific capability (gh → no PR flow, build-essential → no native builds,
// sudo → no auto-fix, git identity → commits fail) and surface as warnings.
const REQUIRED_CHECKS: ReadonlySet<CloudRunWorkerCheckId> = new Set([
  "connect", "rsync", "git", "node", "codex", "codex-auth", "persistent-storage", "userns"
]);

const CHECK_LABELS: Record<CloudRunWorkerCheckId, string> = {
  "connect": "SSH connection",
  "sudo": "Passwordless sudo",
  "rsync": "rsync",
  "git": "git",
  "gh": "GitHub CLI",
  "java": "Java/JDK",
  "node": "Node.js",
  "build-essential": "Build tools",
  "codex": "Codex CLI",
  "codex-auth": "Codex signed in",
  "git-identity": "Git identity",
  "persistent-storage": "Persistent session storage",
  "userns": "Sandbox kernel setting"
};

export interface CloudRunSshExecRequest {
  worker: RemoteRunWorkerTarget;
  command: string;
  timeoutMs: number;
  onStdout?: (chunk: string) => void;
}

export interface CloudRunDoctorServiceOptions {
  // Injectable for tests. Returns stdout; throws on non-zero exit/timeouts.
  sshExec?: (request: CloudRunSshExecRequest) => Promise<string>;
  localGitIdentity?: () => Promise<{ name?: string; email?: string }>;
  openExternal?: (url: string) => void;
  logger?: (event: string, payload: Record<string, unknown>) => void;
}

export class CloudRunDoctorService {
  private readonly sshExec: (request: CloudRunSshExecRequest) => Promise<string>;
  private readonly localGitIdentity: () => Promise<{ name?: string; email?: string }>;
  private readonly openExternal?: (url: string) => void;
  private readonly logger?: (event: string, payload: Record<string, unknown>) => void;

  constructor(options: CloudRunDoctorServiceOptions = {}) {
    this.sshExec = options.sshExec ?? defaultSshExec;
    this.localGitIdentity = options.localGitIdentity ?? defaultLocalGitIdentity;
    this.openExternal = options.openExternal;
    this.logger = options.logger;
  }

  async diagnose(
    settings: CloudRunWorkerSettings,
    options: { requirePersistentStorage?: boolean } = {}
  ): Promise<CloudRunWorkerDoctorReport> {
    const worker = workerTarget(settings);
    if (!worker) {
      return failedReport("connect", "Worker host is not configured.");
    }
    let output: string;
    try {
      output = await this.sshExec({ worker, command: probeScript(worker), timeoutMs: PROBE_TIMEOUT_MS });
    } catch (error) {
      return failedReport("connect", sshConnectionFailureDetail(errorMessage(error)));
    }
    const checks = parseProbeOutput(output, options.requirePersistentStorage === true);
    const failing = checks.filter((check) => check.status === "fail");
    const warning = checks.filter((check) => check.status === "warn");
    const ok = failing.length === 0;
    const message = ok
      ? warning.length
        ? `Worker ready (${warning.length} warning${warning.length === 1 ? "" : "s"}).`
        : "Worker ready."
      : `${failing.length} check${failing.length === 1 ? "" : "s"} failing.`;
    return { ok, message, checks };
  }

  async setup(
    settings: CloudRunWorkerSettings,
    onProgress?: (progress: CloudRunWorkerSetupProgress) => void,
    options: { requirePersistentStorage?: boolean } = {}
  ): Promise<CloudRunWorkerDoctorReport> {
    const worker = workerTarget(settings);
    if (!worker) {
      return failedReport("connect", "Worker host is not configured.");
    }
    const progress = (stage: string, message: string, extra: Partial<CloudRunWorkerSetupProgress> = {}): void => {
      this.logger?.("cloud-runs.setup.progress", { stage, message });
      onProgress?.({ stage, message, ...extra });
    };

    progress("diagnose", "Checking the worker…");
    const before = await this.diagnose(settings, options);
    if (!before.checks.some((check) => check.status !== "pass")) {
      return before;
    }
    const status = new Map(before.checks.map((check) => [check.id, check.status] as const));
    const failing = (id: CloudRunWorkerCheckId): boolean => status.get(id) !== "pass" && status.get(id) !== undefined;
    if (failing("connect")) {
      return before;
    }
    const hasSudo = !failing("sudo");

    const aptPackages: string[] = [];
    if (failing("rsync")) aptPackages.push("rsync");
    if (failing("git")) aptPackages.push("git");
    if (failing("gh")) aptPackages.push("gh");
    if (failing("java")) aptPackages.push("openjdk-21-jdk");
    if (failing("build-essential")) aptPackages.push("build-essential");

    if ((aptPackages.length > 0 || failing("node") || failing("codex") || failing("userns")) && !hasSudo) {
      progress("sudo", "Missing tools need passwordless sudo to install; ask whoever owns the box to install the failing items.");
    }

    if (hasSudo) {
      if (aptPackages.length > 0) {
        progress("apt", `Installing ${aptPackages.join(", ")}…`);
        await this.fix(worker, `sudo -n DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${aptPackages.join(" ")}`);
      }
      if (failing("node")) {
        // Distro nodejs is too old for the codex npm wrapper; use NodeSource 22
        // to match the proven worker provisioning.
        progress("node", "Installing Node.js 22 (NodeSource)…");
        await this.fix(worker, "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -nE bash - && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs");
      }
      if (failing("codex")) {
        progress("codex", "Installing the Codex CLI…");
        await this.fix(worker, "sudo -n npm install -g @openai/codex");
      }
      if (failing("userns")) {
        progress("userns", "Allowing unprivileged user namespaces (required by the Codex sandbox)…");
        await this.fix(worker, "sudo -n sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 && printf 'kernel.apparmor_restrict_unprivileged_userns=0\\n' | sudo -n tee /etc/sysctl.d/99-accordagents-userns.conf > /dev/null");
      }
    }

    if (failing("git-identity")) {
      progress("git-identity", "Copying your git identity to the worker…");
      const identity = await this.localGitIdentity();
      const name = identity.name?.trim() || "AccordAgents Remote Agent";
      const email = identity.email?.trim() || "accordagents-remote@users.noreply.github.com";
      await this.fix(worker, `git config --global user.name ${shellQuotePosix(name)} && git config --global user.email ${shellQuotePosix(email)}`);
    }

    if (failing("codex-auth") && (!failing("codex") || hasSudo)) {
      await this.runDeviceAuth(worker, progress);
    }

    progress("diagnose", "Re-checking the worker…");
    return this.diagnose(settings, options);
  }

  async waitForCloudInit(
    settings: CloudRunWorkerSettings,
    onProgress?: (progress: CloudRunWorkerSetupProgress) => void
  ): Promise<void> {
    const worker = workerTarget(settings);
    if (!worker) throw new Error("Worker host is not configured.");
    onProgress?.({ stage: "cloud-init", message: "Waiting for the worker base image…" });
    await this.sshExec({
      worker,
      command: "command -v cloud-init >/dev/null 2>&1 && sudo -n cloud-init status --wait >/dev/null || true",
      timeoutMs: 10 * 60_000
    });
  }

  private async fix(worker: RemoteRunWorkerTarget, command: string): Promise<void> {
    await this.sshExec({ worker, command, timeoutMs: FIX_TIMEOUT_MS });
  }

  // Runs `codex login --device-auth` on the box, surfaces the verification URL
  // and code the moment codex prints them (and opens the URL locally), then
  // blocks until codex reports the login finished or the timeout hits.
  private async runDeviceAuth(
    worker: RemoteRunWorkerTarget,
    progress: (stage: string, message: string, extra?: Partial<CloudRunWorkerSetupProgress>) => void
  ): Promise<void> {
    progress("codex-auth", "Starting Codex sign-in on the worker…");
    let buffered = "";
    let authUrl: string | undefined;
    let authCode: string | undefined;
    let opened = false;
    let lastProgressKey = "";
    const codexPath = worker.codexPath?.trim() || "codex";
    try {
      await this.sshExec({
        worker,
        command: `${shellQuotePosix(codexPath)} login --device-auth < /dev/null 2>&1`,
        timeoutMs: DEVICE_AUTH_TIMEOUT_MS,
        onStdout: (chunk) => {
          buffered += chunk;
          const visible = stripAnsi(buffered);
          authUrl ??= visible.match(/https:\/\/\S+/)?.[0];
          authCode ??= visible.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/)?.[1];
          if (!authUrl) {
            return;
          }
          const progressKey = `${authUrl}:${authCode ?? ""}`;
          if (progressKey !== lastProgressKey) {
            lastProgressKey = progressKey;
            progress("codex-auth", authCode
              ? "Approve the Codex sign-in with the device code."
              : "Approve the Codex sign-in; waiting for the device code…", { authUrl, authCode });
          }
          if (!opened) {
            opened = true;
            this.openExternal?.(authUrl);
          }
        }
      });
      progress("codex-auth", "Codex sign-in completed.");
    } catch (error) {
      progress("codex-auth", `Codex sign-in did not complete: ${errorMessage(error)}`);
    }
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function workerTarget(settings: CloudRunWorkerSettings): RemoteRunWorkerTarget | undefined {
  const normalized = normalizeCloudRunWorkerSettings(settings);
  return normalized.host ? (normalized as RemoteRunWorkerTarget & { host: string }) : undefined;
}

// One SSH round-trip probing everything; each line is `key=value`.
function probeScript(worker: RemoteRunWorkerTarget): string {
  const codexPath = worker.codexPath?.trim() || "codex";
  const workerRoot = worker.workerRoot?.trim() || "~/.accordagents/remote-runs";
  const workerRootExpression = workerRoot.startsWith("/")
    ? shellQuotePosix(workerRoot)
    : workerRoot === "~"
      ? '"$HOME"'
      : `"$HOME"/${shellQuotePosix(workerRoot.replace(/^~\//, ""))}`;
  return [
    "have() { command -v \"$2\" >/dev/null 2>&1 && printf '%s=ok\\n' \"$1\" || printf '%s=missing\\n' \"$1\"; }",
    "have rsync rsync",
    "have git git",
    "have gh gh",
    "have java java",
    "have node node",
    `have codex ${shellQuotePosix(codexPath)}`,
    "dpkg -s build-essential >/dev/null 2>&1 && printf 'build-essential=ok\\n' || printf 'build-essential=missing\\n'",
    "sudo -n true 2>/dev/null && printf 'sudo=ok\\n' || printf 'sudo=missing\\n'",
    "printf 'userns=%s\\n' \"$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || printf unknown)\"",
    "printf 'git-name=%s\\n' \"$(git config --global user.name 2>/dev/null | head -c 80)\"",
    "printf 'git-email=%s\\n' \"$(git config --global user.email 2>/dev/null | head -c 80)\"",
    `is_ebs_path() { source="$(findmnt -n -o SOURCE -T "$1" 2>/dev/null)"; [ -n "$source" ] || return 1; device="$(readlink -f "$source" 2>/dev/null || printf '%s' "$source")"; lsblk -s -n -o SERIAL "$device" 2>/dev/null | tr -d '-' | grep -Eq '^vol[0-9a-fA-F]+'; }; worker_root=${workerRootExpression}; codex_home="\${CODEX_HOME:-$HOME/.codex}"; mkdir -p "$worker_root" "$codex_home"; worker_mount="$(findmnt -n -o SOURCE,FSTYPE -T "$worker_root" 2>/dev/null | head -c 200)"; codex_mount="$(findmnt -n -o SOURCE,FSTYPE -T "$codex_home" 2>/dev/null | head -c 200)"; if is_ebs_path "$worker_root" && is_ebs_path "$codex_home"; then printf 'persistent-storage=ok\\n'; else printf 'persistent-storage=missing\\n'; fi; printf 'storage-detail=%s | %s\\n' "$worker_mount" "$codex_mount"`,
    `${shellQuotePosix(codexPath)} login status >/dev/null 2>&1 && printf 'codex-auth=ok\\n' || printf 'codex-auth=missing\\n'`
  ].join("; ");
}

function parseProbeOutput(output: string, requirePersistentStorage: boolean): CloudRunWorkerCheck[] {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  const tool = (id: CloudRunWorkerCheckId, fixable: boolean, missingDetail: string): CloudRunWorkerCheck => ({
    id,
    label: CHECK_LABELS[id],
    status: values.get(id) === "ok" ? "pass" : REQUIRED_CHECKS.has(id) ? "fail" : "warn",
    detail: values.get(id) === "ok" ? undefined : missingDetail,
    fixable
  });

  const checks: CloudRunWorkerCheck[] = [
    { id: "connect", label: CHECK_LABELS.connect, status: "pass" }
  ];
  checks.push(tool("sudo", false, "Automatic fixes need passwordless sudo."));
  checks.push(tool("rsync", true, "Needed to sync your project to the worker."));
  checks.push(tool("git", true, "Needed for the agent to commit and push."));
  checks.push(tool("gh", true, "Needed for the agent to open pull requests."));
  checks.push(tool("java", true, "Needed to verify Java, Maven, and Gradle projects."));
  checks.push(tool("node", true, "Needed to run the detached worker."));
  checks.push(tool("build-essential", true, "Needed to build native npm dependencies."));
  checks.push(tool("codex", true, "The remote agent runtime."));
  checks.push({
    id: "persistent-storage",
    label: CHECK_LABELS["persistent-storage"],
    status: values.get("persistent-storage") === "ok" ? "pass" : requirePersistentStorage ? "fail" : "warn",
    detail: values.get("persistent-storage") === "ok"
      ? values.get("storage-detail") || "Worker and Codex session paths use persistent storage."
      : "workerRoot and the Codex session store must not use tmpfs, overlay, instance-store, or another volatile filesystem.",
    fixable: false
  });

  const userns = values.get("userns");
  checks.push({
    id: "userns",
    label: CHECK_LABELS.userns,
    status: userns === "0" ? "pass" : "fail",
    detail: userns === "0"
      ? undefined
      : "kernel.apparmor_restrict_unprivileged_userns must be 0 for the Codex sandbox.",
    fixable: true
  });

  const hasIdentity = Boolean(values.get("git-name")) && Boolean(values.get("git-email"));
  checks.push({
    id: "git-identity",
    label: CHECK_LABELS["git-identity"],
    status: hasIdentity ? "pass" : "warn",
    detail: hasIdentity ? values.get("git-name") : "Commits on the worker need a git user.name/email.",
    fixable: true
  });

  checks.push({
    id: "codex-auth",
    label: CHECK_LABELS["codex-auth"],
    status: values.get("codex-auth") === "ok" ? "pass" : "fail",
    detail: values.get("codex-auth") === "ok" ? undefined : "Codex is not signed in on the worker.",
    fixable: true
  });
  return checks;
}

function failedReport(id: CloudRunWorkerCheckId, detail: string): CloudRunWorkerDoctorReport {
  return {
    ok: false,
    message: detail,
    checks: [{ id, label: CHECK_LABELS[id], status: "fail", detail }]
  };
}

async function defaultSshExec(request: CloudRunSshExecRequest): Promise<string> {
  const target = buildCloudRunSshTarget(request.worker);
  const result = await runCommand("ssh", [
    "-o",
    "ConnectTimeout=10",
    ...cloudRunSshOptionArgs(request.worker),
    target,
    request.command
  ], {
    timeoutMs: request.timeoutMs,
    onStdout: request.onStdout
  });
  return result.stdout;
}

async function defaultLocalGitIdentity(): Promise<{ name?: string; email?: string }> {
  const read = async (key: string): Promise<string | undefined> => {
    try {
      const result = await runCommand("git", ["config", "--global", key], { timeoutMs: 10_000 });
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  return { name: await read("user.name"), email: await read("user.email") };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sshConnectionFailureDetail(message: string): string {
  if (isLikelyAwsKeyMismatch(message)) {
    return `SSH connection failed: ${message} This looks like the local AWS worker private key is missing or does not match the EC2 key pair. Delete and recreate the AWS worker; EC2 key pairs are only applied when an instance is launched.`;
  }
  return `SSH connection failed: ${message}`;
}

function isLikelyAwsKeyMismatch(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("permission denied (publickey)")
    || lower.includes("identity file") && lower.includes("not accessible")
    || lower.includes(".pem") && lower.includes("no such file");
}
