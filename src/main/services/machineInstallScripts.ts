/**
 * The shell the desktop runs on a machine during install, upgrade and mirror
 * bootstrap, and the parsers for what it prints back.
 *
 * Everything here is pure: a script in, a string out; a string in, a report
 * out. That is deliberate — the interesting failures of an installer are in
 * what the remote shell does, and this is the part that can be tested without
 * a Linux box.
 *
 * Two rules hold for every script below:
 *   - No secret ever enters a command line. The enrollment package carries the
 *     relay key and is written from stdin (`writeFileFromStdinScript`), never
 *     interpolated, never echoed, never logged.
 *   - Nothing here touches the machine's user data, its enrollment, or a
 *     participant-created worktree. An upgrade replaces code and nothing else.
 */

import { shellQuotePosix } from "./cloudRunWorkers";
import type {
  MachineDrainReport,
  MachineMirrorInspection,
  MachineRuntimeProbe,
  MachineServiceScope
} from "../../shared/machineInstall";

export const DEFAULT_MACHINE_INSTALL_DIRNAME = "accordagents-machine";
export const DEFAULT_MACHINE_USER_DATA_SUFFIX = ".accordagents/machine";
export const DEFAULT_MACHINE_SERVICE_NAME = "accordagents-machine";

export interface MachineInstallLayout {
  installRoot: string;
  releasesDir: string;
  currentLink: string;
  enrollmentPath: string;
  statePath: string;
  userDataDir: string;
  serviceName: string;
  serviceScope: MachineServiceScope;
}

export function machineInstallLayout(options: {
  installRoot: string;
  userDataDir: string;
  serviceName: string;
  serviceScope: MachineServiceScope;
}): MachineInstallLayout {
  const installRoot = options.installRoot.replace(/\/+$/, "");
  return {
    installRoot,
    releasesDir: `${installRoot}/releases`,
    currentLink: `${installRoot}/current`,
    enrollmentPath: `${installRoot}/enrollment.json`,
    statePath: `${installRoot}/install-state.json`,
    userDataDir: options.userDataDir.replace(/\/+$/, ""),
    serviceName: options.serviceName,
    serviceScope: options.serviceScope
  };
}

/** `systemctl` needs a session bus for `--user` over SSH, and a system unit
 *  started as this user needs an explicit HOME. Both are set once here. */
const PREAMBLE = [
  "set -eu",
  ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"',
  "export XDG_RUNTIME_DIR"
].join("\n");

/** Lists processes matching an extended regex, excluding this shell and its
 *  parent: the pattern is part of our own command line, so an unfiltered
 *  `pgrep -f` would report the drain script as the runtime it is draining. */
const PROCESS_HELPERS = [
  // A guarded drain is itself below a maintenance controller and guardian.
  // Exclude its actual ancestors, never a name-based class of other runtimes.
  "SELF_ANCESTORS=' '",
  "ancestor=$$",
  "while [ \"$ancestor\" -gt 1 ] 2>/dev/null; do",
  "  SELF_ANCESTORS=\"$SELF_ANCESTORS$ancestor \"",
  "  ancestor=$(awk '/^PPid:/ {print $2}' \"/proc/$ancestor/status\" 2>/dev/null) || break",
  "done",
  "own_pids() {",
  "  pgrep -f \"$1\" 2>/dev/null | while read -r p; do",
  "    case \"$SELF_ANCESTORS\" in *\" $p \"*) continue ;; esac",
  "    printf '%s\\n' \"$p\"",
  "  done",
  "}",
  // The redirect is silenced BEFORE the input redirect: a process that exited
  // between pgrep and this read would otherwise print to the real stderr.
  "cmdline_of() { tr '\\0' ' ' 2>/dev/null < \"/proc/$1/cmdline\" || true; }",
  "environ_has() { tr '\\0' '\\n' 2>/dev/null < \"/proc/$1/environ\" | grep -qxF \"$2\"; }"
].join("\n");

