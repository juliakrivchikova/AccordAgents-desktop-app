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

## Where it lives

Settings → General → **Machines** → a machine row → **Set up** (or **Upgrade**).
The panel takes the address, user, SSH key file, which provider the members on
this machine will use, and an optional install directory; it then shows the
steps below as a checklist, and **Put project on machine** does the one-time
mirror bootstrap.

`MachineInstallerService` is wired in `src/main/main.ts` and reached through
`machines:install`, `machines:upgrade`, `machines:install-probe`,
`machines:bootstrap-mirror` and `machines:install-list`, with progress pushed on
`machines:install-progress`.

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
| `verify` | The desktop waits for a hello that arrives **after** the restart and reports the new version, then reads back which release the machine actually runs. Not "systemd says it started", and not "something answered". |
| `ready` | Done. |

Terminal failures are `error` (nothing was attempted or nothing changed) and
`needs-attention` (something on the machine needs the User). Every failure
carries a `recovery` block naming what is true on the machine right now:
`nothing-changed`, `old-runtime-still-installed`, `rolled-back`,
`new-runtime-installed-not-started`, or `manual-drain-required`.

## One deployment, one data directory, one unit

The install directory decides the rest. `~/accordagents-machine` keeps the
documented defaults (`~/.accordagents/machine`, unit `accordagents-machine`);
any other directory gets `~/.accordagents/<name>` and the unit `<name>`. The
machine computes this in the probe, so the desktop and the machine cannot
disagree about it.

That is not tidiness. Two deployments sharing one user-data directory are two
executors for the same participant session, and a second install under the
default unit name would take over the first one's service. Both happened during
QA before this was fixed.

## Where the runtime payload comes from

The desktop installs a payload it carries itself; there is no download and no
source checkout involved.

| Where the app runs | Payload directory | Source |
|---|---|---|
| Packaged application | `<App>.app/Contents/Resources/machine` (Windows: `resources/machine`) | `packaged` |
| Checkout | `dist/machine` | `checkout` |
| `ACCORDAGENTS_MACHINE_BUNDLE_DIR` set | that directory | `override` |

It ships as a **loose resource, never inside the asar**: `rsync` copies real
files to the machine and nothing inside an asar has a path on disk. Packaging
excludes `dist/machine` from the asar so the same 6 MB is not shipped twice,
and `npm run build` produces it, so every packaging path — `npm run package`,
`npm run make`, and the signed release through `signed:mac-arm64` — includes it
by construction rather than by remembering.

A payload may contain only regular files and directories. Anything else — a
symbolic link, a pipe, a device — is **refused**, by the bundler when it builds
the payload and by the desktop when it reads one. Skipping them, as both
scanners first did, was a real hole: `rsync -a` copies a symbolic link to the
machine as a link, so a payload could carry content that the manifest never
described and the digest never covered. Verified on the real machine before the
guard existed: a link `appSkills/escape.md` arrived and resolved to `/etc/hosts`
there.

`npm run build:machine` writes `payload.json` next to the bundle: the version
and, for every file, its size and SHA-256. A packaged application cannot
rebuild its payload, so it verifies it instead — exact file set, exact sizes,
exact hashes — and refuses a payload that does not match the build rather than
installing a runtime that cannot start. The manifest is excluded from the
bundle digest that names the release directory on a machine, so adding it did
not change how existing releases are identified.

Two more refusals guard the same path. The payload's version must match the
desktop's, so a stale payload cannot put a runtime on a machine that this
desktop was never built against; and the manifest's version must match the
payload's own `package.json`, which catches a payload assembled from two
different builds. The override deliberately skips the version check, because
that is what it exists for.

Settings → Machines shows the result before anything is set up: *Runtime to
install: 1.10.4-beta.2 · 8 files · 6.1 MB*, or, when the payload is missing or
damaged, why — with "reinstall it from the release you downloaded" for a
packaged application and "build it with `npm run build:machine`" for a checkout.

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
`1.10.4-beta.2`: **6,397,743 bytes in 8 files**, of which 4.0 MB is the source
map and 2.0 MB the runtime bundle. One verified read — per-file hashes for the
manifest check and the release digest in the same pass — takes about 30 ms, and
it runs once per install and once when the Machines screen opens.

That payload is also what every packaged application now carries: 6.1 MB added
to the app bundle once, not per machine and not per install.

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

### Real machine, real relay, real UI — 2026-09-06/07

Driven through the Settings → Machines panel of an isolated Electron instance
(own profile, CDP port 9236) against the User's EC2 (`i-0943b28f7231ab93c`,
Ubuntu 24.04, Linux x64, Node 22.23.1, systemd 255) over the public relay
`wss://relay.accordagents.com/v1/relay`. Codex was already signed in on the
machine as `ubuntu`; nothing was copied from the desktop. A separate install
root (`~/accordagents-installer-qa`), data directory and unit were used, and the
existing `~/accordagents-machine` deployment, `~/.accordagents/machine-qa` and
every repository, worktree and uncommitted file on the box were left untouched
(verified before and after).

