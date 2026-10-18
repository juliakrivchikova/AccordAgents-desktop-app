// Installs the User's hub on the server her setup command created, over SSH
// from this desktop, and links the desktop to it. Setup and updates only:
// nothing here is reached from a chat.
//
// Order: reach the server -> its packages -> the hub program -> the owner
// (this desktop) -> the chats this desktop holds (first time only) -> the
// service -> a certificate for its address -> the hub answering over HTTPS
// -> the desktop linked. Each step is safe to run again, so a failed setup
// is finished by running it again.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseHubServerBlob, type HubServerBlob, type HubServerRecord, type HubSetupPhase, type HubSetupState } from "../../shared/hubSetup";
import type { HubHealth } from "../../shared/hubProtocol";
import { shellQuotePosix } from "./cloudRunWorkers";
import { CommandError, runCommand, type CommandOptions, type CommandResult } from "./command";
import { buildHubSetupCommand } from "./hubProvisioning";

export const HUB_SERVICE_NAME = "accordagents-hub";
const HUB_ROOT = "/opt/accordagents-hub";
const HUB_VAR = "/var/lib/accordagents-hub";
const HUB_DATA = `${HUB_VAR}/data`;
const HUB_TLS = `${HUB_VAR}/tls`;
const HUB_ACME = `${HUB_VAR}/acme`;
const HUB_SERVICE_USER = "accordhub";
const DEPLOY_HOOK = "/usr/local/sbin/accordagents-hub-cert-deploy";
const CERT_NAME = "accordagents-hub";

const CONNECT_TIMEOUT_MS = 8 * 60_000;
const STEP_TIMEOUT_MS = 20 * 60_000;
const SHORT_TIMEOUT_MS = 2 * 60_000;

type Run = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

export interface HubChatCopy {
  dir: string;
  /** This desktop's own events up to here are in the copy: the hub is not
   *  sent them again. */
  pushedThrough: number;
  conversations: number;
  cleanup(): Promise<void>;
}

export interface HubLinkRequest {
  url: string;
  hubId: string;
  server: HubServerRecord;
  /** Set when the chats were copied now: where this desktop's sending starts. */
  pushedThrough?: number;
}

export interface HubInstallerOptions {
  /** Where this desktop keeps its key for the server and the server's host key. */
  keyDir: string;
  /** The directory with accordagents-hub.cjs and its package.json. */
  payloadDir: () => string;
  bundledVersion: string;
  identity: () => Promise<{ originId: string; publicKeyDerBase64: string }>;
  exportChatCopy: () => Promise<HubChatCopy>;
  /** Saves the hub, sets this desktop's cursors and starts syncing. */
  link: (request: HubLinkRequest) => Promise<void>;
  currentLink: () => Promise<{ url?: string; server?: HubServerRecord } | undefined>;
  run?: Run;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, payload: Record<string, unknown>) => void;
}

export class HubInstaller {
  private current?: Promise<HubSetupState>;
  private snapshot: Omit<HubSetupState, "bundledVersion"> = { status: "none" };
  private readonly listeners = new Set<(state: HubSetupState) => void>();

  constructor(private readonly options: HubInstallerOptions) {}

