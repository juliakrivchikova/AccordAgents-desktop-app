/**
 * The one worker operation at a time rule.
 *
 * Setup, the doctor and the explicit mirror actions still reach a worker over
 * SSH, and two of them running at once on the same box corrupts what the other
 * is doing. This lease is what keeps them apart. It came out of the per-turn
 * transport that has been deleted; running a member's turn no longer touches a
 * worker at all, and this is all that was still needed from it.
 */
import { randomUUID } from "node:crypto";
import { buildCloudRunSshTarget, cloudRunSshOptionArgs } from "./cloudRunWorkers";
import { CommandError, runCommand } from "./command";
import type { RemoteRunWorkerTarget } from "./remoteWorkerTarget";

export interface RemoteWorkerOperationLease {
  leaseId: string;
  ownerId: string;
  kind: string;
  expiresAt: string;
}

export const REMOTE_OPERATION_LEASE_MS = 30_000;

const WORKER_ROOT_DEFAULT = "~/.accordagents/remote-runs";
const LEASE_SSH_TIMEOUT_MS = 30_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sshBaseArgs(worker: RemoteRunWorkerTarget): string[] {
  return [...cloudRunSshOptionArgs(worker), buildCloudRunSshTarget(worker)];
}

function workerRoot(worker: RemoteRunWorkerTarget): string {
  const root = worker.workerRoot?.trim() || WORKER_ROOT_DEFAULT;
  return root.replace(/\/+$/g, "") || WORKER_ROOT_DEFAULT;
}

/** `~` is the calling shell's, not this Mac's: resolved on the worker. */
async function resolveWorkerRoot(worker: RemoteRunWorkerTarget): Promise<string> {
  const root = workerRoot(worker);
  if (root.startsWith("/")) {
    return root;
  }
  const relative = root === "~" ? "" : root.startsWith("~/") ? root.slice(2) : root;
  const result = await runCommand(worker.sshPath?.trim() || "ssh", [
    ...sshBaseArgs(worker),
    relative ? `printf '%s' "$HOME"/${shellQuote(relative)}` : `printf '%s' "$HOME"`
  ], { timeoutMs: LEASE_SSH_TIMEOUT_MS });
  const resolved = result.stdout.trim();
  if (!resolved) {
    throw new Error("The worker did not resolve its own path.");
  }
  return resolved.replace(/\/+$/g, "") || "/";
}

function parseLease(result: Record<string, unknown>, ownerId: string, kind: string): RemoteWorkerOperationLease {
  const lease = result.lease && typeof result.lease === "object" ? result.lease as Record<string, unknown> : undefined;
  if (result.ok !== true || !lease || typeof lease.leaseId !== "string" || typeof lease.expiresAt !== "string") {
    throw new Error(`Worker operation lease failed (${String(result.status ?? "unknown")}).`);
  }
  return { leaseId: lease.leaseId, ownerId, kind, expiresAt: lease.expiresAt };
}

async function runLeaseShell(
  worker: RemoteRunWorkerTarget,
  action: "acquire" | "renew" | "release",
  leaseId: string,
  ownerId: string,
  kind: string
): Promise<Record<string, unknown>> {
  const sshPath = worker.sshPath?.trim() || "ssh";
  const root = await resolveWorkerRoot(worker);
  const command = [
    "sh -s --",
    shellQuote(root),
    shellQuote(action),
    shellQuote(leaseId),
    shellQuote(ownerId),
    shellQuote(kind),
    shellQuote(String(REMOTE_OPERATION_LEASE_MS))
  ].join(" ");
  try {
    const result = await runCommand(sshPath, [...sshBaseArgs(worker), command], {
      input: remoteWorkerOperationLeaseShellScript(),
      timeoutMs: LEASE_SSH_TIMEOUT_MS
    });
    return JSON.parse(result.stdout || "{}") as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CommandError) {
      try {
        return JSON.parse(error.result.stdout || "{}") as Record<string, unknown>;
      } catch {
        // Not the lease script's own answer: report the command failure.
      }
    }
    throw error;
  }
}

export async function acquireWorkerOperationLease(
  worker: RemoteRunWorkerTarget,
  ownerId: string,
  kind: string
): Promise<RemoteWorkerOperationLease> {
  return parseLease(await runLeaseShell(worker, "acquire", randomUUID(), ownerId, kind), ownerId, kind);
}