| # | Scenario | Result |
|---|---|---|
| 1 | Install from nothing | `ready` in 16 s. Unit `accordagents-installer-qa.service` active, `enrollment.json` mode 600, own data directory created, hello reported `1.10.4-beta.2`. |
| 2 | Upgrade blocked by a process this install owns that will not exit | 213 s, `needs-attention` / `manual-drain-required`, blocking pid reported, `current` and `install-state.json` unchanged, the staged release unused. |
| 3 | Upgrade `1.10.4-beta.2` → `1.10.5-qa.2` | `ready` in 16 s. Hello reported the **new** version, both releases kept, enrollment and machine data preserved (`machine-outbox.json` survived). |
| 4 | Upgrade to a build that exits on start | 197 s, rolled back to `1.10.5-qa.2`, machine connected again, journal tail shown, broken release kept but not active. |
| 5 | Project mirror: bootstrap, then dirty, then clean | `created`; after uncommitted edits `refused` with both changes intact and a participant-created `git worktree` untouched; after committing on the machine `reused`, nothing copied, the machine's own commit still there. |
| 6 | Desktop killed during `verify` of an upgrade | After restart: `needs-attention` / `new-runtime-installed-not-started`, retryable, nothing resumed automatically, the machine exactly where it was left. |
| 7 | Downgrade | Refused with the versions named; nothing on the machine changed. |
| 8 | Forward upgrade over the broken build | `ready` in 16 s; the machine recovered from a crash-looping release. |
| 9 | Preflight with "Provider to sign in: Codex CLI" | Passed; the machine was already signed in. |

Screenshots: `screenshots/qa-machine-install-ready.png`,
`screenshots/qa-machine-installer-settings.png`.

Two defects were found by this QA and fixed here, neither of which the unit
tests could have caught, because they fed the installer canned probe output:

1. The probe was told to use the default unit name, so a deployment in its own
   directory installed itself as `accordagents-machine.service` — the exact
   collision the derived layout exists to prevent.
2. After a refused drain the message said "the machine keeps working". The drain
   stops the unit before it discovers the stray process, so the machine was in
   fact down. It now says that, and says why it is deliberately not restarted.

### Focused checks

31 cases in `machineInstaller.test.js` plus the transport/shell guard: the phase
order, the drain running before the switch even on a first install, the derived
unit name, the enrollment never reaching a command line or a log, a refused
drain replacing nothing (machine up and machine down), rollback after a failed
connect and after a connect on the old release, the required-provider check and
the sign-in hand-off, an upgrade keeping its pairing, the no-op re-install, the
Node-20 refusal, the node-pty/build-tools failure message, the version fence
including betas, log redaction, interrupted-setup recovery, and the three mirror
outcomes. Every generated script is parsed by a real `bash -n`, including with a
hostile path containing a quote.

### Packaged macOS application — 2026-09-07

Built locally with `npm run build && npx electron-forge package
--platform=darwin --arch=arm64`, launched from
`out/AccordAgents-darwin-arm64/AccordAgents.app/Contents/MacOS/AccordAgents`
with an isolated user-data directory and CDP port 9237, and read through the
real Settings → Machines screen:

- Healthy payload: *Runtime to install: 1.10.4-beta.2 · 8 files · 6.1 MB*,
  `data-source="packaged"` — located and hashed from the application's own
  resources, with no checkout involved.
- `accordagents-machine.cjs` truncated to 200 bytes in the packaged app:
  *"… is damaged: accordagents-machine.cjs does not match the build. This copy
  of AccordAgents is incomplete; reinstall it from the release you downloaded."*
- `Contents/Resources/machine` removed entirely: *"The machine runtime payload
  is missing from … This copy of AccordAgents is incomplete; reinstall it…"*
- Payload restored; the packaged-contents test passes again.

Screenshots: `screenshots/qa-machine-payload-packaged.png`,
`screenshots/qa-machine-payload-corrupt.png`.
`scripts/packaged-app-contents.test.mjs` now checks any packaged application in
`out/` for the payload, every file's size and hash against the manifest, and
that the payload version equals the application version — and that the asar
contains no `dist/machine` entry.

### Packaged payload onto the real machine — 2026-09-07