/** Fills RUNTIME/SUPERVISOR/PROVIDER with the pids this installation owns.
 *
 *  Ownership is decided by the install root in the process command line (the
 *  runtime and its native supervisor both live under it) and by the machine's
 *  user-data directory in the environment (the provider CLIs inherit it from
 *  the unit). A runtime someone started by hand without that variable is not
 *  matched, which is why the drain also refuses on a still-active unit. */
function scanProcessesFunction(rootExpression: string, userDataMatchExpression: string): string {
  return [
    "scan_processes() {",
    "  RUNTIME=''; SUPERVISOR=''; PROVIDER=''",
    `  ROOT_MATCH=${rootExpression}`,
    `  ENV_MATCH=${userDataMatchExpression}`,
    "  for p in $(own_pids 'accordagents-machine\\.cjs|nativeProcessSupervisor\\.cjs'); do",
    "    line=$(cmdline_of \"$p\")",
    "    case \"$line\" in",
    "      *\"$ROOT_MATCH/\"*accordagents-machine.cjs*) RUNTIME=\"$RUNTIME $p\" ;;",
    "      *\"$ROOT_MATCH/\"*nativeProcessSupervisor.cjs*) SUPERVISOR=\"$SUPERVISOR $p\" ;;",
    "    esac",
    "  done",
    "  for p in $(own_pids 'codex|claude'); do",
    "    case \" $RUNTIME $SUPERVISOR \" in *\" $p \"*) continue ;; esac",
    "    if environ_has \"$p\" \"$ENV_MATCH\"; then PROVIDER=\"$PROVIDER $p\"; fi",
    "  done",
    "}"
  ].join("\n");
}

function systemctl(scope: MachineServiceScope): string {
  return scope === "user" ? "systemctl --user" : "systemctl";
}

/**
 * Reads the machine before anything is changed: tool versions, what is
 * already installed, which unit runs it, and which processes belong to it.
 * `installRoot` is optional so the very first probe can discover `$HOME`.
 */
/** Rejects an install root that could not be a safe shell path or a systemd
 *  unit name. A `~/` prefix is expanded by the script, not by us. */
export function machineInstallRootExpression(installRoot?: string): string {
  const raw = installRoot?.trim();
  if (!raw) {
    return `ROOT="$HOME/${DEFAULT_MACHINE_INSTALL_DIRNAME}"`;
  }
  if (!/^[~/]?[A-Za-z0-9._/-]*$/.test(raw)) {
    throw new Error("The install directory may only contain letters, digits, dot, dash, underscore and slash.");
  }
  if (raw.startsWith("~/")) {
    return `ROOT="$HOME/${raw.slice(2).replace(/\/+$/, "")}"`;
  }
  if (!raw.startsWith("/")) {
    return `ROOT="$HOME/${raw.replace(/\/+$/, "")}"`;
  }
  return `ROOT=${shellQuotePosix(raw.replace(/\/+$/, ""))}`;
}

/**
 * Reads the machine before anything is changed: tool versions, what is
 * already installed, which unit runs it, and which processes belong to it.
 *
 * The machine also decides the data directory and unit name, so there is one
 * source of truth for them. A deployment in a directory other than the default
 * gets its OWN data directory and unit: two deployments sharing one user-data
 * directory would be two executors for the same participant session, which is
 * exactly what the transport forbids.
 */
