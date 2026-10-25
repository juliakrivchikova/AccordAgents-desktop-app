// Installs the User's hub on the server her setup command created, over SSH
// from this desktop, and links the desktop to it. Setup and updates only:
// nothing here is reached from a chat.
//
// Order: reach the server -> its packages -> the hub program -> the owner
// (this desktop) -> the chats this desktop holds (until a copy is in) -> the
// service -> a certificate for its address -> the hub answering over HTTPS
// -> the desktop linked. Each step is safe to run again, so a failed setup
// is finished by running it again.
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isHubServerAddress,
  parseHubServerBlob,
  type HubInstallRequest,
  type HubLinkConfig,
  type HubServerBlob,
  type HubServerRecord,
  type HubSetupPhase,
  type HubSetupState
} from "../../shared/hubSetup";
import type { HubHealth } from "../../shared/hubProtocol";
import { shellQuotePosix } from "./cloudRunWorkers";
import { CommandError, runCommand, type CommandOptions, type CommandResult } from "./command";
import { buildHubSetupCommand } from "./hubProvisioning";

const HUB_SERVICE_NAME = "accordagents-hub";
const HUB_ROOT = "/opt/accordagents-hub";
// Root's: the service can read here but not rename or replace anything, so
// nothing root does later (setup, certificate renewal) is pointed elsewhere.
const HUB_VAR = "/var/lib/accordagents-hub";
const HUB_ACME = `${HUB_VAR}/acme`;
const HUB_IMPORT = `${HUB_VAR}/import`;
// The service's own, and the only place it writes.
const HUB_DATA = `${HUB_VAR}/data`;
const HUB_TLS = "/etc/accordagents-hub/tls";
const HUB_SERVICE_USER = "accordhub";
const DEPLOY_HOOK = "/usr/local/sbin/accordagents-hub-cert-deploy";
const CERT_NAME = "accordagents-hub";
/** The certificate lives six days; it is renewed this long before its end. */
const CERT_RENEW_BEFORE_DAYS = 2;
const NODE_MAJOR = 22;
const MIN_NODE_MAJOR = 20;
/** Of the server's 512 MB: what the hub's JavaScript may use, swap beside it. */
const HUB_HEAP_MB = 320;
/** Longer than any setup keeps the hub stopped (the chat import's step). */
const RESTART_GUARD_MIN = 45;

const CONNECT_TIMEOUT_MS = 8 * 60_000;
const CONNECT_ATTEMPT_TIMEOUT_MS = 6 * 60_000;
const CONNECT_RETRY_MS = 10_000;
const STEP_TIMEOUT_MS = 20 * 60_000;
const SHORT_TIMEOUT_MS = 2 * 60_000;
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_RETRY_MS = 3_000;
/** A command's label is good for a day: long enough to run it, not forever. */
const NONCE_TTL_MS = 24 * 60 * 60_000;
/** Commands shown and not run yet that still count (a dialog opened again). */
const REMEMBERED_COMMANDS = 10;

/** Where a setup keeps the chat copy and its archive while it sends them. */
export const HUB_COPY_TEMP_PREFIX = "accordagents-hub-copy-";
const HUB_ARCHIVE_TEMP_PREFIX = "accordagents-hub-archive-";
/** Older than any setup runs: a copy left by one that never finished. */
const STALE_TEMP_MS = 6 * 60 * 60_000;

type Run = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

/**
 * Removes chat copies a setup left behind (the app quit or crashed in the
 * middle of one). They hold the User's chats, so they are not left to the
 * system's own cleaning. Only old ones: another running app may be in a
 * setup of its own right now.
 */
export async function removeStaleHubTemp(dir = tmpdir(), now = Date.now()): Promise<number> {
  let removed = 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(HUB_COPY_TEMP_PREFIX) && !name.startsWith(HUB_ARCHIVE_TEMP_PREFIX)) continue;
    const full = path.join(dir, name);
    const info = await stat(full).catch(() => undefined);
    if (!info?.isDirectory() || now - info.mtimeMs < STALE_TEMP_MS) continue;
    await rm(full, { recursive: true, force: true }).then(() => { removed += 1; }, () => undefined);
  }
  return removed;
}

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
  currentLink: () => Promise<HubLinkConfig | undefined>;
  /** Whether the desktop reaches the hub now (undefined: not linked). */
  reachable?: () => boolean | undefined;
  /** Plain lines about the server's readers for Settings (a device that has
   *  not read for long, changes held for long). */
  notices?: () => Promise<string[]>;
  defaultRegion?: () => Promise<string | undefined>;
  run?: Run;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, payload: Record<string, unknown>) => void;
}