  onProgress(listener: (state: HubSetupState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async state(): Promise<HubSetupState> {
    if (this.current) return this.withVersion(this.snapshot);
    const linked = await this.options.currentLink();
    if (this.snapshot.status === "failed") return this.withVersion({ ...this.snapshot, ...(linked?.url ? { url: linked.url, server: linked.server } : {}) });
    return this.withVersion(linked?.url ? { status: "ready", url: linked.url, ...(linked.server ? { server: linked.server } : {}) } : { status: "none" });
  }

  /** The command for Settings; it names this desktop's key for the server. */
  async command(region: string): Promise<string> {
    return buildHubSetupCommand(region, await this.publicKey());
  }

  /** One installation at a time; a second request joins the running one. */
  install(blobText: string): Promise<HubSetupState> {
    const server = parseHubServerBlob(blobText);
    this.current ??= this.installNow(server).finally(() => { this.current = undefined; });
    return this.current;
  }

  private withVersion(state: Omit<HubSetupState, "bundledVersion">): HubSetupState {
    return { ...state, bundledVersion: this.options.bundledVersion };
  }

  private progress(phase: HubSetupPhase, message: string, extra: Partial<HubSetupState> = {}): void {
    // A failure keeps the step it happened at, so Settings can say which.
    const failedAt = phase === "error" ? this.snapshot.phase : undefined;
    this.snapshot = {
      status: phase === "ready" ? "ready" : phase === "error" ? "failed" : "installing",
      phase: phase === "error" ? failedAt ?? "error" : phase,
      message, updatedAt: this.now().toISOString(), ...extra
    };
    this.options.log?.("hub.setup.progress", { phase: this.snapshot.phase, status: this.snapshot.status, message });
    const state = this.withVersion(this.snapshot);
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* a listener never breaks setup */ }
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    return (this.options.run ?? runCommand)(command, args, options);
  }

  private keyPath(): string {
    return path.join(this.options.keyDir, "id_ed25519");
  }

  /** This desktop's key for the server, made once. */
  async publicKey(): Promise<string> {
    await mkdir(this.options.keyDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.keyPath())) {
      await this.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "accordagents-hub", "-f", this.keyPath()], { timeoutMs: 30_000 });
    }
    return (await readFile(`${this.keyPath()}.pub`, "utf8")).trim();
  }

  private sshArgs(server: HubServerBlob): string[] {
    return [
      "-i", this.keyPath(),
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${path.join(this.options.keyDir, "known_hosts")}`,
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=8",
      "-o", "ServerAliveCountMax=3",
      `${server.user}@${server.ip}`
    ];
  }

  /** Runs a script on the server as root; stdout is returned. */
  private async remote(server: HubServerBlob, script: string, timeoutMs = STEP_TIMEOUT_MS, input?: string): Promise<string> {
    const result = await this.run("ssh", [...this.sshArgs(server), `sudo bash -c ${shellQuotePosix(script)}`], {
      timeoutMs,
      ...(input !== undefined ? { input } : {})
    });
    return result.stdout;
  }

  private async upload(server: HubServerBlob, localPath: string, remotePath: string): Promise<void> {
    await this.run("scp", [
      "-q", "-i", this.keyPath(), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${path.join(this.options.keyDir, "known_hosts")}`, "-o", "ConnectTimeout=15",
      localPath, `${server.user}@${server.ip}:${remotePath}`
    ], { timeoutMs: STEP_TIMEOUT_MS });
  }

  private async installNow(server: HubServerBlob): Promise<HubSetupState> {
    try {
      await this.publicKey();
      const linked = await this.options.currentLink();
      // A server this desktop has not used at this address: its host key is
      // learned again (the command just made or found it).
      if (linked?.server?.ip !== server.ip) {
        await this.run("ssh-keygen", ["-R", server.ip, "-f", path.join(this.options.keyDir, "known_hosts")], { timeoutMs: 15_000 }).catch(() => undefined);
      }

      this.progress("connecting", `Connecting to the server at ${server.ip}…`);
      await this.waitForSsh(server);

      this.progress("preparing", "Installing what the server needs (Node.js, sqlite3, certbot)…");
      await this.remote(server, hubPrepareScript());

      this.progress("uploading", "Copying the hub program…");
      const payloadDir = this.options.payloadDir();
      const version = await payloadVersion(payloadDir);
      const staging = `/tmp/accordagents-hub-${version.replace(/[^A-Za-z0-9._-]/g, "_")}`;
      await this.remote(server, `rm -rf ${staging} && install -d -o ${server.user} ${staging}`, SHORT_TIMEOUT_MS);
      for (const file of ["accordagents-hub.cjs", "package.json"]) await this.upload(server, path.join(payloadDir, file), `${staging}/${file}`);
      await this.remote(server, hubActivateScript(staging, version), SHORT_TIMEOUT_MS);

      this.progress("owner", "Making this computer the owner of the hub…");
      const identity = await this.options.identity();
      const ownerInput = JSON.stringify({ deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, name: "Desktop" });
      let owner = parseLastJson<{ ok?: boolean; reason?: string; hubId?: string; alreadyOwner?: boolean }>(
        await this.remote(server, hubSetOwnerScript(), SHORT_TIMEOUT_MS, ownerInput));
      if (!owner.ok && owner.reason === "another-owner") {
        // Set up from another desktop before: this one starts it over. Its
        // data is kept aside on the server, not deleted.
        this.options.log?.("hub.setup.owner-replaced", { ip: server.ip });
        await this.remote(server, hubStartOverScript(this.now().toISOString().replace(/[^0-9]/g, "")), SHORT_TIMEOUT_MS);
        owner = parseLastJson(await this.remote(server, hubSetOwnerScript(), SHORT_TIMEOUT_MS, ownerInput));
      }
      if (!owner.ok || typeof owner.hubId !== "string") throw new Error("The hub did not accept this computer as its owner.");
      const hubId = owner.hubId;

      let pushedThrough: number | undefined;
      if (!owner.alreadyOwner) {
        this.progress("chats", "Copying your chats to the hub…");
        const copy = await this.options.exportChatCopy();
        const archive = path.join(await mkdtemp(path.join(tmpdir(), "accordagents-hub-copy-")), "chats.tgz");
        try {
          await this.run("tar", ["-czf", archive, "-C", copy.dir, "."], { timeoutMs: STEP_TIMEOUT_MS });
          await this.upload(server, archive, "/tmp/accordagents-hub-chats.tgz");
          const imported = parseLastJson<{ ok?: boolean; conversations?: number }>(await this.remote(server, hubImportChatsScript("/tmp/accordagents-hub-chats.tgz")));
          if (!imported.ok) throw new Error("The hub did not take the chats.");
          this.options.log?.("hub.setup.chats", { exported: copy.conversations, imported: imported.conversations ?? 0 });
          pushedThrough = copy.pushedThrough;
        } finally {
          await rm(path.dirname(archive), { recursive: true, force: true }).catch(() => undefined);
          await copy.cleanup().catch(() => undefined);
        }
      }

      this.progress("starting", "Starting the hub…");
      await this.remote(server, hubServiceScript(), SHORT_TIMEOUT_MS);
      await this.waitForHealth(`http://${server.ip}`, hubId, "the hub over HTTP");

      this.progress("certificate", "Getting a certificate for the server's address…");
      await this.remote(server, hubCertificateScript(server.ip));

      this.progress("checking", "Checking the hub over HTTPS…");
      const url = `https://${server.ip}`;
      await this.waitForHealth(url, hubId, "the hub over HTTPS");

      const record: HubServerRecord = { ...server, installedAt: this.now().toISOString(), installedVersion: version };
      await this.options.link({ url, hubId, server: record, ...(pushedThrough !== undefined ? { pushedThrough } : {}) });
      this.progress("ready", "Your hub is ready.", { url, server: record });
      return this.withVersion(this.snapshot);
    } catch (error) {
      const message = setupFailure(error);
      this.options.log?.("hub.setup.error", { message });
      this.progress("error", message);
      return this.withVersion(this.snapshot);
    }
  }

  private async waitForSsh(server: HubServerBlob): Promise<void> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        // Ready means logged in as the server's user, and its first boot done.
        await this.run("ssh", [...this.sshArgs(server), "cloud-init status --wait >/dev/null 2>&1 || true; echo ready"], { timeoutMs: 6 * 60_000 });
        return;
      } catch (error) {
        last = error;
        await (this.options.sleep ?? delay)(10_000);
      }
    }
    throw new Error(`This computer could not log in to the server at ${server.ip}: ${setupFailure(last)}`);
  }

  private async waitForHealth(url: string, hubId: string, what: string): Promise<void> {
    const deadline = Date.now() + 90_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const response = await (this.options.fetchImpl ?? fetch)(`${url}/v1/health`, { signal: AbortSignal.timeout(10_000) });
        const health = await response.json() as HubHealth;
        if (response.ok && health.ok && health.hubId === hubId) return;
        last = `it answered ${response.status}${health.hubId && health.hubId !== hubId ? " as another hub" : ""}`;
      } catch (error) {
        last = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      }
      await (this.options.sleep ?? delay)(3_000);
    }
    throw new Error(`Could not reach ${what} at ${url}: ${last}`);
  }
}