export function machineProbeScript(options: {
  installRoot?: string;
  userDataDir?: string;
  serviceName?: string;
}): string {
  const scan = scanProcessesFunction('"$ROOT"', '"ACCORDAGENTS_USER_DATA_DIR=$UD"');
  return [
    PREAMBLE,
    machineInstallRootExpression(options.installRoot),
    `NAME="$(basename "$ROOT")"`,
    `case "$NAME" in`,
    `  ${DEFAULT_MACHINE_INSTALL_DIRNAME}) UD_DEFAULT="$HOME/${DEFAULT_MACHINE_USER_DATA_SUFFIX}"; SVC_DEFAULT=${shellQuotePosix(DEFAULT_MACHINE_SERVICE_NAME)} ;;`,
    `  *) UD_DEFAULT="$HOME/.accordagents/$NAME"; SVC_DEFAULT="$NAME" ;;`,
    `esac`,
    options.userDataDir ? `UD=${shellQuotePosix(options.userDataDir.replace(/\/+$/, ""))}` : `UD="$UD_DEFAULT"`,
    options.serviceName ? `SVC=${shellQuotePosix(options.serviceName)}` : `SVC="$SVC_DEFAULT"`,
    PROCESS_HELPERS,
    scan,
    `printf 'home=%s\\n' "$HOME"`,
    `printf 'install-root=%s\\n' "$ROOT"`,
    `printf 'user-data=%s\\n' "$UD"`,
    `printf 'service-name=%s\\n' "$SVC"`,
    `if command -v node >/dev/null 2>&1; then printf 'node=%s\\n' "$(node --version 2>/dev/null)"; else printf 'node=missing\\n'; fi`,
    `for t in sqlite3 git rsync npm python3; do`,
    `  if command -v "$t" >/dev/null 2>&1; then printf '%s=ok\\n' "$t"; else printf '%s=missing\\n' "$t"; fi`,
    `done`,
    `if command -v systemctl >/dev/null 2>&1; then printf 'systemd=ok\\n'; else printf 'systemd=missing\\n'; fi`,
    `if sudo -n true >/dev/null 2>&1; then printf 'sudo=ok\\n'; else printf 'sudo=missing\\n'; fi`,
    // The unit runs outside a login shell; without the login PATH it cannot
    // find a provider CLI installed under the user's home (nvm, npm prefix).
    `printf 'login-path=%s\\n' "$(bash -lc 'printf %s "$PATH"' 2>/dev/null | tr -d '\\r\\n')"`,
    `printf 'node-path=%s\\n' "$(command -v node 2>/dev/null | tr -d '\\r\\n')"`,
    `if [ -f "$ROOT/install-state.json" ]; then printf 'state=%s\\n' "$(tr -d '\\r\\n' < "$ROOT/install-state.json")"; fi`,
    `if [ -L "$ROOT/current" ]; then printf 'active-release=%s\\n' "$(basename "$(readlink "$ROOT/current")")"; fi`,
    `if [ -d "$ROOT/releases" ]; then for d in "$ROOT/releases"/*; do [ -d "$d" ] && printf 'release=%s\\n' "$(basename "$d")"; done; fi`,
    `if [ -f "$ROOT/enrollment.json" ]; then printf 'enrollment=present\\n'; else printf 'enrollment=absent\\n'; fi`,
    // A release that ships this file understands `--maintenance`; one that
    // does not must never be exec'd with it, because its argument parser would
    // ignore the flag and start a second runtime on this user data.
    `if [ -f "$ROOT/current/maintenance-v1" ]; then printf 'maintenance=v1\\n'; fi`,
    `if command -v systemctl >/dev/null 2>&1; then`,
    `  if systemctl cat "$SVC.service" >/dev/null 2>&1; then`,
    `    printf 'service-scope=system\\n'; printf 'service-state=%s\\n' "$(systemctl is-active "$SVC.service" 2>/dev/null || true)"`,
    `  elif systemctl --user cat "$SVC.service" >/dev/null 2>&1; then`,
    `    printf 'service-scope=user\\n'; printf 'service-state=%s\\n' "$(systemctl --user is-active "$SVC.service" 2>/dev/null || true)"`,
    `  else printf 'service-state=absent\\n'; fi`,
    `fi`,
    `scan_processes`,
    `printf 'runtime-pids=%s\\n' "$RUNTIME"`,
    `printf 'supervisor-pids=%s\\n' "$SUPERVISOR"`,
    `printf 'provider-pids=%s\\n' "$PROVIDER"`
  ].join("\n");
}

export interface ParsedMachineProbe extends MachineRuntimeProbe {
  /** The installed release understands `--maintenance`. */
  maintenanceCapable: boolean;
  home: string;
  installRoot: string;
  userDataDir: string;
  serviceName: string;
  loginPath?: string;
  nodePath?: string;
  hasNpm: boolean;
  hasPython3: boolean;
}

