# Machines transport — installing and upgrading a machine

A machine is a computer that runs the app without a window. Getting the runtime
onto it, and replacing it later, is the only thing in the machines transport
that uses SSH. Rule 1 of the signed cutover accord (artifact
`a6f1e5ad-097e-442f-9396-f7566984a01f` v4, §1.6) allows SSH for exactly three
things — installing and upgrading the app on a machine, bootstrapping a project
mirror, and an emergency process stop — and for nothing else. No message, turn,
progress frame, approval, or Stop ever travels over SSH.

`MachineInstallerService` (`src/main/services/machineInstaller.ts`) is that
setup path. `scripts/machine-install-transport-guard.test.mjs` fails the build
if `chat.ts`, `machineLink.ts`, `machineHost.ts`, `machineApprovalExecutor.ts`
or the machine runtime entrypoint ever imports it.

## What the User sees

One phase at a time, in this order, each with a message the Machines settings
section can show verbatim:

| Phase | What happens |
|---|---|
| `preflight` | `CloudRunDoctorService` checks and, if needed, repairs the machine: Node, git, `sqlite3`, the Codex sandbox kernel setting, and **the provider sign-in, performed on the machine**. `authUrl`/`authCode` on the snapshot are the device-auth handoff. |
| `bundle` | The local `dist/machine` bundle is read and fingerprinted. |
| `transfer` | The bundle is copied into `releases/<version>-<digest>` beside whatever is already there. |
| `dependencies` | `npm install --omit=dev` inside that release. |
| `enroll` | The enrollment package is written to `enrollment.json` (mode 600). |
| `drain` | The running runtime, its native supervisor and any provider process it owns are stopped, and their absence is **proven**. This step always runs, including on a first install. |
| `activate` | `current` is repointed at the new release and `install-state.json` records it. |
| `service` | The systemd unit is written and enabled. |
| `starting` | The unit is started. |
| `verify` | The desktop waits for the machine to connect **over the relay**, then reads back which release it is actually running. Not "systemd says it started", and not "something answered". |
| `ready` | Done. |

Terminal failures are `error` (nothing was attempted or nothing changed) and
`needs-attention` (something on the machine needs the User). Every failure
carries a `recovery` block naming what is true on the machine right now:
`nothing-changed`, `old-runtime-still-installed`, `rolled-back`,
`new-runtime-installed-not-started`, or `manual-drain-required`.

## Layout on the machine

```
~/accordagents-machine/
  enrollment.json          0600, the relay key; never replaced by an upgrade
  install-state.json       {version, digest, installedAt, release}
  releases/<version>-<digest>/    one directory per installed version
  current -> releases/<...>       what the unit runs
  workspace/mirrors/<slug>/repo   project mirror, and participant worktrees beside it
~/.accordagents/machine/   the machine's own data — never touched by an upgrade
```

Releases are kept, not replaced in place. A running Node process is never asked
to read a file that is being rewritten underneath it, and a rollback is a
symlink flip rather than a re-download.

## Why the upgrade is ordered the way it is

**Stage first, drain second — but always drain.** Copying and `npm install`
happen while the old runtime is still serving members, so the machine is down
for seconds instead of minutes, and a failure during transfer changes nothing
that runs. By the time the switch happens the probe is minutes old, so its
"nothing is running" reading is not trusted: the drain runs unconditionally.
Skipping it on a stale reading would flip the symlink under a live runtime, and
the connect check would then see the *old* process answer and call the upgrade
done.

**A drain that cannot be proven refuses the upgrade.** After `systemctl stop`
the drain waits for the unit to leave the active states and then looks for
three things: the runtime process, its `nativeProcessSupervisor` process, and
any provider process carrying this machine's `ACCORDAGENTS_USER_DATA_DIR`. If
any of them is still there after SIGTERM, the upgrade stops with
`manual-drain-required`, the staged release unused and the old version still
running. It does not escalate to SIGKILL. The supervisor's whole purpose is to
outlive a crashed runtime so it can close and verify provider trees; killing it
destroys that proof and can leave a provider process alive — which is precisely
the duplicate executor §2.4 of the accord forbids. A machine that keeps working
on the old version is a better outcome than a machine running one member twice.

**"Installed" means connected, running the new release.** After the machine
says hello, the desktop re-reads `install-state.json` and the unit state: a
connection alone can come from an older process that never restarted. If the
machine does not connect within three minutes, or connects on the old release,
an upgrade flips `current` back to the previous release, restarts it, and
reports `rolled-back` with the tail of the service log. A first install has nothing to roll back to, so it reports
`new-runtime-installed-not-started` with the same log.

**A version fence, with semver precedence.** Installing an older runtime over a
newer one would open the machine's SQLite with an old binary, so it is refused
unless the User explicitly allows a downgrade. `1.10.4-beta.2` is correctly
older than `1.10.4`: getting that backwards would refuse the one upgrade a beta
tester needs.

**An interrupted setup is never resumed silently.** If the desktop closes
mid-install, the record is marked `needs-attention` on the next start. A retry
re-probes the machine before changing anything; a half-finished drain is
re-proven, not assumed.

## Secrets

The enrollment package carries the relay seal key. It is written from **stdin**
to a file created with `umask 077`, never interpolated into a script, never
placed on a command line (so it is invisible in `ps` on the machine), never
logged, and never stored in the install record. A regression test asserts all
four. Provider credentials are never copied from the desktop: the machine logs
in natively through the doctor's device-auth handoff, and the URL and code
surface on the install snapshot.

The tail of the service log is stored in settings and shown to the User, so
key-shaped runs (40+ base64url or hex characters) are replaced with
`[redacted]` before it is written down. A machine's log should never print a
key; this does not depend on that being true.