/** The server's packages, each only when missing or too old. */
export function hubPrepareScript(): string {
  return [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "APT='apt-get -o DPkg::Lock::Timeout=600 -y -q'",
    // 512 MB of memory: swap keeps a large import or search from being killed.
    "if ! swapon --show | grep -q .; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && (grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab); fi",
    "need=''; for p in sqlite3 curl ca-certificates; do dpkg -s $p >/dev/null 2>&1 || need=\"$need $p\"; done",
    "if [ -n \"$need\" ]; then $APT update >/dev/null && $APT install $need >/dev/null; fi",
    "NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\\1/' || true)",
    "if [ -z \"$NODE_MAJOR\" ] || [ \"$NODE_MAJOR\" -lt 20 ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && $APT install nodejs >/dev/null; fi",
    // An IP address certificate needs certbot 5.4 or later (webroot for IPs).
    "if ! snap list certbot >/dev/null 2>&1; then snap install --classic certbot >/dev/null; else snap refresh certbot >/dev/null 2>&1 || true; fi",
    "ln -sf /snap/bin/certbot /usr/bin/certbot",
    `id -u ${HUB_SERVICE_USER} >/dev/null 2>&1 || useradd --system --home-dir ${HUB_VAR} --shell /usr/sbin/nologin ${HUB_SERVICE_USER}`,
    `install -d -o ${HUB_SERVICE_USER} -g ${HUB_SERVICE_USER} -m 750 ${HUB_VAR} ${HUB_DATA} ${HUB_TLS}`,
    `install -d -m 755 ${HUB_ACME} ${HUB_ROOT} ${HUB_ROOT}/releases`,
    "node -v >/dev/null && sqlite3 -version >/dev/null && certbot --version >/dev/null"
  ].join("\n");
}