export function parseMachineProbe(stdout: string): ParsedMachineProbe {
  const values = new Map<string, string>();
  const releases: string[] = [];
  for (const line of stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === "release") releases.push(value);
    else values.set(key, value);
  }
  const node = values.get("node");
  let installedVersion: string | undefined;
  let installedDigest: string | undefined;
  const rawState = values.get("state");
  if (rawState) {
    try {
      const parsed = JSON.parse(rawState) as { version?: unknown; digest?: unknown };
      if (typeof parsed.version === "string") installedVersion = parsed.version;
      if (typeof parsed.digest === "string") installedDigest = parsed.digest;
    } catch {
      // A damaged state file is treated as "unknown version", never as "none":
      // the version fence then asks for an explicit decision instead of
      // silently installing over whatever is there.
      installedVersion = undefined;
    }
  }
  const scope = values.get("service-scope");
  return {
    home: values.get("home") ?? "",
    installRoot: values.get("install-root") ?? "",
    userDataDir: values.get("user-data") ?? "",
    serviceName: values.get("service-name") ?? DEFAULT_MACHINE_SERVICE_NAME,
    nodeVersion: node && node !== "missing" ? node : undefined,
    hasSqlite3: values.get("sqlite3") === "ok",
    hasGit: values.get("git") === "ok",
    hasRsync: values.get("rsync") === "ok",
    hasNpm: values.get("npm") === "ok",
    hasPython3: values.get("python3") === "ok",
    hasSystemd: values.get("systemd") === "ok",
    hasPasswordlessSudo: values.get("sudo") === "ok",
    loginPath: values.get("login-path") || undefined,
    nodePath: values.get("node-path") || undefined,
    installedVersion,
    installedDigest,
    activeRelease: values.get("active-release") || undefined,
    releases,
    enrollmentPresent: values.get("enrollment") === "present",
    maintenanceCapable: values.get("maintenance") === "v1",
    serviceScope: scope === "system" || scope === "user" ? scope : undefined,
    serviceState: values.get("service-state") || undefined,
    runtimePids: parsePids(values.get("runtime-pids")),
    supervisorPids: parsePids(values.get("supervisor-pids")),
    providerPids: parsePids(values.get("provider-pids"))
  };
}

