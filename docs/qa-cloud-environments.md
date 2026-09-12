# Two laptop environments on one instance — 2026-09-11

## Scope and status

Continuation in `drew/machine-member-ownership`, based on `7d9b0d7`; the main
checkout is unchanged. The User requires separate home/work environments on one
AWS instance, with both separately installed PWAs on the same iPhone.

Implementation, focused tests and review are complete; end-to-end acceptance is
**incomplete**. One isolated environment was installed through the real Electron
UI on the existing AWS instance and ran native Codex turns; the second environment
is blocked on OpenAI's phone verification. The two installed iPhone PWAs have not
been exercised. No additional instance, IAM change, release, push or PWA deploy
occurred.

## Changed path

Cloud run selection derives a stable install directory from the desktop's
persisted device identity. Each new deployment has its own service, data,
enrollment, native HOME and global-skill bundle. Existing complete installations
keep their original paths and native sessions; an incomplete legacy setup record
does not force the shared default service name on a new deployment.

Before setup or project copying, an atomic owner claim checks the enrollment and
refuses a different desktop. Enrollment is passed on stdin, not as a command-line
argument. Concurrent claims, corrupt ownership records, restart after the first
SSH probe fails, and retry of pending tilde paths are covered by focused tests.

The installer, AWS Check/Set up, provider sign-in and runtime use the same profile.
CODEX_HOME, CLAUDE_CONFIG_DIR and XDG paths cannot be redirected into another
environment by source-laptop settings. The existing portable global-skill sync
now runs during machine preparation and is scoped to this deployment. Native
authentication/session files are retained and are not copied from the laptop.
Current AWS connection details are used for both the owner check and skill sync.

This isolates configuration under the shared SSH user; it is not an OS security
boundary between hostile users. The PWA implementation is unchanged: this task
targets two installed apps, not re-pairing one app between environments.

## Verification

- `npm run test:machine-environments`: **111/111 pass**. Real filesystem, Python
  atomic claims, native shell environments, portable-skill activation and
  separately running SettingsService processes complement installer/doctor tests.
- `make typecheck`, `make build`, `git diff --check`: pass.
- Supporting mobile pairing, mobile relay control, AWS setup and machine-host
  tests: **54 pass, 1 failure**. `saved snapshots deliver and clear cards without
  a second history read or a visible message` also fails on ten independently
  compiled, unchanged source files from `7d9b0d7`; its card-clear assertion remains
  a known failing check, not a passing suite. No fix to that separate path here.
- Gstack `/review` applied to the complete isolation diff. Findings corrected:
  first-probe failure losing isolation intent, Settings using unresolved/shared
  paths, reuse of the default unit from an incomplete legacy record, and use of
  stale connection details for skill sync. Real AWS QA then exposed a lost SSH
  owner-refusal diagnostic; the fixed message now reaches setup, Settings and
  mirror callers without exposing arbitrary command output. Reviewed the final
  correction and reran the focused suite, typecheck and build. No remaining code
  finding in this diff; external acceptance gaps remain below.

## Local Electron and relay evidence

Two isolated Electron windows from the built feature branch on macOS arm64, with
two built machine runtimes on the same host, used the real `relay.accordagents.com` WSS service.
Each machine was added through its own Electron Settings UI. A synthetic variable
was saved through each window's Environment form, then read from the corresponding
runtime's persisted settings after delivery:

| Environment | Initial value | After home change and runtime restart |
| --- | --- | --- |
| Home | `home-qa-value` | `home-updated` |
| Work | `work-qa-value` | `work-qa-value` |

The home machine retained its device identity after restart; the work machine
stayed connected. Each runtime's CODEX_HOME and CLAUDE_CONFIG_DIR resolved under
its own HOME. The two windows listed only their respective enrolled machines.
Screenshots were inspected at `screenshots/qa-cloud-environment-home.png` and
`screenshots/qa-cloud-environment-work.png` (ignored QA artifacts).