/** Why setup stopped for the User to decide, not because something broke. */
class HubSetupQuestion extends Error {
  constructor(readonly reason: "another-owner", message: string) {
    super(message);
  }
}

export class HubInstaller {
  private current?: Promise<HubSetupState>;
  private nonceWrites: Promise<void> = Promise.resolve();
  /** The server the User was last asked to start over, if any: her yes is
   *  for that server only. */
  private askedStartOver?: string;
  private snapshot: Omit<HubSetupState, "bundledVersion"> = { status: "none" };
  private readonly listeners = new Set<(state: HubSetupState) => void>();

  constructor(private readonly options: HubInstallerOptions) {}

  onProgress(listener: (state: HubSetupState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async state(): Promise<HubSetupState> {
    const defaultRegion = await this.options.defaultRegion?.().catch(() => undefined);
    const extra = defaultRegion ? { defaultRegion } : {};
    if (this.current) return this.withVersion({ ...this.snapshot, ...extra });
    const linked = await this.options.currentLink();
    const reachable = this.options.reachable?.();
    const notices = linked?.url ? await this.options.notices?.().catch(() => []) ?? [] : [];
    const link = linked?.url ? {
      url: linked.url, ...(linked.server ? { server: linked.server } : {}), ...(reachable !== undefined ? { reachable } : {}),
      ...(notices.length ? { notices } : {})
    } : {};
    if (this.snapshot.status === "failed") return this.withVersion({ ...this.snapshot, ...link, ...extra });
    return this.withVersion(linked?.url ? { status: "ready", ...link, ...extra } : { status: "none", ...extra });
  }

  /** The command for Settings; it names this desktop's key for the server
   *  and a label the line it prints must carry. */
  async command(region: string): Promise<string> {
    const nonce = randomBytes(18).toString("base64url");
    const command = buildHubSetupCommand(region, await this.publicKey(), nonce);
    await this.rememberNonce(nonce);
    return command;
  }

  /** One installation at a time; a second request joins the running one.
   *  Without a line, the server this desktop already uses is updated. */
  async install(request: HubInstallRequest): Promise<HubSetupState> {
    if (this.current) return this.current;
    let server: HubServerBlob;
    if (request.blob?.trim()) {
      server = parseHubServerBlob(request.blob);
      if (!server.nonce || !(await this.knownNonce(server.nonce))) {
        throw new Error("This line was not printed by the command this computer showed. Copy the command again, run it, and paste its last line.");
      }
    } else {
      const linked = await this.options.currentLink();
      if (!linked?.server || !isHubServerAddress(linked.server)) throw new Error("No server is set up yet.");
      const { installedAt: _installedAt, installedVersion: _installedVersion, ...rest } = linked.server;
      server = rest;
    }
    const startOver = request.startOver === true && this.askedStartOver === server.ip;
    this.current ??= this.installNow(server, startOver).finally(() => { this.current = undefined; });
    return this.current;
  }

  private withVersion(state: Omit<HubSetupState, "bundledVersion">): HubSetupState {
    return { ...state, bundledVersion: this.options.bundledVersion };
  }

  private emit(): void {
    const state = this.withVersion(this.snapshot);
    for (const listener of this.listeners) {
      try { listener(state); } catch { /* a listener never breaks setup */ }
    }
  }

  private progress(phase: HubSetupPhase, message: string, extra: Partial<HubSetupState> = {}): void {
    // A failure keeps the step it happened at, so Settings can say which.
    const failedAt = phase === "error" ? this.snapshot.phase : undefined;
    this.snapshot = {
      status: phase === "ready" ? "ready" : phase === "error" ? "failed" : "installing",
      phase: phase === "error" ? failedAt ?? "error" : phase,
      message, updatedAt: this.now().toISOString(),
      ...(this.snapshot.skipped?.length && phase !== "connecting" ? { skipped: this.snapshot.skipped } : {}),
      ...extra
    };
    this.options.log?.("hub.setup.progress", { phase: this.snapshot.phase, status: this.snapshot.status, message });
    this.emit();
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

  private knownHostsPath(): string {
    return path.join(this.options.keyDir, "known_hosts");
  }

  /** This desktop's key for the server, made once. */
  async publicKey(): Promise<string> {
    await mkdir(this.options.keyDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.keyPath())) {
      await this.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "accordagents-hub", "-f", this.keyPath()], { timeoutMs: 30_000 });
    }
    return (await readFile(`${this.keyPath()}.pub`, "utf8")).trim();
  }

