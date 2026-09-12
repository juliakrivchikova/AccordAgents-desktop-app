/**
 * What a worker is, and what of this desktop's environment may travel to one.
 *
 * Provisioning, the doctor and the manual mirror still reach a worker over
 * SSH; running a member's turn there does not, and the transport that used to
 * is gone. These are the pieces those surfaces share, kept apart from any
 * notion of a run.
 */
import { commandEnvironment } from "./command";
import { machineProfileVariables } from "../../shared/machineInstall";

export interface RemoteRunWorkerTarget {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  hostKeyAlias?: string;
  sshPath?: string;
  codexPath?: string;
  claudePath?: string;
  remoteCwd?: string;
  workerRoot?: string;
  /** Native CLI configuration belongs to this deployment, not the SSH user. */
  profileHome?: string;
}

export interface RemoteWorkerStopLease {
  leaseId: string;
  expiresAt: string;
}

export interface RemoteWorkerStopAuthorization {
  allowed: boolean;
  reason?: string;
  lease?: RemoteWorkerStopLease;
}

/** Local shell furniture stays local: a worker gets the User's own variables,
 *  not this Mac's paths, sockets, terminal or package-manager state. */
const REMOTE_ENV_DENYLIST_EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "SHLVL", "PWD", "OLDPWD",
  "TMPDIR", "TMP", "TEMP", "TERM", "TERMINFO", "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "DISPLAY", "WINDOWID",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY",
  "GPG_AGENT_INFO", "LANG", "LANGUAGE", "EDITOR", "VISUAL", "PAGER",
  "COMMAND_MODE", "SECURITYSESSIONID", "MANPATH", "INFOPATH", "CDPATH",
  "TMUX", "TMUX_PANE", "JAVA_HOME", "ANDROID_HOME", "SDKROOT",
  "DEVELOPER_DIR", "VIRTUAL_ENV", "GOPATH", "GOROOT", "CARGO_HOME",
  "RUSTUP_HOME", "ORIGINAL_XDG_CURRENT_DESKTOP", "CODEX_HOME", "CLAUDE_CONFIG_DIR"
]);
const REMOTE_ENV_DENYLIST_PREFIXES = [
  "LC_", "DYLD_", "XPC_", "__", "Apple_", "ELECTRON_", "CHROME_", "NODE_",
  "npm_", "NVM_", "HOMEBREW_", "ITERM_", "VSCODE_", "XDG_", "CONDA_",
  "ACCORD_AGENTS_"
];

export function forwardedDesktopEnvironment(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = base ?? commandEnvironment();
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (REMOTE_ENV_DENYLIST_EXACT.has(key)) {
      continue;
    }
    if (REMOTE_ENV_DENYLIST_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/** The SSH login is only transport. Do not source its shell profile or carry
 * its credentials/configuration into another desktop's provider setup. */
export function remoteProfileCommand(profileHome: string | undefined, command: string): string {
  if (!profileHome) return command;
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const variables = machineProfileVariables(profileHome);
  return `umask 077; mkdir -p ${quote(profileHome)} && env -i PATH="$PATH" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash `
    + Object.entries(variables).map(([key, value]) => `${key}=${quote(value)}`).join(" ")
    + ` /bin/bash --noprofile --norc -c ${quote(command)}`;
}