/** Puts a staged release in place and points `current` at it. */
export function hubActivateScript(staging: string, version: string): string {
  const release = `${HUB_ROOT}/releases/${version.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  return [
    "set -e",
    `rm -rf ${release}.new && cp -r ${staging} ${release}.new && chmod 755 ${release}.new && chmod 644 ${release}.new/*`,
    `rm -rf ${release} && mv ${release}.new ${release}`,
    `ln -sfn ${release} ${HUB_ROOT}/current.new && mv -T ${HUB_ROOT}/current.new ${HUB_ROOT}/current`,
    `rm -rf ${staging}`
  ].join("\n");
}

function hubCli(args: string): string {
  return `sudo -u ${HUB_SERVICE_USER} node ${HUB_ROOT}/current/accordagents-hub.cjs --user-data ${HUB_DATA} ${args}`;
}

/** The owner's identity arrives on stdin. The service is stopped meanwhile:
 *  one process at a time writes the hub's data. */
export function hubSetOwnerScript(): string {
  return ["set -e", `systemctl stop ${HUB_SERVICE_NAME} 2>/dev/null || true`, hubCli("--set-owner")].join("\n");
}

/** Keeps the previous owner's data aside and starts with an empty hub. */
export function hubStartOverScript(stamp: string): string {
  return [
    "set -e",
    `systemctl stop ${HUB_SERVICE_NAME} 2>/dev/null || true`,
    `mv ${HUB_DATA} ${HUB_VAR}/data.replaced-${stamp.replace(/[^0-9]/g, "")}`,
    `install -d -o ${HUB_SERVICE_USER} -g ${HUB_SERVICE_USER} -m 750 ${HUB_DATA}`
  ].join("\n");
}

export function hubImportChatsScript(archive: string): string {
  const dir = `${HUB_VAR}/import`;
  return [
    "set -e",
    `systemctl stop ${HUB_SERVICE_NAME} 2>/dev/null || true`,
    `rm -rf ${dir} && install -d -o ${HUB_SERVICE_USER} -g ${HUB_SERVICE_USER} -m 700 ${dir}`,
    `tar -xzf ${archive} -C ${dir} && chown -R ${HUB_SERVICE_USER}:${HUB_SERVICE_USER} ${dir} && rm -f ${archive}`,
    hubCli(`--import-chat-copy ${dir}`),
    `rm -rf ${dir}`
  ].join("\n");
}

export function hubServiceUnit(): string {
  return [
    "[Unit]",
    "Description=AccordAgents hub",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `User=${HUB_SERVICE_USER}`,
    `Group=${HUB_SERVICE_USER}`,
    `ExecStart=/usr/bin/env node ${HUB_ROOT}/current/accordagents-hub.cjs --user-data ${HUB_DATA} --http-port 80 --https-port 443 --cert ${HUB_TLS}/fullchain.pem --key ${HUB_TLS}/privkey.pem --acme-webroot ${HUB_ACME}`,
    "AmbientCapabilities=CAP_NET_BIND_SERVICE",
    "CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "PrivateTmp=true",
    `ReadWritePaths=${HUB_VAR}`,
    "Environment=NODE_OPTIONS=--max-old-space-size=320",
    "Restart=always",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
}

export function hubServiceScript(): string {
  return [
    "set -e",
    `cat > /etc/systemd/system/${HUB_SERVICE_NAME}.service <<'UNIT'`,
    hubServiceUnit().trimEnd(),
    "UNIT",
    "systemctl daemon-reload",
    `systemctl enable ${HUB_SERVICE_NAME} >/dev/null 2>&1`,
    `systemctl restart ${HUB_SERVICE_NAME}`
  ].join("\n");
}

/**
 * A Let's Encrypt certificate for the address itself (six days, renewed by
 * certbot's timer two days before it ends). The hub serves the challenge on
 * port 80 and re-reads the certificate when it changes; only the first one
 * needs a restart, to open port 443.
 */
export function hubCertificateScript(ip: string): string {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error("Invalid server address.");
  return [
    "set -e",
    `cat > ${DEPLOY_HOOK} <<'HOOK'`,
    "#!/bin/sh",
    "set -e",
    `install -o ${HUB_SERVICE_USER} -g ${HUB_SERVICE_USER} -m 640 "$RENEWED_LINEAGE/fullchain.pem" ${HUB_TLS}/fullchain.pem.new`,
    `install -o ${HUB_SERVICE_USER} -g ${HUB_SERVICE_USER} -m 600 "$RENEWED_LINEAGE/privkey.pem" ${HUB_TLS}/privkey.pem.new`,
    `mv ${HUB_TLS}/privkey.pem.new ${HUB_TLS}/privkey.pem && mv ${HUB_TLS}/fullchain.pem.new ${HUB_TLS}/fullchain.pem`,
    "HOOK",
    `chmod 755 ${DEPLOY_HOOK}`,
    // Kept while it is for this address and has more than two days left.
    `if [ -f ${HUB_TLS}/fullchain.pem ] && openssl x509 -in ${HUB_TLS}/fullchain.pem -noout -checkend 172800 >/dev/null 2>&1 && openssl x509 -in ${HUB_TLS}/fullchain.pem -noout -ext subjectAltName 2>/dev/null | grep -q 'IP Address:${ip}$'; then echo kept; exit 0; fi`,
    `certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --preferred-profile shortlived --webroot --webroot-path ${HUB_ACME} --ip-address ${ip} --cert-name ${CERT_NAME} --deploy-hook ${DEPLOY_HOOK} --force-renewal >/dev/null`,
    `sed -i '/^renew_before_expiry/d' /etc/letsencrypt/renewal/${CERT_NAME}.conf && sed -i '1i renew_before_expiry = 2 days' /etc/letsencrypt/renewal/${CERT_NAME}.conf`,
    `[ -f ${HUB_TLS}/fullchain.pem ] || RENEWED_LINEAGE=/etc/letsencrypt/live/${CERT_NAME} ${DEPLOY_HOOK}`,
    `systemctl restart ${HUB_SERVICE_NAME}`,
    "echo issued"
  ].join("\n");
}

async function payloadVersion(dir: string): Promise<string> {
  if (!existsSync(path.join(dir, "accordagents-hub.cjs"))) throw new Error(`The hub program is missing from this app (${dir}).`);
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version) throw new Error("The hub program in this app has no version.");
  return pkg.version;
}

function parseLastJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").reverse().find((item) => item.trim().startsWith("{"));
  if (!line) throw new Error("The server did not answer the setup step.");
  return JSON.parse(line) as T;
}

/** A failure said in a sentence: the command's own last error line. */
export function setupFailure(error: unknown): string {
  if (error instanceof CommandError) {
    const detail = (error.result.stderr || error.result.stdout).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 400);
    return detail || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