  private commandsPath(): string {
    return path.join(this.options.keyDir, "commands.json");
  }

  private async nonces(): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(this.commandsPath(), "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private rememberNonce(nonce: string): Promise<void> {
    // One at a time: two commands asked at once (the dialog opened, the
    // region changed) both stay valid.
    const write = this.nonceWrites.then(() => this.writeNonce(nonce));
    this.nonceWrites = write.catch(() => undefined);
    return write;
  }

  private async writeNonce(nonce: string): Promise<void> {
    const now = this.now().getTime();
    const kept = Object.fromEntries(Object.entries(await this.nonces()).filter(([, at]) => now - at < NONCE_TTL_MS).slice(-(REMEMBERED_COMMANDS - 1)));
    await writeFile(this.commandsPath(), JSON.stringify({ ...kept, [nonce]: now }), { mode: 0o600 });
  }

  private async knownNonce(nonce: string): Promise<boolean> {
    const at = (await this.nonces())[nonce];
    return typeof at === "number" && this.now().getTime() - at < NONCE_TTL_MS;
  }

  /** SSH options for both ssh and scp: this desktop's key, the server's
   *  pinned host keys, and keepalives so a stalled transfer ends. */
  private sshOptions(): string[] {
    return [
      "-i", this.keyPath(),
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      // Quoted: ssh reads this value as a list of files separated by spaces,
      // and the app's folder is in "Application Support".
      "-o", `UserKnownHostsFile=${sshQuoted(this.knownHostsPath())}`,
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=8",
      "-o", "ServerAliveCountMax=3"
    ];
  }

  private sshArgs(server: HubServerBlob): string[] {
    return [...this.sshOptions(), `${server.user}@${server.ip}`];
  }

  /** Trusts exactly the host keys AWS reported for the server, never the
   *  first key a server presents: the chats go to it before anything else
   *  proves which server it is. An update keeps the keys pinned at setup. */
  private async pinHostKeys(server: HubServerBlob, linked: HubLinkConfig | undefined): Promise<void> {
    if (server.hostKeys?.length) {
      // Another server's keys stay (a line pasted for a new server does not
      // lock out the one in use if its setup fails).
      const others = (await readFile(this.knownHostsPath(), "utf8").catch(() => "")).split("\n").filter((line) => line && !line.startsWith(`${server.ip} `));
      await writeFile(this.knownHostsPath(), [...others, ...server.hostKeys.map((key) => `${server.ip} ${key}`)].join("\n") + "\n", { mode: 0o600 });
      return;
    }
    const pinned = linked?.server?.ip === server.ip
      ? (await readFile(this.knownHostsPath(), "utf8").catch(() => "")).split("\n").some((line) => line.startsWith(`${server.ip} `))
      : false;
    if (!pinned) throw new Error("This computer does not know the server's keys. Copy the setup command again, run it, and paste its last line.");
  }

  /** Runs a script on the server as root; stdout is returned. */
  private async remote(server: HubServerBlob, script: string, timeoutMs = STEP_TIMEOUT_MS, input?: { text?: string; file?: string }): Promise<string> {
    // A file that cannot be read ends the input early (runCommand), and the
    // step fails with the read error.
    const stream = input?.file ? createReadStream(input.file) : undefined;
    stream?.on("error", (error) => { this.options.log?.("hub.setup.upload-error", { message: error.message }); });
    const result = await this.run("ssh", [...this.sshArgs(server), `sudo bash -c ${shellQuotePosix(script)}`], {
      timeoutMs,
      ...(input?.text !== undefined ? { input: input.text } : {}),
      ...(stream ? { inputStream: stream } : {})
    });
    return result.stdout;
  }

  private async upload(server: HubServerBlob, localPath: string, remotePath: string): Promise<void> {
    await this.run("scp", ["-q", ...this.sshOptions(), localPath, `${server.user}@${server.ip}:${remotePath}`], { timeoutMs: STEP_TIMEOUT_MS });
  }