function parsePids(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Creates the directory tree an install writes into. Never removes anything. */
export function machinePrepareDirectoriesScript(layout: MachineInstallLayout): string {
  return [
    PREAMBLE,
    "umask 077",
    `mkdir -p ${shellQuotePosix(layout.releasesDir)} ${shellQuotePosix(layout.userDataDir)}`
  ].join("\n");
}

/** Writes a file from stdin, atomically, without it ever reaching a command
 *  line, a log, or a shell history. Used for the enrollment package. */
export function writeFileFromStdinScript(targetPath: string, mode: string): string {
  const quoted = shellQuotePosix(targetPath);
  const tmp = shellQuotePosix(`${targetPath}.new`);
  return [
    PREAMBLE,
    "umask 077",
    `mkdir -p "$(dirname ${quoted})"`,
    `cat > ${tmp}`,
    `chmod ${mode} ${tmp}`,
    `mv -f ${tmp} ${quoted}`
  ].join("\n");
}

export function machineInstallDependenciesScript(layout: MachineInstallLayout, release: string): string {
  const dir = shellQuotePosix(`${layout.releasesDir}/${release}`);
  return [
    PREAMBLE,
    `cd ${dir}`,
    "npm install --omit=dev --no-audit --no-fund"
  ].join("\n");
}

/**
 * Points `current` at a release and records what is now installed.
 *
 * The symlink is replaced, not edited: a running runtime keeps the inode it
 * started from, so this never rewrites a file underneath a live process. It is
 * still only ever called after a verified drain.
 */
export function machineActivateReleaseScript(
  layout: MachineInstallLayout,
  release: string,
  state: { version: string; digest: string; installedAt: string }
): string {
  const releaseDir = shellQuotePosix(`${layout.releasesDir}/${release}`);
  const link = shellQuotePosix(layout.currentLink);
  const pending = shellQuotePosix(`${layout.currentLink}.pending`);
  return [
    PREAMBLE,
    `test -f ${releaseDir}/accordagents-machine.cjs || { echo "release ${release} is incomplete" >&2; exit 1; }`,
    `ln -sfn ${releaseDir} ${pending}`,
    `mv -Tf ${pending} ${link}`,
    `printf '%s' ${shellQuotePosix(JSON.stringify({ version: state.version, digest: state.digest, installedAt: state.installedAt, release }))} > ${shellQuotePosix(layout.statePath)}`,
    `sync ${shellQuotePosix(layout.installRoot)} 2>/dev/null || sync || true`,
    `printf 'active-release=%s\\n' "$(basename "$(readlink ${link})")"`
  ].join("\n");
}

export interface MachineServiceUnitOptions {
  layout: MachineInstallLayout;
  machineName: string;
  home: string;
  user: string;
  nodePath: string;
  path?: string;
}

/** The systemd unit. `KillSignal=SIGTERM` with a long stop timeout is not
 *  cosmetic: the runtime drains its outbox and its supervisor verifies that
 *  provider trees are gone on SIGTERM. A hard kill would leave a provider
 *  process alive, which is exactly the duplicate executor the accord forbids. */
export function machineServiceUnit(options: MachineServiceUnitOptions): string {
  const { layout } = options;
  const lines = [
    "[Unit]",
    `Description=AccordAgents machine (${options.machineName})`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${layout.installRoot}`,
    `Environment=HOME=${options.home}`,
    `Environment=ACCORDAGENTS_MACHINE_ENROLLMENT=${layout.enrollmentPath}`,
    `Environment=ACCORDAGENTS_USER_DATA_DIR=${layout.userDataDir}`,
    `Environment=ACCORDAGENTS_MACHINE_NAME=${options.machineName}`
  ];
  if (options.path) {
    lines.push(`Environment=PATH=${options.path}`);
  }
  if (layout.serviceScope === "system") {
    lines.push(`User=${options.user}`);
  }
  lines.push(
    `ExecStart=${options.nodePath} ${layout.currentLink}/accordagents-machine.cjs`,
    "Restart=always",
    "RestartSec=3",
    "KillSignal=SIGTERM",
    "KillMode=mixed",
    "TimeoutStopSec=120",
    "",
    "[Install]",
    layout.serviceScope === "user" ? "WantedBy=default.target" : "WantedBy=multi-user.target",
    ""
  );
  return lines.join("\n");
}

/** Installs the unit from stdin and enables it. Nothing is started here. */
export function machineInstallServiceScript(layout: MachineInstallLayout, user: string): string {
  const unit = `${layout.serviceName}.service`;
  // The guardian forwards stdin as a socket. `install /dev/stdin` cannot open
  // that on Linux (ENXIO); read the stream before invoking install instead.
  const input = [PREAMBLE, "UNIT_INPUT=$(mktemp)", 'trap \'rm -f "$UNIT_INPUT"\' EXIT', 'cat > "$UNIT_INPUT"'];
  if (layout.serviceScope === "user") {
    return [
      ...input,
      `mkdir -p "$HOME/.config/systemd/user"`,
      `install -m 0644 "$UNIT_INPUT" "$HOME/.config/systemd/user/${unit}"`,
      "systemctl --user daemon-reload",
      `systemctl --user enable ${shellQuotePosix(unit)}`,
      // Without lingering the runtime stops when the last session closes. It is
      // reported as a warning rather than failing the install.
      `loginctl enable-linger ${shellQuotePosix(user)} >/dev/null 2>&1 || sudo -n loginctl enable-linger ${shellQuotePosix(user)} >/dev/null 2>&1 || printf 'linger=missing\\n'`
    ].join("\n");
  }
  return [
    ...input,
    `sudo -n install -m 0644 "$UNIT_INPUT" /etc/systemd/system/${unit}`,
    "sudo -n systemctl daemon-reload",
    `sudo -n systemctl enable ${shellQuotePosix(unit)}`
  ].join("\n");
}

export function machineStartServiceScript(layout: MachineInstallLayout): string {
  const unit = shellQuotePosix(`${layout.serviceName}.service`);
  const sudo = layout.serviceScope === "system" ? "sudo -n " : "";
  return [
    PREAMBLE,
    `${sudo}${systemctl(layout.serviceScope)} start ${unit}`,
    `${systemctl(layout.serviceScope)} is-active ${unit} || true`
  ].join("\n");
}

export function machineServiceLogScript(layout: MachineInstallLayout, lines = 60): string {
  const unit = shellQuotePosix(`${layout.serviceName}.service`);
  const scopeFlag = layout.serviceScope === "user" ? "--user " : "";
  return [
    PREAMBLE,
    `journalctl ${scopeFlag}-u ${unit} -n ${lines} --no-pager 2>/dev/null ` +
      `|| sudo -n journalctl -u ${unit} -n ${lines} --no-pager 2>/dev/null || true`
  ].join("\n");
}

/**
 * Stops the runtime and proves that nothing it owned is still executing.
 *
 * Escalation stops at SIGTERM on purpose. The native supervisor's contract is
 * that it outlives a crashed runtime specifically to close and verify its
 * provider trees; killing it destroys that proof and can leave a provider
 * process alive, so a drain that does not complete is reported as a refusal to
 * upgrade rather than forced through.
 */
export function machineDrainScript(layout: MachineInstallLayout, options: {
  stopWaitSeconds?: number;
  termWaitSeconds?: number;
} = {}): string {
  const stopWait = options.stopWaitSeconds ?? 150;
  const termWait = options.termWaitSeconds ?? 45;
  const unit = shellQuotePosix(`${layout.serviceName}.service`);
  const sudo = layout.serviceScope === "system" ? "sudo -n " : "";
  const ctl = systemctl(layout.serviceScope);
  return [
    PREAMBLE,
    PROCESS_HELPERS,
    scanProcessesFunction(shellQuotePosix(layout.installRoot), shellQuotePosix(`ACCORDAGENTS_USER_DATA_DIR=${layout.userDataDir}`)),
    `if ${ctl} cat ${unit} >/dev/null 2>&1; then`,
    `  ${sudo}${ctl} stop ${unit} >/dev/null 2>&1 || printf 'stop-error=1\\n'`,
    `fi`,
    "i=0",
    `while [ "$i" -lt ${stopWait} ]; do`,
    "  scan_processes",
    `  active=$(${ctl} is-active ${unit} 2>/dev/null || true)`,
    `  if [ -z "$(printf '%s' "$RUNTIME$SUPERVISOR$PROVIDER" | tr -d ' ')" ] && [ "$active" != "active" ] && [ "$active" != "activating" ] && [ "$active" != "deactivating" ]; then break; fi`,
    "  i=$((i+1)); sleep 1",
    "done",
    "scan_processes",
    `if [ -n "$(printf '%s' "$RUNTIME$SUPERVISOR" | tr -d ' ')" ]; then`,
    `  for p in $RUNTIME $SUPERVISOR; do kill -TERM "$p" 2>/dev/null || true; done`,
    "  i=0",
    `  while [ "$i" -lt ${termWait} ]; do`,
    "    scan_processes",
    `    [ -z "$(printf '%s' "$RUNTIME$SUPERVISOR$PROVIDER" | tr -d ' ')" ] && break`,
    "    i=$((i+1)); sleep 1",
    "  done",
    "fi",
    "scan_processes",
    `active=$(${ctl} is-active ${unit} 2>/dev/null || true)`,
    `printf 'service-state=%s\\n' "$active"`,
    `printf 'runtime-pids=%s\\n' "$RUNTIME"`,
    `printf 'supervisor-pids=%s\\n' "$SUPERVISOR"`,
    `printf 'provider-pids=%s\\n' "$PROVIDER"`,
    `if [ -z "$(printf '%s' "$RUNTIME$SUPERVISOR$PROVIDER" | tr -d ' ')" ] && [ "$active" != "active" ] && [ "$active" != "activating" ]; then printf 'drained=yes\\n'; else printf 'drained=no\\n'; fi`
  ].join("\n");
}

export function parseMachineDrainReport(stdout: string): MachineDrainReport {
  const probe = parseMachineProbe(stdout);
  const drained = /(^|\n)drained=yes\s*($|\n)/.test(stdout);
  const stopError = /(^|\n)stop-error=1\s*($|\n)/.test(stdout);
  const detail = drained
    ? undefined
    : stopError
      ? `The service manager could not stop ${probe.serviceState ?? "the unit"}.`
      : undefined;
  return {
    drained,
    serviceState: probe.serviceState,
    runtimePids: probe.runtimePids,
    supervisorPids: probe.supervisorPids,
    providerPids: probe.providerPids,
    detail
  };
}

/** Reads a project mirror without changing it: whether it exists, whether it
 *  has uncommitted work, and which worktrees a participant created beside it. */
export function machineMirrorProbeScript(mirrorRepoPath: string): string {
  const repo = shellQuotePosix(mirrorRepoPath);
  const container = shellQuotePosix(mirrorRepoPath.replace(/\/repo$/, ""));
  return [
    PREAMBLE,
    `printf 'path=%s\\n' ${repo}`,
    `if [ ! -e ${repo} ] && [ ! -L ${repo} ]; then printf 'state=absent\\n'; exit 0; fi`,
    `if [ ! -d ${repo} ] || [ -L ${repo} ]; then printf 'state=unknown\\n'; exit 0; fi`,
    `if [ ! -e ${repo}/.git ]; then printf 'state=directory\\n'; exit 0; fi`,
    `if ! git -C ${repo} rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf 'state=unknown\\n'; exit 0; fi`,
    `printf 'branch=%s\\n' "$(git -C ${repo} rev-parse --abbrev-ref HEAD 2>/dev/null || true)"`,
    `printf 'head=%s\\n' "$(git -C ${repo} rev-parse HEAD 2>/dev/null || true)"`,
    `git -C ${repo} status --porcelain 2>/dev/null | head -n 200 | sed 's/^/dirty=/' || true`,
    `git -C ${repo} worktree list --porcelain 2>/dev/null | sed -n 's/^worktree /worktree=/p' || true`,
    `if [ -d ${container} ]; then for d in ${container}/*; do`,
    `  [ -d "$d" ] || continue`,
    `  case "$d" in *"/repo") continue ;; esac`,
    `  printf 'sibling=%s\\n' "$d"`,
    `done; fi`,
    `printf 'state=present\\n'`
  ].join("\n");
}

export function parseMachineMirrorProbe(stdout: string): MachineMirrorInspection {
  const dirtyPaths: string[] = [];
  const worktrees: string[] = [];
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === "dirty") {
      if (value) dirtyPaths.push(value);
    } else if (key === "worktree" || key === "sibling") {
      if (value && !worktrees.includes(value)) worktrees.push(value);
    } else {
      values.set(key, value);
    }
  }
  const present = values.get("state") === "present";
  const path = values.get("path") ?? "";
  if (!present) {
    const state = values.get("state");
    return { path, state: state === "absent" || state === "directory" ? state : "unknown", worktrees: [], dirtyPaths: [] };
  }
  // The mirror's own checkout is listed by `git worktree list` as well; the
  // interesting ones are the participant-created siblings.
  const siblings = worktrees.filter((entry) => entry.replace(/\/+$/, "") !== path.replace(/\/+$/, ""));
  return {
    path,
    state: dirtyPaths.length > 0 ? "dirty" : "clean",
    worktrees: siblings,
    dirtyPaths,
    branch: values.get("branch") || undefined,
    head: values.get("head") || undefined
  };
}

/** Linux rename publishes a complete first copy, never over a machine's work. */
export function machinePublishMirrorScript(stagedPath: string, repoPath: string): string {
  const staged = shellQuotePosix(stagedPath);
  const repo = shellQuotePosix(repoPath);
  return [PREAMBLE,
    `if [ -e ${repo} ] || [ -L ${repo} ]; then echo 'The machine already has this project; nothing was replaced.' >&2; exit 1; fi`,
    `mv -Tn -- ${staged} ${repo}`,
    `if [ -e ${staged} ]; then echo 'The project appeared during setup; nothing was replaced.' >&2; exit 1; fi`
  ].join("\n");
}