export async function renewWorkerOperationLease(
  worker: RemoteRunWorkerTarget,
  lease: RemoteWorkerOperationLease
): Promise<RemoteWorkerOperationLease> {
  return parseLease(await runLeaseShell(worker, "renew", lease.leaseId, lease.ownerId, lease.kind), lease.ownerId, lease.kind);
}

export async function releaseWorkerOperationLease(
  worker: RemoteRunWorkerTarget,
  lease: RemoteWorkerOperationLease
): Promise<void> {
  await runLeaseShell(worker, "release", lease.leaseId, lease.ownerId, lease.kind);
}

export function remoteWorkerOperationLeaseShellScript(): string {
  return String.raw`set -eu
root=$1
action=$2
lease_id=$3
owner_id=$4
kind=$5
ttl_ms=$6

root_parent=$(dirname "$root")
if [ "$(basename "$root_parent")" = devices ]; then
  root=$(dirname "$root_parent")
fi

case "$lease_id:$owner_id:$kind" in
  *[!A-Za-z0-9._:-]*) printf '%s' '{"ok":false,"status":"invalid-lease-identity"}'; exit 2 ;;
esac

operations_dir="$root/operations"
drain_path="$root/drain.json"
mkdir -p "$operations_dir"
boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)
boot_id=$(printf '%s' "$boot_id" | tr -cd 'A-Za-z0-9._:-')
[ -n "$boot_id" ] || boot_id=unknown

iso_epoch() {
  normalized=$(printf '%s' "$1" | sed 's/\.[0-9][0-9]*Z$/Z/')
  date -u -d "$normalized" +%s 2>/dev/null ||
    date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$normalized" +%s 2>/dev/null ||
    printf 0
}

epoch_iso() {
  date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null ||
    date -u -r "$1" '+%Y-%m-%dT%H:%M:%SZ'
}

drain_is_valid() {
  [ -f "$drain_path" ] || return 1
  drain_boot=$(sed -n 's/.*"bootId":"\([^"]*\)".*/\1/p' "$drain_path" | head -n 1)
  [ -n "$drain_boot" ] || return 0
  [ "$drain_boot" = "$boot_id" ] || return 1
  drain_expires=$(sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p' "$drain_path" | head -n 1)
  [ -n "$drain_expires" ] || return 0
  drain_epoch=$(iso_epoch "$drain_expires")
  [ "$drain_epoch" -gt "$(date +%s)" ]
}

lease_path="$operations_dir/$lease_id.json"
if [ "$action" = release ]; then
  if [ -f "$lease_path" ] && grep -Fq "\"leaseId\":\"$lease_id\"" "$lease_path" && grep -Fq "\"ownerId\":\"$owner_id\"" "$lease_path"; then
    rm -f "$lease_path"
  fi
  printf '%s' '{"ok":true,"status":"released"}'
  exit 0
fi

if drain_is_valid; then
  printf '%s' '{"ok":false,"status":"draining"}'
  exit 4
fi

if [ "$action" = renew ]; then
  if [ ! -f "$lease_path" ] || ! grep -Fq "\"leaseId\":\"$lease_id\"" "$lease_path" || ! grep -Fq "\"ownerId\":\"$owner_id\"" "$lease_path"; then
    printf '%s' '{"ok":false,"status":"lease-missing"}'
    exit 10
  fi
elif [ "$action" != acquire ]; then
  printf '%s' '{"ok":false,"status":"unknown-action"}'
  exit 2
fi

now_epoch=$(date +%s)
ttl_seconds=$(( (ttl_ms + 999) / 1000 ))
[ "$ttl_seconds" -ge 5 ] || ttl_seconds=5
issued_at=$(epoch_iso "$now_epoch")
expires_at=$(epoch_iso $((now_epoch + ttl_seconds)))
lease_json=$(printf '{"leaseId":"%s","ownerId":"%s","kind":"%s","bootId":"%s","issuedAt":"%s","expiresAt":"%s"}' "$lease_id" "$owner_id" "$kind" "$boot_id" "$issued_at" "$expires_at")
tmp_path="$lease_path.$$.tmp"
umask 077
printf '%s' "$lease_json" > "$tmp_path"
mv -f "$tmp_path" "$lease_path"

if drain_is_valid; then
  rm -f "$lease_path"
  printf '%s' '{"ok":false,"status":"draining"}'
  exit 4
fi

status=acquired
[ "$action" = renew ] && status=renewed
printf '{"ok":true,"status":"%s","lease":%s}' "$status" "$lease_json"
`;
}