  private async installNow(server: HubServerBlob, startOver: boolean): Promise<HubSetupState> {
    // A new run starts clean: a failure before the first step is this run's.
    this.progress("connecting", `Connecting to the server at ${server.ip}…`);
    let serviceMayBeStopped = false;
    try {
      await this.publicKey();
      const linked = await this.options.currentLink();
      await this.pinHostKeys(server, linked);
      await this.waitForSsh(server);

      this.progress("preparing", "Installing what the server needs (Node.js, sqlite3, certbot)…");
      await this.remote(server, hubPrepareScript());

      this.progress("uploading", "Copying the hub program…");
      const payloadDir = this.options.payloadDir();
      const version = await payloadVersion(payloadDir);
      const staging = `/home/${server.user}/accordagents-hub-${releaseName(version)}`;
      await this.run("ssh", [...this.sshArgs(server), `rm -rf ${staging} && mkdir -m 700 ${staging}`], { timeoutMs: SHORT_TIMEOUT_MS });
      for (const file of ["accordagents-hub.cjs", "package.json"]) await this.upload(server, path.join(payloadDir, file), `${staging}/${file}`);
      await this.remote(server, hubActivateScript(staging, version), SHORT_TIMEOUT_MS);

      this.progress("owner", "Making this computer the owner of the hub…");
      const identity = await this.options.identity();
      const ownerInput = { text: JSON.stringify({ deviceId: identity.originId, publicKeyDerBase64: identity.publicKeyDerBase64, name: "Desktop" }) };
      serviceMayBeStopped = true;
      let owner = parseLastJson<HubOwnerAnswer>(await this.remote(server, hubSetOwnerScript(), SHORT_TIMEOUT_MS, ownerInput));
      if (!owner.ok && owner.reason === "another-owner") {
        if (!startOver) {
          this.askedStartOver = server.ip;
          throw new HubSetupQuestion("another-owner", "This server was set up from another computer. Start it over for this one? Its data stays on the server, kept aside, not deleted.");
        }
        this.options.log?.("hub.setup.owner-replaced", { ip: server.ip });
        await this.remote(server, hubStartOverScript(this.now().toISOString()), SHORT_TIMEOUT_MS);
        owner = parseLastJson<HubOwnerAnswer>(await this.remote(server, hubSetOwnerScript(), SHORT_TIMEOUT_MS, ownerInput));
      }
      if (!owner.ok || typeof owner.hubId !== "string") throw new Error("The hub did not accept this computer as its owner.");
      const hubId = owner.hubId;

      let pushedThrough: number | undefined;
      // The copy is skipped only when this desktop is already linked to this
      // very hub: a copy taken by a setup that never linked is taken again
      // (what this desktop wrote since may be gone from it by now).
      if (owner.alreadyOwner && owner.chatsCopied && linked?.hubId === hubId) {
        this.snapshot = { ...this.snapshot, skipped: ["chats"] };
      } else {
        this.progress("chats", "Copying your chats to the hub…");
        const copy = await this.options.exportChatCopy();
        let archiveDir: string | undefined;
        try {
          archiveDir = await mkdtemp(path.join(tmpdir(), HUB_ARCHIVE_TEMP_PREFIX));
          const archive = path.join(archiveDir, "chats.tgz");
          // macOS file tags would come out as warnings in the server's answer.
          await this.run("tar", ["--no-xattrs", "-czf", archive, "-C", copy.dir, "."], { timeoutMs: STEP_TIMEOUT_MS });
          // Streamed into the server's root-only import directory: never left
          // in a place another account on the server could read.
          const imported = parseLastJson<{ ok?: boolean; conversations?: number }>(await this.remote(server, hubImportChatsScript(), STEP_TIMEOUT_MS, { file: archive }));
          if (!imported.ok) throw new Error("The hub did not take the chats.");
          this.options.log?.("hub.setup.chats", { exported: copy.conversations, imported: imported.conversations ?? 0 });
          pushedThrough = copy.pushedThrough;
        } finally {
          if (archiveDir) await rm(archiveDir, { recursive: true, force: true }).catch(() => undefined);
          await copy.cleanup().catch(() => undefined);
        }
      }

      this.progress("starting", "Starting the hub…");
      await this.remote(server, hubServiceScript(), SHORT_TIMEOUT_MS);
      serviceMayBeStopped = false;
      await this.waitForHealth(`http://${server.ip}`, hubId, "the hub over HTTP");

      this.progress("certificate", "Getting a certificate for the server's address…");
      await this.remote(server, hubCertificateScript(server.ip));

      this.progress("checking", "Checking the hub over HTTPS…");
      const url = `https://${server.ip}`;
      await this.waitForHealth(url, hubId, "the hub over HTTPS");

      const { nonce: _nonce, hostKeys: _hostKeys, ...where } = server;
      const record: HubServerRecord = { ...where, installedAt: this.now().toISOString(), installedVersion: version };
      await this.options.link({ url, hubId, server: record, ...(pushedThrough !== undefined ? { pushedThrough } : {}) });
      this.progress("ready", "Your hub is ready.", { url, server: record });
      return this.withVersion(this.snapshot);
    } catch (error) {
      if (serviceMayBeStopped) {
        // A hub that was running before this attempt runs again after it.
        await this.remote(server, `systemctl cat ${HUB_SERVICE_NAME} >/dev/null 2>&1 && systemctl start ${HUB_SERVICE_NAME} || true`, SHORT_TIMEOUT_MS).catch(() => undefined);
      }
      const message = setupFailure(error);
      this.options.log?.("hub.setup.error", { message });
      this.progress("error", message, error instanceof HubSetupQuestion ? { reason: error.reason } : {});
      return this.withVersion(this.snapshot);
    }
  }