SSH access itself reuses what the desktop already has — the AWS worker key
material or a configured host — through `cloudRunSshOptionArgs`, including
connection multiplexing.

## The project mirror

`bootstrapProjectMirror` puts a project on a machine **once**. After that the
mirror is the machine's own working copy: the participant pulls, commits,
pushes and opens pull requests from it.

- An existing clean mirror is **reused**; nothing is copied.
- A mirror with uncommitted changes is **refused** and left untouched.
- Only a project the machine does not have is copied, and then `rsync --delete`
  cannot destroy anything because there is nothing there.
- Worktrees a participant created beside the mirror are listed and never
  touched. The app creates no worktrees, here or anywhere.
- There is no automatic resync, no file watcher, and no write-back.

## How large this gets, and where it ends up

Measured on 2026-09-07 against the real `npm run build:machine` output at
`1.10.4-beta.2`: **6.1 MB in 8 files**, of which 4.0 MB is the source map and
2.0 MB the runtime bundle. Fingerprinting it takes 29 ms cold and 6 ms warm.

It travels as an `rsync -az` stream over SSH. It does not go through argv, a
SQLite statement, a relay frame, a mailbox page, or an HTTP body. The remote
scripts are 1–4 KB of static text with paths substituted, delivered on stdin
(or as one argument when stdin carries the enrollment) — far below `ARG_MAX`,
and they contain no chat data at any size.

What is stored on the desktop is one `MachineInstallRecord` per machine in
`settings.json` (`machineInstalls`): SSH target, paths, service name, installed
version and the last operation snapshot — a few hundred bytes, bounded, one per
machine. It is deliberately excluded from `exportMachineSettingsSnapshot`,
because it carries this desktop's way into the machine, and it is deleted with
the machine record.

## What is verified, and what is not

Verified: 30 focused cases (`machineInstaller.test.js` and the transport/shell
guard) covering the phase order, the drain running before the switch even on a
first install, the enrollment never reaching a command line or a log, a refused
drain replacing nothing, rollback after a failed connect and after a connect on
the old release, an upgrade keeping its pairing, the no-op re-install, the
Node-20 refusal, the node-pty/build-tools failure message, the version fence
including betas, log redaction, interrupted-setup recovery, and the three
mirror outcomes. Every generated script is parsed by a real `bash -n`, including with
a hostile path containing a quote — that guard already caught one broken script
(`journalctl` continuation lines). The probe was executed by a real shell and
its output parsed back.

**Not verified yet, and needed before this is called done:** a real install and
a real upgrade against a real Linux machine, end to end through the Settings
UI, including a live drain of a Codex session and a rollback. That needs an
EC2 instance; the shared one (`i-0943b28f7231ab93c`) is stopped and reserved
for Drew's QA. `systemd`, `/proc`-based process ownership and passwordless
`sudo` cannot be exercised on macOS at all, and no unit test substitutes for
them.

## Integration still to be done (deliberately not in this branch)

The service is complete and tested but not wired: `main.ts`,
`src/shared/types.ts`, the preload bridge, `package.json` and the Machines UI
are all files another engineer is editing right now. The exact patch is:

1. **`src/shared/types.ts`** — re-export from `./machineInstall` and add to
   `AppBridge`:
   ```ts
   installMachine(request: MachineInstallRequest): Promise<MachineInstallResult>;
   upgradeMachine(request: MachineUpgradeRequest): Promise<MachineInstallResult>;
   probeMachineInstall(request: { machineId: string; target: MachineSshTarget }): Promise<MachineRuntimeProbe>;
   bootstrapMachineProjectMirror(request: MachineMirrorBootstrapRequest): Promise<MachineMirrorBootstrapResult>;
   onMachineInstallProgress(callback: (snapshot: MachineInstallSnapshot) => void): () => void;
   ```
2. **`src/main/main.ts`** — construct once, next to `AwsWorkerSetupService`:
   ```ts
   const machineInstaller = new MachineInstallerService({
     store: settingsService,
     doctor: cloudRunDoctorService,
     getEnrollmentJson: (id) => machineLinkService.enrollmentJson(id),
     waitForConnected: (id, timeoutMs) => machineLinkService.waitForConnected(id, timeoutMs),
     bundleDir: path.join(app.getAppPath(), "dist", "machine"),
     machineName: async (id) => (await settingsService.listMachines()).find((m) => m.id === id)?.name,
     logger: (event, payload) => void debugLogService.write(event, payload)
   });
   void machineInstaller.recoverInterruptedOperation();
   ```
   `SettingsService` already implements `MachineInstallStore`. `MachineLinkService`
   needs the two small methods above — `enrollmentJson(machineId)` returning the
   stored pairing package as JSON, and `waitForConnected(machineId, timeoutMs)`
   resolving `true` on the next hello from that machine.
   Handlers stream progress on a `machines:install-progress` channel.
3. **`package.json`** — add
   `"test:machine-install": "npm run build:main && node --test dist/main/main/services/machineInstaller.test.js scripts/machine-install-transport-guard.test.mjs"`,
   and append both files to `test:machines`.
4. **Machines settings section** — an "Install / Upgrade" action per machine
   that collects the SSH target, renders `MACHINE_INSTALL_PHASE_ORDER` as a
   checklist against `snapshot.completed`, shows `authUrl`/`authCode` during
   `preflight`, and shows `recovery.detail` with a Retry on a terminal failure.
   Packaged builds ship no `dist/machine`; `readMachineBundle` throws a clear
   message, and the packaging step needs to include the bundle before this ships.