A **component check**, not Settings UI QA: the same rsync invocation
`defaultBundleUpload` builds (same helpers, same flags) copying
`AccordAgents.app/Contents/Resources/machine` to a scratch directory on the
User's EC2 (`i-0943b28f7231ab93c`, `100.48.98.97`). 6,397,257 bytes in 8 files
arrived in 2.0 s; every file was re-hashed **on the machine** against
`payload.json` with zero mismatches, and `find ! -type f ! -type d` found
nothing. The scratch directory was removed afterwards. This proves the packaged
resource directory is transferable and arrives intact; it does not prove the
Settings flow, which is blocked below.

### Not verified

- The interactive provider sign-in hand-off. The machine was already signed in,
  and signing Codex out on the shared box would have destroyed another
  engineer's authentication. The desktop's relaying of the URL and code is
  covered by a focused test, not by a real device-auth round trip.
- A user-scope (`systemctl --user`) install: this machine has passwordless
  sudo, so every real run took the system-unit path.
- Windows and macOS as machine targets. This is Linux only.
- **Installing onto a Linux machine from the packaged application, through
  Settings.** Blocked on this Mac by the macOS secret store, not by the
  installer. Details below.
- Signing and notarization of the new loose resource: the release path's
  `osxSign` pass over `Contents/Resources/machine` has not been exercised.

#### The exact blocker for packaged-app pairing

macOS keeps one safe-storage keychain item per application name. On this Mac
`AccordAgents Safe Storage` / `AccordAgents Key` already exists in the login
keychain (created 2026-06-07 by the installed, Developer-ID-signed app). A
locally packaged build has a different code identity, so:

- **Unsigned local package:** the lookup fails with
  `errSecAuthFailed (-25293)`, `safeStorage.isEncryptionAvailable()` is false,
  and `machines:create` refuses with "Machine enrollments need the system secret
  store, which is not available on this computer." No machine can be added, so
  no install can start.
- **Ad-hoc signed local package:** macOS raises a modal Keychain authorization
  dialog for that existing item and the app blocks before its debugging port is
  reachable. Nothing in an unattended session can answer it, and answering it
  would grant a locally built binary access to the real application's encrypted
  settings.
- **Renaming the product does not help.** A build packaged as `AccordAgentsQA`
  with its own bundle id still reached the `AccordAgents` item and created no
  item of its own, so a QA build cannot get a separate secret store this way.

The unblock is a package signed with the same identity as the installed
application (`Developer ID Application: … (VPQ8HUMJ2S)`, which is present in the
keychain) and the same bundle identifier — that is, the real release path. That
uses the User's signing key, so it is her call, not an engineer's. Everything on
the installer side that does not need a secret is proven: the packaged app
locates, hashes and version-checks its payload through the real Settings screen,
and that payload transfers to the real machine intact.

## Automatic idle stop on a shared instance

Idle is measured per deployment: each has its own user-data directory, its own
SQLite and its own scheduler. The instance they run on is shared. Without
coordination the first deployment to reach three hours idle would stop the
instance underneath another deployment's provider turn or maintenance lease,
destroying work it cannot see.

Every runtime publishes one claim file in `/tmp/accordagents-host-power`
(cleared on boot, readable across OS users) saying what it is doing, refreshes
it on every idle poll, and reads the others before it allows a stop. The rules
are deliberately one-sided: a claim from another boot or from a process that is
gone is pruned, and a claim whose process is alive but has stopped refreshing
counts as **busy**. A machine that never stops is a visible cost; a stop that
kills another deployment's turn is lost work. If the directory cannot be used
at all, automatic stop is suspended with a visible warning rather than taken
without coordination.

**Residual, stated rather than hidden:** the check runs immediately before the
local fence, so the window in which another deployment could start work
unnoticed is sub-second rather than hours. Closing it completely needs a
host-wide admission lock that every deployment consults before admitting native
work; that is not in this change.

## Upgrading a release that predates maintenance

`--maintenance` did not always exist. An older runtime's argument parser
ignores unknown flags, so `node <old runtime> --maintenance --user-data <dir>
-- <command>` would not run the command at all — it would start a **second
runtime on that user-data directory**, which is the duplicate executor the
transport forbids.

Every payload now ships a `maintenance-v1` marker, the probe reports whether
the installed release has one, and the wrapper refuses rather than exec a
release without it. An upgrade from an older release is still protected: the
steps before staging only create a new release directory — they cannot disturb
a running runtime or an existing stop fence — and from the drain onward the
wrapper uses the release that was just staged, which always understands the
flag. The User sees a warning saying exactly that.

## Still open

- A crash-looping release restarts every 3 s for the whole three-minute connect
  window (56 restarts observed) before the rollback. It is bounded and it
  recovers, but a start limit is worth considering.
- The provider selector defaults to "Do not check", which preserves the previous
  behaviour exactly. Whether it should default to Codex — so a machine that
  cannot host anything is caught at setup rather than at the first turn — is a
  product decision for the User, not one to make here.