  private async waitForSsh(server: HubServerBlob): Promise<void> {
    const deadline = this.now().getTime() + CONNECT_TIMEOUT_MS;
    let last: unknown;
    while (this.now().getTime() < deadline) {
      try {
        // Ready means logged in as the server's user, and its first boot done.
        await this.run("ssh", [...this.sshArgs(server), "cloud-init status --wait >/dev/null 2>&1 || true; echo ready"], { timeoutMs: CONNECT_ATTEMPT_TIMEOUT_MS });
        return;
      } catch (error) {
        last = error;
        await (this.options.sleep ?? delay)(CONNECT_RETRY_MS);
      }
    }
    throw new Error(`This computer could not log in to the server at ${server.ip}: ${setupFailure(last)}`);
  }

  private async waitForHealth(url: string, hubId: string, what: string): Promise<void> {
    const deadline = this.now().getTime() + HEALTH_TIMEOUT_MS;
    let last = "";
    while (this.now().getTime() < deadline) {
      try {
        const response = await (this.options.fetchImpl ?? fetch)(`${url}/v1/health`, { signal: AbortSignal.timeout(10_000) });
        const health = await response.json() as HubHealth;
        if (response.ok && health.ok && health.hubId === hubId) return;
        last = `it answered ${response.status}${health.hubId && health.hubId !== hubId ? " as another hub" : ""}`;
      } catch (error) {
        last = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      }
      await (this.options.sleep ?? delay)(HEALTH_RETRY_MS);
    }
    throw new Error(`Could not reach ${what} at ${url}: ${last}`);
  }
}

interface HubOwnerAnswer {
  ok?: boolean;
  reason?: string;
  hubId?: string;
  alreadyOwner?: boolean;
  chatsCopied?: boolean;
}

