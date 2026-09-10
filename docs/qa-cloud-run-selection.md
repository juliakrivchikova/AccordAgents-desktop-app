# Cloud run selection: desktop and AWS verification

Verified on macOS arm64, 2026-09-10. Based on the approved beta.6 baseline
with the chat responsiveness fix `acda44c`; the user's checked-out tree and
installed application were not changed. This is not a published release.

## User-visible behavior

- Member settings and the new-chat member picker offer Local and Cloud run.
- Cloud run prepares the existing running AWS instance, reuses its machine
  identity on retry, checks the selected provider, and displays setup or native
  sign-in progress before assigning the member. It never provisions a second
  instance as a fallback.
- A participant's machine stays locked after its first run, in both the UI and
  ChatService. Removing and adding a member is still how its machine changes.
  Editing its model or permissions preserves its machine.
- Project setup happens before the chat/member is saved. The machine gets its
  own project path; the desktop keeps its local path. Existing machine work is
  reused untouched, including ordinary folders without Git. First copies are
  staged and renamed without replacing an existing project.

## Defects reproduced in the real install path

1. macOS rsync stripped quotes from the maintenance command, producing a remote
   shell syntax error. A private temporary executable now preserves arguments;
   cleanup is checked for success and transfer failure.
2. The process scanner matched another installation sharing the same path
   prefix. It now requires the directory separator. During reproduction the
   neighboring QA service was inadvertently restarted once; the corrected
   install and cleanup did not restart it again.
3. Linux `install /dev/stdin` rejected the guardian's socket stdin with ENXIO.
   The service unit is now read into a temporary regular file first, and a
   failed write stops before enabling the service.
4. Maintenance waited for peer stdin EOF after its command had exited. rsync
   waited for maintenance to exit before closing that input. Completion now
   follows native process closure, while still draining output and preserving
   the guardian's power-hold/closure receipts.
5. A non-Git folder was reported as absent, making a copied project unusable
   and eligible for another copy. Existing folders are now recognized and
   incomplete first copies are never published as runnable projects.

## Real Electron results

An isolated Electron profile used a copy of the user's database: 3,709,259,776
bytes at the final check. UI actions used the real preload, real AWS instance,
production relay, Linux machine service and native Codex CLI; no mocked provider.

| Action | Observed result |
| --- | --- |
| Select Cloud run on the running AWS instance | Install, enrollment, systemd start and relay connection completed; selector assigned the machine |
| Send a new no-project chat to that member | Native final response `CLOUD_SELECTION_NATIVE_OK`; UI reported 17 s |
| Open the member editor after its first run | Run on disabled, with remove/re-add explanation |
| Restart the isolated desktop and select the existing AWS machine | Machine identity reused and provider checked; runtime service restart count remained zero |
| New chat using an ordinary project folder | Folder copied once and native Linux project path stored on the machine; local path retained on desktop |
| Approve read access and the exact `cat` command from desktop cards | Both native continuations ran; final response `CLOUD_PROJECT_FILE_20260910` matched the file |
| Stop and remove the test installation | All 22 native registry rows closed; QA-created service/profile/project removed; pre-existing service remained active |

Screenshots of selection, setup, locked controls and final native answers were
captured and visually inspected. AWS remains running as requested. The existing
provider logins, legacy services, toolchain and pre-existing releases were kept.

## Checks and review

- `make typecheck`, `make build`, `make lint-colors`, `make lint-unused`: pass.
- Cloud preparation, installer and generated-script guards: 54/54 pass.
- Selector and runtime-controls tests: 5/5 pass.
- Native maintenance lifecycle: 5/5 pass, including a binary duplex response
  with stdin deliberately left open, controller crash, refused admission and
  durable cleanup failure.
- Supporting AWS/settings persistence: 41/41; host/link: 14/14; first-run lock
  and failed project persistence: 2/2. These targeted checks were run during
  implementation, not represented as a full permissions-suite pass.
- The gstack review checklist was applied to the whole diff and connected
  callers, including enum consumers, settings reload, provider readiness,
  replication, shell quoting, retry and native process ownership. The concrete
  findings above and runtime-setting machine preservation were corrected.

Data-size review: the database is not copied to AWS. Only the selected project
uses the existing mirror transfer; subsequent chat messages use the existing
sealed relay. The runtime payload is 6,940,754 bytes across nine manifest files,
transferred over rsync stdin/stdout rather than command arguments. New persisted
data is an instance association and paths per project/machine, not conversation
snapshots. Temporary remote scripts contain paths and commands only.

## Limits

- This proves a checkout-built Electron app installing a fresh runtime on real
  Linux, not a signed packaged update or an installed-phone workflow.
- Native Codex was exercised end to end; a new Claude sign-in was not required
  by the existing machine and is not claimed as verified here.
- An already installed runtime containing the old duplex deadlock still needs
  an upgrade bootstrap path: it can hang while wrapping the upload of its own
  replacement. The real clean-install retry removed only this test's stale
  current link after confirming no service/providers were running; production
  code does not perform that workaround. Do not claim this as old-runtime
  upgrade acceptance.
- One isolated Electron process kept its debug port after its renderer closed
  during restart; it was explicitly stopped before restarting QA. Graceful
  desktop process exit is not claimed by this verification.

The separate responsiveness reproduction and before/after timings are in
`docs/qa-beta6-chat-freeze.md`.