Save did **not** immediately push the changed variable to an already connected
machine; reconnect delivered it. This existing behavior is recorded in the parity
register and is not claimed as live settings synchronization. No native provider
turn or AWS Linux service installation was exercised by this macOS check.

## Real AWS evidence

The saved SSH address was stale. The configured AWS CLI returned the current
address, and the existing app-managed instance key connected successfully; no
personal-key fallback was needed. The actual instance has a 40 GB disk, with
about 22 GB free before this QA, rather than the 8 GB desired setting shown in
the screenshot.

Two isolated Electron profiles selected Cloud run against that one Linux x64
instance. The installer derived different directories from their desktop
identities. The home environment completed native device sign-in, copied the
User's actual global skills, installed its own systemd service, connected over
the production relay and returned `HOME_CLOUD_OK` in its own chat.

A second native turn, with one-time read-only shell approvals through the real
chat UI, returned its own HOME/CODEX_HOME/CLAUDE_CONFIG_DIR, synthetic variable
`EXAMPLE_ENV_ISOLATION=home-updated`, and confirmed the synthetic work skill was
absent. A targeted systemd restart preserved the machine's device identity and
chat, produced a new runtime instance identity and did not replay a turn. The
existing cloud services stayed active.

The work profile kept its own directory and enrollment claim across a forced
desktop restart. Its native OpenAI sign-in reached **Phone number required**;
no phone number was entered and no credentials were copied to get around it.
Its global-skill activation and native turn therefore remain unverified on AWS.
The Settings option **Do not check** also still requires Codex sign-in through
the existing doctor default, so it did not provide a runtime-only QA path.

For the owner-conflict check, the second QA desktop was deliberately pointed at
the first QA environment through Settings. Setup failed before provider setup,
transfer or restart; hashes of the first environment's enrollment and owner
files and its process PID stayed identical. Initially the UI said only
`ssh exited with code 1`; after the correction and rebuild the same real action
displayed **This installation belongs to another environment; nothing was
replaced.** The message was visually inspected in Electron. Screenshots:
`screenshots/qa-cloud-environment-aws-home.png` and
`screenshots/qa-cloud-environment-owner-refusal.png` (ignored QA artifacts).

The work QA app also exposed an existing local-readiness restriction: a local
Codex profile without sign-in disables the entire new-member settings block, including
Cloud run selection. Restoring that QA window's existing local Codex profile
allowed the cloud test to proceed; this does not prove cloud selection works
without local sign-in. These existing UI defects are recorded separately in the
parity register, without silently changing their behavior in this task.

## Data size and destinations

Building the portable bundle from the User's actual global skills measured
**18,545 files / 1,355,564,368 bytes / 17,641 ms** locally. The bundle is staged as
files, transferred by rsync, and activated under the environment's own directory;
it does not become an argv element or SQLite payload. The installer displays the
skill-sync phase. First transfer is substantial; this change does not silently
omit skills or claim that the transfer is cheap. Runtime payload: about 6.97 MB.

## Test-resource cleanup

The newly installed home QA systemd service was stopped and disabled after the
checks; its data was retained for follow-up. The pending work QA device-login
processes, both disposable Electron windows and the earlier local QA machine
processes were stopped. The User's main app, older requested test instance and
pre-existing cloud services were preserved; the existing EC2 instance was not
stopped. Nothing has been committed or published from this worktree.

## Missing acceptance evidence

- The second environment's native OpenAI login requires phone verification.
  Both profiles running together on AWS, different global-skill sets on that
  server and native execution from the second profile remain unverified. The
  successful first installation and cross-owner refusal are narrower evidence.
- The latest physical-device query lists the paired iPhone as **unavailable**.
  Both installed
  PWAs must be checked on that one phone: distinct laptop pairing, correct chat
  lists and notification destinations, an offline queued message delivered only
  to its own environment, and independent behavior after reopening either app.
  Desktop Electron, focused tests and WebKit documentation do not prove this.