function releaseName(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Refuses to go on when a path root is about to use was swapped for a link. */
function noLink(...paths: string[]): string {
  return paths.map((item) => `[ ! -L ${item} ] || { echo "${item} is a link; refusing to continue." >&2; exit 1; }`).join("\n");
}

/** The server's packages, each only when missing or too old, and its
 *  directories (root's, except the service's own data). */
export function hubPrepareScript(): string {
  return [
    "set -eo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "APT='apt-get -o DPkg::Lock::Timeout=600 -y -q'",
    // 512 MB of memory: swap keeps a large import or search from being killed.
    "if ! swapon --show | grep -q .; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && (grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab); fi",
    "need=''; for p in sqlite3 curl ca-certificates gnupg; do dpkg -s $p >/dev/null 2>&1 || need=\"$need $p\"; done",
    "if [ -n \"$need\" ]; then $APT update >/dev/null && $APT install $need >/dev/null; fi",
    "NODE_HAVE=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\\1/' || true)",
    // NodeSource's signed apt repository, not a script piped to a shell.
    `if [ -z "$NODE_HAVE" ] || [ "$NODE_HAVE" -lt ${MIN_NODE_MAJOR} ]; then`,
    "  install -d -m 755 /etc/apt/keyrings",
    "  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg",
    `  echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main' > /etc/apt/sources.list.d/nodesource.list`,
    "  $APT update >/dev/null && $APT install nodejs >/dev/null",
    "fi",
    // An IP address certificate needs certbot 5.4 or later (webroot for IPs).
    "if ! snap list certbot >/dev/null 2>&1; then snap install --classic certbot >/dev/null; else snap refresh certbot >/dev/null 2>&1 || true; fi",
    "ln -sf /snap/bin/certbot /usr/bin/certbot",
    `id -u ${HUB_SERVICE_USER} >/dev/null 2>&1 || useradd --system --home-dir ${HUB_DATA} --shell /usr/sbin/nologin ${HUB_SERVICE_USER}`,
    noLink(HUB_VAR, HUB_DATA, HUB_ACME, HUB_IMPORT, "/etc/accordagents-hub", HUB_TLS),
    `install -d -o root -g root -m 755 ${HUB_VAR} ${HUB_ACME} ${HUB_ROOT} ${HUB_ROOT}/releases /etc/accordagents-hub`,
    `install -d -o root -g ${HUB_SERVICE_USER} -m 750 ${HUB_TLS}`,
    `install -d -o ${HUB_SERVICE_USER} -g ${HUB_SERVICE_USER} -m 700 ${HUB_DATA}`,
    // An earlier layout kept the certificate where the service could write.
    `rm -rf ${HUB_VAR}/tls`,
    `[ "$(node -v | sed -E 's/^v([0-9]+).*/\\1/')" -ge ${MIN_NODE_MAJOR} ] && sqlite3 -version >/dev/null && certbot --version >/dev/null`
  ].join("\n");
}

/** Puts a staged release in place and points `current` at it. */
export function hubActivateScript(staging: string, version: string): string {
  const release = `${HUB_ROOT}/releases/${releaseName(version)}`;
  return [
    "set -e",
    `rm -rf ${release}.new && cp -r ${staging} ${release}.new && chown -R root:root ${release}.new && chmod 755 ${release}.new && chmod 644 ${release}.new/*`,
    `rm -rf ${release} && mv ${release}.new ${release}`,
    `ln -sfn ${release} ${HUB_ROOT}/current.new && mv -T ${HUB_ROOT}/current.new ${HUB_ROOT}/current`,
    `rm -rf ${staging}`
  ].join("\n");
}

function hubCli(args: string): string {
  return `sudo -u ${HUB_SERVICE_USER} env NODE_OPTIONS=--max-old-space-size=${HUB_HEAP_MB} node ${HUB_ROOT}/current/accordagents-hub.cjs --user-data ${HUB_DATA} ${args}`;
}

/** The owner's identity arrives on stdin. The service is stopped meanwhile:
 *  one process at a time writes the hub's data. */
export function hubSetOwnerScript(): string {
  return [
    "set -e",
    // The hub is stopped from here until setup starts it again; if setup
    // never gets there (the app quit, the network went), the server starts
    // it by itself later.
    `systemd-run --quiet --collect --unit ${HUB_SERVICE_NAME}-restart-guard --on-active=${RESTART_GUARD_MIN}min /bin/systemctl start ${HUB_SERVICE_NAME} >/dev/null 2>&1 || true`,
    `systemctl stop ${HUB_SERVICE_NAME} 2>/dev/null || true`,
    `OWNER=$(${hubCli("--set-owner")})`,
    `printf '%s\n' "$OWNER"`,
    // Another computer's hub runs again at once while the User decides.
    `case "$OWNER" in *'"another-owner"'*) systemctl start ${HUB_SERVICE_NAME} 2>/dev/null || true ;; esac`
  ].join("\n");
}

/** Keeps the previous owner's data aside and starts with an empty hub. */
export function hubStartOverScript(stamp: string): string {
  return [
    "set -e",
    noLink(HUB_DATA),
    `systemctl stop ${HUB_SERVICE_NAME} 2>/dev/null || true`,
    `mv ${HUB_DATA} ${HUB_VAR}/data.replaced-${stamp.replace(/[^0-9]/g, "")}`,
    `install -d -o ${HUB_SERVICE_USER} -g ${HUB_SERVICE_USER} -m 700 ${HUB_DATA}`
  ].join("\n");
}

/** The chats arrive on stdin as a tar archive. */
export function hubImportChatsScript(): string {
  return [
    "set -e",
    noLink(HUB_IMPORT),
    `trap 'rm -rf ${HUB_IMPORT}' EXIT`,
    `systemctl stop ${HUB_SERVICE_NAME} 2>/dev/null || true`,
    `rm -rf ${HUB_IMPORT} && install -d -o ${HUB_SERVICE_USER} -g ${HUB_SERVICE_USER} -m 700 ${HUB_IMPORT}`,
    `sudo -u ${HUB_SERVICE_USER} tar -xzf - -C ${HUB_IMPORT}`,
    hubCli(`--import-chat-copy ${HUB_IMPORT}`)
  ].join("\n");
}

export function hubServiceUnit(): string {
  return [
    "[Unit]",
    "Description=AccordAgents hub",
    "After=network-online.target",
    "Wants=network-online.target",
    // Never given up on: a hub that keeps failing is retried, not left off.
    "StartLimitIntervalSec=0",
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
    `ReadWritePaths=${HUB_DATA}`,
    `Environment=NODE_OPTIONS=--max-old-space-size=${HUB_HEAP_MB}`,
    "Restart=always",
    // Retried sooner at first, then once a minute: a hub that keeps failing
    // does not use up the small server's CPU (and with it SSH).
    "RestartSec=2",
    "RestartSteps=6",
    "RestartMaxDelaySec=60",
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
 * certbot's timer before it ends). The hub serves the challenge on port 80
 * and re-reads the certificate when it changes; only the first one needs a
 * restart, to open port 443. Root keeps the files; the service reads them.
 */
export function hubCertificateScript(ip: string): string {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) throw new Error("Invalid server address.");
  const renewBeforeSeconds = CERT_RENEW_BEFORE_DAYS * 24 * 60 * 60;
  return [
    "set -e",
    `cat > ${DEPLOY_HOOK} <<'HOOK'`,
    "#!/bin/sh",
    "set -e",
    `install -o root -g ${HUB_SERVICE_USER} -m 640 "$RENEWED_LINEAGE/fullchain.pem" ${HUB_TLS}/fullchain.pem.new`,
    `install -o root -g ${HUB_SERVICE_USER} -m 640 "$RENEWED_LINEAGE/privkey.pem" ${HUB_TLS}/privkey.pem.new`,
    `mv ${HUB_TLS}/privkey.pem.new ${HUB_TLS}/privkey.pem && mv ${HUB_TLS}/fullchain.pem.new ${HUB_TLS}/fullchain.pem`,
    "HOOK",
    `chmod 755 ${DEPLOY_HOOK}`,
    // Kept while it is for this address and has more than the renewal margin left.
    `if [ -f ${HUB_TLS}/fullchain.pem ] && openssl x509 -in ${HUB_TLS}/fullchain.pem -noout -checkend ${renewBeforeSeconds} >/dev/null 2>&1 && openssl x509 -in ${HUB_TLS}/fullchain.pem -noout -ext subjectAltName 2>/dev/null | grep -q 'IP Address:${ip}$'; then echo kept; exit 0; fi`,
    // A certificate certbot already holds for this address is put in place
    // first, rather than asking Let's Encrypt for another (five a week).
    `if [ -f /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem ] && openssl x509 -in /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem -noout -checkend ${renewBeforeSeconds} >/dev/null 2>&1 && openssl x509 -in /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem -noout -ext subjectAltName 2>/dev/null | grep -q 'IP Address:${ip}$'; then`,
    `  RENEWED_LINEAGE=/etc/letsencrypt/live/${CERT_NAME} ${DEPLOY_HOOK}`,
    "else",
    `  certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --preferred-profile shortlived --webroot --webroot-path ${HUB_ACME} --ip-address ${ip} --cert-name ${CERT_NAME} --deploy-hook ${DEPLOY_HOOK} --force-renewal >/dev/null`,
    "fi",
    `sed -i '/^renew_before_expiry/d' /etc/letsencrypt/renewal/${CERT_NAME}.conf && sed -i '1i renew_before_expiry = ${CERT_RENEW_BEFORE_DAYS} days' /etc/letsencrypt/renewal/${CERT_NAME}.conf`,
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
function setupFailure(error: unknown): string {
  if (error instanceof CommandError) {
    const detail = (error.result.stderr || error.result.stdout).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 400);
    return detail || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One ssh option value as ssh reads it from `-o`: in double quotes, with a
 *  quote or backslash inside escaped, so a path with spaces stays one path. */
export function sshQuoted(value: string): string {
  return `"${value.replace(/["\\]/g, (character) => `\\${character}`)}"`;
}
