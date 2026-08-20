# Cloud Run + PWA End-to-End QA Scenarios

> ## GOAL: run this QA from the cloud
>
> **Owner:** unassigned — needs a participant with auto-watch or a native `/goal`.
> A Claude chat turn is one-shot and cannot iterate on its own.
>
> **Objective:** get most of the scenarios below executed and fixed by cloud
> members, with the laptop closed.
>
> ### Done (verified live on a cloud-run QA worker, 2026-08-15)
> - Chrome 151 installs via the Google `.deb` path; headless Chrome + CDP responds → **browser QA works on the worker**.
> - `xvfb-run` + headed Chrome works, real display `Xvfb :99 1280x1024x24`.
> - **Electron 31.7.7 — the app's exact version — starts under `xvfb-run` with a live BrowserWindow and a CDP page target.** Group 2's core assumption is proven, not inferred.
> - New doctor probes return `browser=ok` / `headless-display=ok` against the live box.
> - Both installs cost 500 MB. Worker disk is 15 G, 7.8 G free.
>
> ### Done (verified on device and by an end-to-end stand, 2026-08-19)
> - **§9.5 Timeline row lifecycle** is new, and is the only fully `VERIFIED` block in this document. Five defects lived in the gap between "the message was sent" and "the answer is on screen" — a gap this list did not have a section for. Every case runs against the real publisher, a real relay and mailbox, and the built PWA in a real browser: `npm run test:mobile-e2e`.
> - **P-11 identity** and **P-12 live update** move from `CODE-OK` to `VERIFIED`; both were reading-the-source guesses and both were wrong. Live update never worked at all — the phone stringified binary frames and dropped every one.
> - Method note worth keeping: a scenario is only evidence once it has been **proven red on the build before the fix**. One of the twelve passed on both builds until its message was made realistically tall.
>
> ### Stale entries corrected 2026-08-19
> Three statuses in this document were not merely unproven but **wrong**, and each was believed for weeks. Re-read the source before planning against any row here.
> - **B6/B7 cleared** — Chrome, xvfb and sqlite3 are provisioned.
> - **X-21 VERIFIED** — a cloud member opened four PRs from the box on 2026-08-15.
> - **P-11 identity / P-12 live update** — see §9.2; P-12 never worked at all.
>
> ### Next, in order
> 1. **Run the app itself on the worker**: sync the repo, `npm ci`, `xvfb-run electron . --remote-debugging-port=9222`, then drive a real flow over CDP. Only the app-specific build remains unproven.
> 2. **Have a cloud member do it unattended** and report findings as its reply (that path works today — `provider_result`, not `app_chat_send_message`).
> 3. **Work the `CODE-OK` cases** in §5–§8 — cheapest way to find where the source reading is wrong.
> 4. **SK-02 / B5** — global skills never reach the worker. Needs a scope and secrets decision before any sync.
> 5. **B2** — worker relay is 3 tools. Blocks accords and mid-run posts.
>
> ### Standing constraints
> - Never `pkill` Electron or restart the app hosting the chat.
> - Cloud QA validates the **Linux** build. Say so in every report.
> - Stop the AWS worker when unattended; a CLI-started worker has no idle timer.


Branch: `drew/serverless-shared-chat` (verified at `a26aed2`). Every code claim below was checked against this branch, not against `main` and not against the artifact version of this list, which predated Drew's Claude cloud-run work landing.

## How to read the status column

| Status | Meaning |
|---|---|
| `CODE-OK` | The code appears to implement this. **Not QA-verified** — this is a reading of the source, not evidence. These are the cases to run first, because they are the cheapest way to find out whether the reading is right. |
| `SMALL-FIX` | A known gap with an understood, bounded change: a missing package, a wrong constant, a missing guard, a missing UI affordance. Hours to a day each. |
| `REAL-WORK` | Needs design and implementation, not a patch. Days or more, and in some cases a product decision first. |
| `VERIFIED` | Evidence exists and is named: an automated end-to-end stand, a live device pass, or both. This is the only status that is not a guess. A `VERIFIED` row still says *what* verified it, so the claim can be checked or challenged. |

Where a case is blocked by a capability gap, the blocker id (`B2`, `B5`…) is named so the dependency is explicit.

---

## 0. Capability status

Re-verified on this branch. Two entries changed since the earlier version of this list.

| ID | Capability | State | Evidence |
|---|---|---|---|
| **B1** | **Claude cloud run** | **CLEARED** — was blocked, now implemented | `chat.ts:8575` now reads *"Cloud Runs currently supports Codex and Claude members only."* `remoteRuns.ts` has a real `claude-code` branch: invocation builder (`:3073`), executable resolution (`:3145`), permissions and allowed-tools (`:3188`, `:3227`), reasoning-effort mapping (`:3303`). Drew reports one live PASS. Treat the whole CL section as `CODE-OK`, not proven. |
| **B2** | **Worker App MCP surface is 3 tools** | STANDS | `remoteRuns.ts:3348` — `app_permissions_request_change`, `app_chat_get_context`, `app_chat_get_participants`. Everything else → `Unknown worker relay tool` (`:4450`). A cloud member cannot send chat messages, read messages, touch artifacts, or request another participant. |
| **B3** | **PWA has no approve / choice / artifact / Stop surface** | STANDS | `src/mobile/index.html` and `mobile-app.js` contain chat list, timeline, and composer only. Grep for approval/choice/permission/artifact/Stop returns nothing. |
| **B4** | **Beta release cannot run on a worker** | STANDS, and is structural | `scripts/signed-mac-arm64.mjs:157-189` requires darwin + arm64 + Xcode CLT + `notarytool` + a local `Developer ID Application` identity. Workers are Ubuntu x86_64. |
| **B5** | **User-global skills never reach the worker** | STANDS — newly identified | Skill roots are `~/.agents/skills`, `~/.claude/skills`, `repo/.agents/skills`, `repo/.claude/skills` (`userSkills.ts:567-609`). Mirror sync copies **only** the repo (`remoteMirrorSync.ts:82`), and `HOME` is on the env-forwarding denylist (`remoteRuns.ts:108`). So a cloud member gets repo-local skills and **none** of your global ones — including the app-generated `accordagents-accord` and `accordagents-app-chat-request` bridge skills. |
| **B6** | **No browser QA capability on the worker** | **CLEARED** — provisioning changed since this was written | `awsWorkerProvisioning.ts:286` installs Google Chrome from Google's `.deb`, chosen over the snap-backed `chromium` package precisely because it works headless on a bare EC2 box. |
| **B7** | **No Electron QA capability on the worker** | **CLEARED** — same change | `xvfb` and `sqlite3` are in the package list (`:274-276`), and the Chrome `.deb` pulls the GTK/NSS/ALSA libraries Electron needs, so one install covers both browser and Electron QA. The xvfb comment states the intent outright: "a worker without Xvfb cannot start the app at all." |

**Decision already taken (2026-08-15):** a cloud member driving CDP against the Mac's Electron is **rejected**. The laptop must be closed and offline. Cloud QA therefore validates the **Linux** build. That is genuine evidence for renderer work — React, CSS, layout, chat flows, the PWA — and is *not* evidence for main-process behavior, `node-pty`, macOS paths, signing, or packaging. Those stay desktop-verified.

---

## 1. Harness rules

Not optional. Each of these has already cost real QA time.

| ID | Rule | Status |
|---|---|---|
| E-01 | The instance under test must have been launched **after** the build. Record build time and process start time. Electron loads main-process code once at launch. | CODE-OK |
| E-02 | Never `pkill` Electron; never restart the app hosting the chat. Use an isolated instance: `ACCORDAGENTS_USER_DATA_DIR=/private/tmp/accordagents-qa-<name>` + `--remote-debugging-port=9223`. | CODE-OK |
| E-03 | Launch with `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`, and `Page.bringToFront` before interacting. | CODE-OK |
| E-04 | Verify through the CDP renderer. Never `http://127.0.0.1:5173/`, never macOS `screencapture`/AppleScript. | CODE-OK |
| E-05 | Baseline the suite on the merge-base before attributing a failure to this branch. | CODE-OK |
| E-06 | Fresh worktree: `vite build` failing on `@rollup/rollup-darwin-arm64` → `npm i @rollup/rollup-darwin-arm64@<ver> --no-save`, rebuild. | CODE-OK |
| E-07 | **iOS cannot be QA'd through CDP.** Phone cases need a real device, or an explicitly-labelled desktop-Safari substitute. | REAL-WORK (no automation path exists) |
| E-08 | Have ready: MTU 1280 path, 10–20 % packet loss, 30 s blackout, Mac suspend/resume. Several defects appear only under these. | CODE-OK |
| E-09 | Exactly one QA instance should be running, and its CDP port and worktree must be identifiable via `ps -axo pid,ppid,command`. Two instances on the same userData caused a Stop that silently did nothing. | CODE-OK |

**Matrices.** Devices: Mac desktop, iPhone PWA installed, iPhone PWA in Safari, second desktop instance on the same userData. Providers: Codex local, Codex remote, Claude local, Claude remote, Claude Auto, Gemini/agy local. Hosts: AWS worker, BYO SSH host, worker stopped, worker unreachable.

---

## 2. BQA — Browser QA from a cloud member

The tooling is already portable: `scripts/cdp.cjs` is plain Node `http` + `ws` with no macOS dependency, and `scripts/qa-mobile-pwa-staging.mjs` already launches a real Chrome and drives raw CDP. What is missing is the browser binary on the worker.

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| BQA-01 | Chromium exists on the worker | A cloud member can launch a headless browser and reach `/json/version`. | SMALL-FIX (B6) — add Chromium + libs to `awsWorkerProvisioning.ts:267`; no app-code change |
| BQA-02 | Cloud member drives the PWA in a browser | Navigate to the mobile PWA, pair, read a timeline, send a message, screenshot. | SMALL-FIX — follows from BQA-01 |
| BQA-03 | Screenshots come back to chat | The member captures a PNG on the box and it is viewable in the chat. | REAL-WORK (B2) — `app_chat_send_message` with attachments is not in the worker relay |
| BQA-04 | Preflight names the gap | A member asked to do browser QA with no browser installed. | SMALL-FIX — add a `chromium` toolchain requirement so the failure is explained, not mysterious |
| BQA-05 | Browser QA of an arbitrary web target | Point the member at any URL and have it report console errors, network failures, and layout. | SMALL-FIX — follows from BQA-01 |
| BQA-06 | Concurrent browser sessions | Two members run browser QA at once. | CODE-OK once BQA-01 lands — distinct ports; verify no CDP port collision |
| BQA-07 | Browser QA disk cost | Repeated runs with profile dirs and downloads. | SMALL-FIX — profile cleanup; interacts with the worker disk problem in W-18 |

---

## 3. EQA — Electron desktop QA from a cloud member

Validates the Linux build (see the decision note in §0).

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| EQA-01 | Electron can start on the worker | `xvfb-run node_modules/.bin/electron . --remote-debugging-port=9222` starts and `/json/version` responds. | VERIFIED (2026-08-15) — Electron 31.7.7, the app's exact version, starts under `xvfb-run` on the live box with a BrowserWindow and a CDP page target. `xvfb` and the GTK/NSS/ALSA libraries are provisioned (B7 cleared). Re-confirmed 2026-08-20: `xvfb-run` and `google-chrome` present on the worker. |
| EQA-02 | `npm ci` produces a Linux Electron | The linux-x64 Electron binary installs on the box. | CODE-OK — npm resolves per-platform; verify, since the mirror carries a macOS-built `node_modules` if `.gitignore` ever slips |
| EQA-03 | Renderer QA end to end | A cloud member opens a conversation, clicks through a flow, screenshots, and reads computed styles over CDP. | SMALL-FIX — follows from EQA-01 |
| EQA-04 | The skill has a Linux path | `/electron-desktop-qa` currently prescribes macOS repair (`codesign`, `spctl`, `xattr`) and forbids macOS screenshots. On Linux it must prescribe `xvfb-run` and skip the Gatekeeper section. | SMALL-FIX — SKILL.md edit |
| EQA-05 | Preflight blocks honestly | A member asked for desktop QA on a worker without a display. | SMALL-FIX — the repo already models this with `unsupportedOnLinux` (`toolchainRequirements.ts:24`, used for `xcodebuild`); add the equivalent for Electron/desktop QA |
| EQA-06 | Escalation is answerable | The skill tells Codex to rerun with `sandbox_permissions: "require_escalated"`; remote runs are `approval_policy=never`. | REAL-WORK — either the skill's remote branch must not ask for escalation, or remote runs need an escalation path |
| EQA-07 | Disk headroom | Electron + `node_modules` + Xvfb adds roughly a gigabyte. | SMALL-FIX — folds into the 20 GB default in W-18 |
| EQA-08 | Scope is stated in the output | A cloud QA report says plainly that it validated the Linux build. | SMALL-FIX — report template; prevents a Linux PASS being read as macOS evidence |
| EQA-09 | macOS-only checks are refused, not faked | Ask a cloud member to verify signing, notarization, or the DMG. | SMALL-FIX — must refuse with the reason (B4), never simulate |
| EQA-10 | Screenshots are actually examined | The member looks at the PNG rather than asserting from source. | CODE-OK — Claude can read images; verify the file reaches the model |

---

## 4. SK — Skills available to a cloud member

Your ask: global skills should work in the cloud the way they work locally.

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| SK-01 | Repo-local skills work remotely | `.agents/skills/*` and `.claude/skills/*` resolve on the box. | CODE-OK — they ride inside the synced repo mirror |
| SK-02 | **User-global skills work remotely** | `~/.claude/skills` and `~/.agents/skills` are available to a cloud member exactly as to a local one. | **REAL-WORK (B5)** — nothing syncs them today. Needs a decision on scope (all skills? a chosen set?), a sync path with its own change detection, and a rule for skills that shell out to Mac-only tools |
| SK-03 | App-generated bridge skills work remotely | `accordagents-accord`, `accordagents-app-chat-request`, `accordagents-app-chat-reply` are present on the box. | REAL-WORK (B5 + B2) — they live in `~/.claude/skills` **and** they call tools the worker relay does not expose. Both must be fixed or a cloud member can never facilitate an accord |
| SK-04 | Skill invocability, not just discovery | A skill on the box is `invocable`, not `discovery-only`. | CODE-OK — capability depends on the run root matching the repo path (`userSkills.ts:468-487`); verify against the mirror path, which is not the local path |
| SK-05 | `/implementation-workflow` from a cloud member | Resolves and runs. | CODE-OK for a Codex member (it is in `.agents/skills`); **SMALL-FIX** for a Claude member, since there is no `.claude/skills/implementation-workflow` |
| SK-06 | Skills that shell out to Mac-only tools | A global skill calling `osascript`, `xcrun`, or `codesign`. | SMALL-FIX — must fail with a clear "not available on this worker" message, not a confusing shell error |
| SK-07 | Skill drift between Mac and worker | Edit a global skill locally, then run a cloud member. | REAL-WORK (B5) — whatever sync lands needs change detection, or a member will silently run an old skill |
| SK-08 | Secrets in global skills | A global skill containing a token or private path. | REAL-WORK — a sync path that ships `~/.claude` to EC2 needs an explicit exclusion policy and a user-visible statement of what is copied |

---

## 5. CR — Cloud run: Codex

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| CR-01 | Cold run | Phases in order: `preparing-worker` → `syncing-files` → `launching-session` → `waiting-for-response` → `processing-request` → `terminal`; final message complete. | CODE-OK |
| CR-02 | Warm session reuse | Second turn reuses the session; materially faster. | CODE-OK |
| CR-03 | Warm session expiry | Idle >30 min, then send. Relaunches cleanly. | CODE-OK |
| CR-04 | **Submit ack lost → no double execution** | Drop the reply to `submitTurn`. Exactly one process, one event stream, one final message. | REAL-WORK — the failure ladder ends in `launch()`, which bypasses the supervisor's runId dedup |
| CR-05 | Launch ack under slow boot | Does not fail on launch-ack (60 s window). | CODE-OK |
| CR-06 | Poll inside the completion window | Finishes `completed` with the final message, not a synthesized `failed`. | CODE-OK — fixed by `d761a7f`; regression-guard it |
| CR-07 | Resume in a non-git directory | Resumes after a desktop restart; argv has `--skip-git-repo-check` and no `--ephemeral`. | CODE-OK |
| CR-08 | Resume miss | Reply prefixed *"The previous Codex session could not be resumed…"*; session id cleared; turn completes. | CODE-OK |
| CR-09 | Startup reconnect beats `clearInterruptedRuns` | Quit mid-run, relaunch: reconnecting and polled, not cleared. | CODE-OK |
| CR-10 | Poll timeouts terminate | Worker unreachable mid-run → visible terminal or "unreachable" within a bounded time. | SMALL-FIX — `unknown` is deliberately non-terminal and has no defined UI representation |
| CR-11 | Max runtime deadline | SIGTERM→SIGKILL on the box; desktop marks `failed`; no orphan process. | CODE-OK |
| CR-12 | Read-only sandbox on stock 24.04 | `codex exec -s read-only` works via persisted `kernel.apparmor_restrict_unprivileged_userns=0`. **Negative:** the fix must never be `--dangerously-bypass-approvals-and-sandbox`. | CODE-OK |
| CR-13 | Per-machine auth | On-box `codex login --device-auth` coexists with a live Mac session; neither revokes the other. **Negative:** nothing ever copies `auth.json` to a worker. | CODE-OK |
| CR-14 | Device auth survives a blackout | URL printed, 30 s blackout, restore, complete in the browser: login still completes. | SMALL-FIX — `ServerAliveInterval=8/CountMax=3` tears down the quiet approval window (`cloudRunDoctor.ts:370`) |
| CR-15 | Device auth drop before output | Retries silently; does not invalidate a code already in use. | CODE-OK |
| CR-16 | stdin does not hang | `< /dev/null` present. | CODE-OK |
| CR-17 | Preflight on a lossy link | One dropped SSH must not fail the run before launch. | SMALL-FIX — preflight is the one setup SSH not wrapped in `runWithSshRetries` |
| CR-18 | Preflight cache invalidation | Install a missing tool via in-app setup; next run proceeds **without an app restart**. | SMALL-FIX — instance-lifetime cache with no invalidation |
| CR-19 | Advisory vs required | Required blocks with a named reason; advisory warns and proceeds. | CODE-OK |
| CR-20 | Run location lock | Confirm the lock after the first run is intended product behavior, not a trap. | CODE-OK |
| CR-21 | Attachments on a remote run | Behavior must be explicit and visible. Today images are silently skipped. | SMALL-FIX |
| CR-22 | Native `/goal` + remote | Rejected with the specific message. | CODE-OK |
| CR-23 | Multi-day detached run, desktop offline | >8 days: the box refreshes its own token and keeps working. **Never proven.** | REAL-WORK (soak) — the core of the lid-closed promise |
| CR-24 | Two remote members concurrently | Both run; distinct run ids; no cross-attribution; both finalize. | CODE-OK |
| CR-25 | `remoteCwd` points at the mirror repo | The agent runs inside the synced repo, not the run metadata dir. | CODE-OK — Drew fixed this; regression-guard it |
| CR-26 | Warm-session protocol upgrade | Bumping the protocol forces reinstall; generated worker code prefers `commandPath` over `codexPath`. | CODE-OK — protocol 4→5; regression-guard it |

---

## 6. CL — Cloud run: Claude

New on this branch. Nothing here is QA-proven beyond Drew's single live PASS, and CLAUDE.md's dedicated-CLI-parity invariant applies to the remote path exactly as to the local one.

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| CL-01 | Claude member can be set to remote | Toggle enabled and persisted. | CODE-OK |
| CL-02 | Cold run | Same phase sequence as CR-01; streaming renders as it does locally. | CODE-OK |
| CL-03 | Session resume | Resumes across a desktop restart; resume-miss surfaces like CR-08. | CODE-OK |
| CL-04 | Auth on the box | Per-machine login; no credential copying; refresh works with the desktop offline. | CODE-OK for login; REAL-WORK for the offline-refresh soak (same as CR-23) |
| CL-05 | Permission prompts | The `--permission-prompt-tool` bridge works across the relay, or the divergence is documented and visible per CLAUDE.md. | REAL-WORK — the worker relay exposes `app_permissions_request_change` but not `app_tool_permission` (`remoteRuns.ts:3348`) |
| CL-06 | Auto mode | Native classifier decides native actions; no second app gate. Cold, warm, and retry launches. | CODE-OK |
| CL-07 | Skills | Repo-local and **global** skills resolve; `/implementation-workflow` is invocable. | REAL-WORK (B5) for global; SMALL-FIX for the missing `.claude/skills/implementation-workflow` |
| CL-08 | Compaction | `/compact` completes and the context indicator moves; matches local behavior. | CODE-OK |
| CL-09 | Stop | Settles promptly; preserves an already-emitted final message. | CODE-OK |
| CL-10 | **Parity audit** | Same task run local vs remote, compared across streaming, approvals, permissions, sandboxing, errors, cancellation, compaction, skills, MCPs, user controls. Any mismatch is a bug. | REAL-WORK — this is the acceptance test for B1 and has not been run |

---

## 7. W — AWS worker: lifecycle, disk, access, billing

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| W-01 | First provision | Ubuntu 24.04 x86_64, gp3 root, `DeleteOnTermination`, tag `accordagents-worker=1`, SSH open to the caller's /32 only. | CODE-OK |
| W-02 | Public IP change | SSH ingress rebuilt after stop/start with no manual step. | CODE-OK |
| W-03 | Instance Connect fallback | Corrupt `authorized_keys` → repaired via `SendSSHPublicKey`. | CODE-OK |
| W-04 | **Low-MTU VPN** | Client at MTU 1280. Failure is diagnosed as a network/MTU condition with client-side guidance. "Turn the VPN off" is not an acceptable instruction. | REAL-WORK — the MSS/MTU clamp did **not** fix the observed case; residual cause was a lossy VPN↔AWS path |
| W-05 | Lossy link setup | 10–20 % loss: setup completes via retries, no manual retry. | SMALL-FIX |
| W-06 | Stale scoped IAM key | Recovery form names the failed operation; a refreshed blob retries; exactly one tagged worker remains; the key id is never echoed. | CODE-OK |
| W-07 | Delete an already-terminated worker | Idempotent; key pair and SG cleaned up. | CODE-OK |
| W-08 | Idle stop honors a live run | Worker-side drain gate denies the stop; the run survives. | CODE-OK |
| W-09 | Idle stop with lease renewal failing | Run not silently killed; no stop with live work; the lease expires rather than pinning the box up forever. | SMALL-FIX |
| W-10 | **`authorize-stop` retry is idempotent** | A retry after a lost reply is recognized as the same request — no orphan drain lease bouncing real turns for 30 s and skipping idle-stop. | SMALL-FIX |
| W-11 | **App closed with a run in flight** | Defined behavior. The idle timer currently dies with the Electron process; on relaunch it must be re-scheduled and must not stop an in-flight run. | REAL-WORK — the timer must not live only in the desktop |
| W-12 | Phone paired → box stays up | Idle-stop holds a reference while the phone is paired or ownership is remote. | CODE-OK — verify against `hostProviderCapabilities.ts` |
| W-13 | Spec mismatch decision | `keep` / `grow-disk` / `recreate` with staleness checks; no silent resize. | CODE-OK |
| W-14 | Disk exhaustion message | rsync ENOSPC → the actionable message, not a raw rsync error. | CODE-OK — confirmed live |
| W-15 | **Desired vs Actual disk** | Settings shows both, warns when a change is unapplied, `Refresh status` only refreshes, and the primary CTA is `Apply disk resize to 20 GB`. | CODE-OK — Drew implemented; unverified end to end |
| W-16 | **Resize preserves data** | Growing the EBS root in place keeps `~/.accordagents`, mirrors, and auth dirs. Only `Recreate` loses them. | CODE-OK — must be QA'd, this is a data-loss-adjacent path |
| W-17 | **Filesystem grow finalization** | EC2 reports 16 GB but `growpart`/`resize2fs` verification exits 3. Retry must resume the filesystem step, not recreate the worker. | SMALL-FIX — observed live 2026-08-14 |
| W-18 | **Default disk size** | A fresh worker holds the base OS (~6 GB: `/usr` 4.0 G, `/var` 1.5 G) plus this repo's ~1.2 GB mirror plus a 512 MB buffer, plus Chromium/Electron for BQA/EQA. | SMALL-FIX — 8 GB is provably too small; 20 GB recommended |
| W-19 | Reclaimable worker space | ~1 GB sits in apt cache and the systemd journal. | SMALL-FIX — periodic reclaim, or provision with smaller caches |
| W-20 | Mirror storage growth | Growth is observable and reclaimable. | SMALL-FIX — `reclaimWorkerMirrorStorage` exists but has no UI path |
| W-21 | More than one tagged worker | Clear error naming both. | CODE-OK |
| W-22 | Cost visibility | The user can see what is running and what it costs; stopped instances still bill EBS. | REAL-WORK |
| W-23 | **A full worker disk must say so** | When the worker's filesystem is full, the run must fail with "no space left on the worker" and what to do about it. Today it surfaces as `Remote worker process exited without writing exit.json` — the worker cannot write its own terminal marker, so the desktop reports the symptom and the user has no way to reach the cause. W-14 covers ENOSPC during rsync; this is ENOSPC during the run itself, which is a different path. | **REAL-WORK — observed live 2026-08-20**: a cloud member's turn failed at 20:12:50 with the exit.json message; the box was at 15G/15G with 4 MB free and a zero-byte `state.json.tmp` in the run directory. |
| W-24 | **Disk fills from accumulated leftovers, not from one run** | Repeated cloud work leaves per-run context snapshots, abandoned worktrees with their own `node_modules`, npm caches, and old QA checkouts. Something must reclaim them, or the box wedges again on a schedule nobody is watching. | **REAL-WORK — measured 2026-08-20** on a 16 GB box: old QA checkout 2.8 G, two agent worktrees in `/tmp` 1.2 G + 264 M, run dirs and mirrors 3.0 G, npm cache 432 M. Volume grown to 40 GB as a stopgap; nothing reclaims automatically. |

---

## 8. S — Project mirror / sync

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| S-01 | **Second turn with no local changes skips sync** | The second turn skips the up-sync and says so. | CODE-OK — fixed by `6c43e35`; this was your explicit complaint, so verify it directly |
| S-02 | Progress is aggregate and monotonic | Correct on macOS `openrsync` (protocol 29) and on rsync ≥3.1; reaches 100 % and clears. | CODE-OK |
| S-03 | **Remote drift is detected** | Delete or modify the remote mirror out-of-band → next turn re-syncs rather than skipping. | REAL-WORK — the skip trusts only the local fingerprint |
| S-04 | Fingerprint survives an IP change | Run → idle-stop → start (new IP) → run: still skipped, no per-IP state growth. | SMALL-FIX — fingerprint is keyed on `worker.host` |
| S-05 | Index-only change | `git reset --soft HEAD~1` with no working-tree change reaches the box. | SMALL-FIX — `.git/index` is excluded from the fingerprint but included in the payload |
| S-06 | Nested `build`/`dist` that is real source | A tracked `src/build/` file reaches the box and triggers a sync. | SMALL-FIX — excludes are bare-basename at every depth |
| S-07 | Same-size edit, unchanged mtime | The change still reaches the box. | SMALL-FIX |
| S-08 | Locale-independent fingerprint | Two `LC_ALL` values, unchanged tree, same digest. | SMALL-FIX — `String.localeCompare` ordering |
| S-09 | **Box-side commit is not destroyed** | An unpushed commit on the box survives a resync, or the user is warned. | REAL-WORK — `rsync --delete` with `.git` not excluded |
| S-10 | **No auto down-sync, ever** | No code path writes the local project tree during or after a remote run. | CODE-OK — locked user decision; permanent regression guard |
| S-11 | Sync progress cost | Bounded sqlite spawns; per-percent progress must not re-read the whole spool. | SMALL-FIX |
| S-12 | Concurrent runs on one mirror | Operations serialize; no half-synced tree. | CODE-OK |

---

## 9. P — PWA control plane

### 9.1 Pairing and identity

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| P-01 | QR pairing | Paired; chat list loads; survives app restart and phone reboot. | CODE-OK |
| P-02 | Install to home screen | Standalone launch works; pairing survives; Web Push offered only after install. | CODE-OK |
| P-03 | **Stable URL** | `https://mobile.accordagents.com/` keeps working for one desktop profile. Breaks only on profile reset, pairing revoke, relay/domain change, or reinstall as a different profile. | CODE-OK — you asked this directly; worth an explicit regression test |
| P-04 | Pairing secret hygiene | No long-lived unrotatable bearer token in a URL; rendezvous id and stable routing id are separate. | CODE-OK |
| P-05 | Second phone | Both work; each separately revocable; the desktop lists paired devices. | CODE-OK |
| P-06 | Unpair / revoke | Access lost immediately; a queued outbox on the revoked phone never later flushes. | SMALL-FIX |
| P-07 | Empty or missing token | Denied. A check that returns `true` for an empty token is a security failure. | SMALL-FIX |
| P-08 | Relay holds no plaintext | Only sealed ciphertext transits; relay history is never a durability path. | CODE-OK |

### 9.2 Reading and sending

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| P-10 | Chat list | All chats visible, not only those with a prior cloud run. | CODE-OK |
| P-11 | Timeline fidelity | Tool calls, code blocks, diffs, and progress are legible; identity and avatars correct. | VERIFIED for identity — stand scenario 7 + live pass 2026-08-19. The identity half was **failing**: a row published before routing had picked anyone showed an "Agent" handle and a letter avatar, then swapped to the real member mid-run. Rich-transcript legibility is still only CODE-OK. |
| P-12 | Live update without manual refresh | The timeline updates while a cloud member produces output. | VERIFIED — stand scenarios 1–12. Was broken outright until the phone set `binaryType = "arraybuffer"`: browsers deliver binary frames as a `Blob`, and every live frame was silently dropped. |
| P-13 | Resume from background | Refreshes on resume after 5 min backgrounded. | PARTLY VERIFIED — stand scenario 12 proves a turn finishing with **no relay at all** resolves through the mailbox and clears its row, and a live device pass on 2026-08-19 confirmed a ~1 minute background. The stated 5 minute case is still unverified on a device. |
| P-14 | Send to a cloud member, lid closed | Member runs on the box; the reply appears on the phone. | CODE-OK — Drew reports one live PASS |
| P-15 | **Send to a local-only member** | The phone says `waiting for desktop` **at compose time** and queues. Never a silent failure or a false "sent". | CODE-OK |
| P-16 | Queue drains on desktop wake | Runs exactly once; no duplicate. | CODE-OK |
| P-17 | Offline send | Airplane mode → send → app restart → network back: visibly queued throughout, flushes once with the same event id. | CODE-OK |
| P-18 | Cold load with everything unreachable | The installed PWA renders its cached projection. | CODE-OK — verify the service worker actually caches the shell |
| P-19 | Duplicate replay | Cursor dedupe; no duplicates. | VERIFIED — stand scenarios 4 and 10 assert every answer appears exactly once across sequential and overlapping turns. Note the render layer had its own duplicate: two DOM nodes under one row key survived the stale-row sweep forever, showing text the store no longer held. |
| P-20 | Oversize message | Chunking and reassembly work; no truncation, no `1009` close killing the session. | CODE-OK |

### 9.3 Missing control surfaces

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| P-30 | **Approve a permission from the phone** | The request shows with enough context to decide; allow-once / allow-for-chat / deny; the decision reaches the box and resumes the run. | REAL-WORK (B3) |
| P-31 | **Answer a user choice from the phone** | The card renders with all options, the recommendation, and a free-text option; answering resumes the requester. | REAL-WORK (B3) |
| P-32 | **Stop a run from the phone** | Available and settles. | REAL-WORK (B3) |
| P-33 | View and sign an artifact from the phone | Readable; signable when the User is a required signer. | REAL-WORK (B3) |
| P-34 | Start a chat / add a participant from the phone | Defined behavior, even if it is "not supported, and it says so." | REAL-WORK (B3) |
| P-35 | Attachments | Send or view an image. Silent drop is a failure. | REAL-WORK (B3) |

### 9.4 Conflict and ownership

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| P-40 | **Approval conflict** | Phone and desktop answer the same approval within a second, one Approve one Deny: exactly one reaches the worker; the loser is a visible rejected-conflict showing which won. Ranked **above** message loss — the failure is "a tool ran after the User denied it." | REAL-WORK (B3) |
| P-41 | **Forked participant session** | Phone triggers a cloud turn while the laptop has a queued local turn for the same member: one session, not two. Lease generation fencing rejects the loser before any executor-owned write. | CODE-OK — `chatExecutionLeases.ts` exists; unverified live |
| P-42 | Desktop write while the worker owns the conversation | Blocked with a clear banner and a working reclaim path. | SMALL-FIX — `force_reclaim_required` is a label with no handler |
| P-43 | Two desktop windows | No lost updates; Stop works from either. | CODE-OK |
| P-44 | Rollback to an older build | Refuses cleanly rather than corrupting. | SMALL-FIX — no schema version floor exists |
| P-45 | Inactivity semantics | 11 min of heartbeats only → flagged inactive. 30 min awaiting approval → surfaced as *awaiting approval*, not inactive. | CODE-OK — `remoteRunStall.ts` |
| P-46 | Push triggers | Approval pending / terminal / stall each fire once, dedupe, redact secrets, pad to fixed buckets. Tapping the notification **opens and focuses** the PWA. | SMALL-FIX — no `notificationclick` handler |
| P-47 | Push subscription expiry | HTTP 410 removes the subscription and the user is told notifications stopped. | SMALL-FIX |

### 9.5 Timeline row lifecycle

The section this list did not have, and the one that produced every defect the
User actually hit from her phone. Reading and sending were covered; what a row
*does* between the send and the answer was not covered at all, and five separate
defects lived there.

All twelve run against the real publisher, a real relay and mailbox, and the
built PWA in a real browser that sends by typing into its own composer:
`scripts/mobile-e2e-phone-turn.test.mjs`, wired as `npm run test:mobile-e2e`.
Every one was proven red on the build before its fix — a scenario that passes
both ways proves nothing, and one of these silently did until its message was
made realistically tall.

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| P-50 | Phone-sent turn, no mention | The in-progress row becomes the answer and does not survive it. | VERIFIED — stand 1 + live pass 2026-08-19. Was broken: the answer runs under a fan-out run id the phone never saw, and reconciliation demanded that id **and** the mobile event id, so the row never cleared. |
| P-51 | Phone-sent turn with `@mention` | Same, on the branch that names a member up front. | VERIFIED — stand 2 |
| P-52 | App killed mid-answer | After relaunch the row reaches the answer instead of hanging in "Thinking". | VERIFIED — stand 3 + live pass |
| P-53 | Repeated turns | No accumulation; every answer appears exactly once. | VERIFIED — stand 4 |
| P-54 | Tapping a finished row | Never opens a previous answer. | VERIFIED — stand 5. Was broken: a stale row's mobile event id matched an older answer, so tapping it opened that. |
| P-55 | Two members answering one phone message | The first to finish leaves the other still writing. | VERIFIED — stand 6. This is the regression the other direction: an over-broad clear would delete a live row. |
| P-56 | Nobody picked yet | The row names nobody: a small pulsing indication, no avatar, no handle, no clock, no words, nothing to tap. Reduced motion stills it. | VERIFIED — stand 7 + live pass. Scaffolding that **does** name a member keeps the member row, the shimmer and the clock — that is real information and matches the desktop. |
| P-57 | Multi-message turn | A member posting an intermediate message and carrying on shows one live row throughout, and the note does not end the turn. | VERIFIED — stand 8 + live pass. Was broken twice over: the row key collapsed both messages into one, and a finished message ended every pending row of its run. |
| P-58 | Following and parking | A reader at the end is carried along by arriving rows; a reader who scrolled into history does not move by a pixel and is offered the way back. | VERIFIED — stand 9 + live pass |
| P-59 | Overlapping turns | Two phone messages in flight with interleaved terminals: both clear, neither cross-clears the other. | VERIFIED — stand 10 + live pass |
| P-60 | A run that fails | The failure is stated once and the row ends. | VERIFIED — stand 11. Was broken: a dead run has no terminal of its own, and the one written on its behalf matched no row, so "Thinking" stood over a dead run forever. |
| P-61 | Finish with no relay | A turn resolving through the mailbox alone still clears its row — the phone's normal state, since iOS backgrounds the socket. | VERIFIED — stand 12 + live pass |

---

## 10. PM — Permissions and approvals

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| PM-01 | Claude allow-once | Card shows the tool with enough context; permits exactly that occurrence. | CODE-OK |
| PM-02 | Claude allow-for-chat | Policy stored per participant+role+tool; next identical call auto-allowed; a system message records the grant. | CODE-OK |
| PM-03 | **Claude Auto: prompt exists** | A prompt appears. Regression-guard both directions — Auto once shipped to beta with prompts entirely missing. | CODE-OK |
| PM-04 | **Claude Auto: no chat-wide scope** | Allow-once and deny only, in UI and backend. | CODE-OK |
| PM-05 | **Auto mode equals native CLI** | Artifact create → draft save with readers → submit; edit a file outside the chat directory; read a user skill; edit a repo-local `.claude/skill`; web research. Cold, warm, and retry launches. No second app gate; server ACLs still enforced. | CODE-OK |
| PM-06 | Per-occurrence dedupe | Retried bridge delivery for one `tool_use_id` → exactly one card; different occurrence ids stay distinct. | CODE-OK |
| PM-07 | Timeout | 30 min unanswered → denied with `source: timeout`, card flips, system note explains. | CODE-OK |
| PM-08 | Cancel mid-approval | Card resolves as cancelled; run does not hang; tool call denied. | CODE-OK |
| PM-09 | Stale / duplicate decision | *"already been answered"*; exactly one extra attempt. | CODE-OK |
| PM-10 | Fast answer race | Answering before the waiter registers still settles. | CODE-OK |
| PM-11 | Codex command approval options | Exactly the advertised `availableDecisions`; installed union only as fallback; duplicates fail closed. | CODE-OK |
| PM-12 | Codex file-change approval | accept / acceptForSession / decline / cancel; patch contents not leaked to logs. | CODE-OK |
| PM-13 | Codex approval resumes the turn | *"Auto-reviewing approval request"* must never appear and then stall forever. | CODE-OK |
| PM-14 | Delivery failure | Provider disconnect at the click → the card shows the authoritative outcome, never a false "approved". | CODE-OK |
| PM-15 | Guardian denied override | One bounded card with approve-one-retry and keep-denied; a re-denying continuation produces **no** successor Approve card and exactly one continuation run. | CODE-OK |
| PM-16 | Guardian timed out | Terminal, non-actionable. | CODE-OK |
| PM-17 | Guardian event mapping | The internally-tagged `guardian_assessment` constant is mapped; assert an override actually takes effect, since a missed mapping is indistinguishable from "keep denied". | CODE-OK |
| PM-18 | Cross-connection id collision | No cross-routing; thread and turn correlation rejects mismatches. | CODE-OK |
| PM-19 | `codex exec` advertises `never` | `approval_policy=never` wherever the runtime cannot answer approvals. | CODE-OK |
| PM-20 | Gemini/agy permissions | The print-mode divergence is explicit and visible; a native `/goal` PTY dialog fails with a specific message, not a hang. | CODE-OK |
| PM-21 | Portable permission escalation | Stable `requestId` replays idempotently; `already_granted` when nothing is added; allow-once overlay consumed after exactly one projection. | CODE-OK |
| PM-22 | Auto-resume after approval | Exactly one resume; duplicates blocked; waits behind an in-flight same-participant turn; no `resumeContext` → no auto-run. | CODE-OK |
| PM-23 | Stale approval for a removed member | Fails closed with a clear message. | CODE-OK |
| PM-24 | Classifier unavailable | *"cannot determine the safety of Bash right now"* degrades to a clear retryable message; read-only work continues; must not look like a denial. | CODE-OK |
| PM-25 | Attachment read denied | The tool message keeps its image, warns cleanly, creates no batch. | CODE-OK |
| PM-26 | Card isolation | An unrelated choice card beside a pending approval: each control affects only its own card; finished outcomes stay compact. | CODE-OK |
| PM-27 | Survives app relaunch | Still answerable, or terminal with a stated reason. | CODE-OK |
| PM-28 | Remote permission before a session id | Fails with the specific message rather than hanging. | CODE-OK |
| PM-29 | **Remote permission round trip end to end** | A cloud member requests a permission, the decision is written to `decisions.jsonl` over SSH, and the run resumes. | CODE-OK — the one approval path the worker relay does support; verify with the lid closed |

---

## 11. UC — User choices

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| UC-01 | Basic card | Title, question, options, descriptions, Recommended chip, free-text option. | CODE-OK |
| UC-02 | Selecting resumes the requester | Hidden user message threaded under the source; same requester continues. | CODE-OK |
| UC-03 | Custom answer | Delivered; empty text rejected clearly. | CODE-OK |
| UC-04 | Note on a picked option | Reaches the requester. | CODE-OK |
| UC-05 | `≠ recommendation` | Divergence chip shows; the actual selection is delivered. | CODE-OK |
| UC-06 | Cancel | No run starts. | CODE-OK |
| UC-07 | Double submit | Second rejected; exactly one continuation. | CODE-OK |
| UC-08 | **Prose answer instead of clicking** | Today the card stays pending forever and clicking it later injects a **second** continuation turn. | SMALL-FIX — needs a defined resolution rule |
| UC-09 | Malformed block | Fewer than two options, or no question and no title → prose, no card, no error spam. | CODE-OK |
| UC-10 | Code-fenced block | Not parsed as a card. | CODE-OK |
| UC-11 | Bare list options | Auto-numbered correctly. | CODE-OK |
| UC-12 | Concurrent snapshot merge | A stale clone cannot revert an answered choice. | CODE-OK |
| UC-13 | Choice from a remote member | Renders and routes back through the remote replay path. | CODE-OK |
| UC-14 | Main-timeline visibility | A hidden card is never the sole unblock; the main timeline carries the question and the five idle-status fields. | CODE-OK |

---

## 12. T — AccordAgents app tools

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| T-01 | Read tools | Context, participants, activity, request status, read messages, list/read attachments — each correctly scoped; bounds and limits honored. | CODE-OK |
| T-02 | `app_chat_send_message` | Per-run cap enforced clearly; attachments 1–5 PNG/JPEG/WebP within the byte cap. | CODE-OK |
| T-03 | `app_chat_export_attachment` | In-repo export succeeds; absolute path, `..`, symlink, directory, and no-overwrite all rejected. Deliberately not auto-preauthorized. | CODE-OK |
| T-04 | `app_chat_react` | Emoji allowlist enforced. | CODE-OK |
| T-05 | `app_chat_set_title` | First eligible turn applies; later calls ignored — confirm that is intended and visible. | CODE-OK |
| T-06 | `app_chat_request_compaction` | Cooldown and duplicate checks fire clearly. | CODE-OK |
| T-07 | Compaction actually compacts | The context percentage increases. Codex completes via `turn/completed`; Claude must run one-shot or the usage read is the stale pre-compact figure. | CODE-OK |
| T-08 | Roles / participants / roster change | `auto_applied` with `allow` and no escalation; otherwise `pending_user_approval`. | CODE-OK |
| T-09 | Capability gating | A member without the capability does not even see the tool. | CODE-OK |
| T-10 | Pre-auth list is registry-derived | Adding a new `app_*` tool updates the pre-auth set without a second edit. | SMALL-FIX |
| T-11 | Artifact create — published | Created; `#artifact:<id>` resolves. | CODE-OK |
| T-12 | Artifact create — collecting drafts | Roster, per-author audience policy, stable `operationId`; content/note/requiredSigners rejected while collecting. | CODE-OK |
| T-13 | Draft confidentiality | Unreadable editing drafts hidden entirely; unreadable submitted drafts expose metadata only. Assert actual `effectiveReaders`, not policy intent. | CODE-OK |
| T-14 | Draft optimistic concurrency | Stale `expectedEditRevision` → `stale_version`; no silent overwrite. | CODE-OK |
| T-15 | Publish gates | Missing required draft, empty sources, duplicate `draftId`, excluded without rationale, source replaced post-snapshot — each rejected specifically. Publishing creates no signatures. | CODE-OK |
| T-16 | Signing and approval | Only `requiredSigners` can sign; `approved` needs every required signer on the current head, by identity. | CODE-OK |
| T-17 | Revise resets approval | New version unsigned; history preserved; fresh sign round forced. | CODE-OK |
| T-18 | Concurrent revise | One accepted; the other gets `stale_version` with current content; guard holds across processes. | CODE-OK |
| T-19 | Rename | Identity preserved; `#artifact:<id>` still resolves; freed names reusable and non-redirecting. | CODE-OK |
| T-20 | **Archived is read-only** | Revise / sign / saveDraft / submitDraft / setAccess / publish all fail from **both** UI and MCP. | CODE-OK |
| T-21 | Access management | Owner or User only; a post-publish signer change has a working path. | SMALL-FIX — the UI surface was removed |
| T-22 | Operation idempotency | Same `operationId` + same payload → durable original response; different payload → explicit error. | CODE-OK |
| T-23 | Long documents go to artifacts | Chat and request bodies carry only the pointer; the counterparty is added as a contributor when they must edit. | CODE-OK |
| T-24 | Participant request limits | Depth, chain batches, per-turn, per-minute, self-target, unknown handle, duplicates, 50 001-char prompt — each its own error. Prompts over the cap are rejected, not truncated. | CODE-OK |
| T-25 | Request gating by permission | `deny` → hard error; `ask` → one card, no runner started; `allow` → immediate. Inferred requests forced to allow-once. | CODE-OK |
| T-26 | Resume does not duplicate | Interrupt mid-draft-submit and resume → one draft, one batch; all skip reasons logged. | CODE-OK |
| T-27 | **Mentions in a list after a blank line** | `Participant requests:` / `- @a` / blank / `- @b` → both picked up. A blank line is a paragraph terminator, not a body terminator. | CODE-OK — this exact regression silently dropped every such mention |
| T-28 | Mention negative matrix | Backticks, fenced block, `>` quote, self-only, none → zero batches. Tool post plus final output restating the handle → exactly one. | CODE-OK |
| T-29 | Inferred request failures are visible | Either a request is created or a user-visible error appears — never a debug-log-only failure. | SMALL-FIX |
| T-30 | **Remote member tool surface** | From a remote run, calling `app_chat_send_message` / `app_artifact_create` / `app_chat_request_participants` must fail **visibly in chat with a clear reason**. | SMALL-FIX for the honest error; **REAL-WORK (B2)** to actually support them |

---

## 13. AC — Accord between two cloud members, from mobile

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| AC-01 | Trigger an accord from the phone | Facilitator starts, proposes members, pauses for the User's selection card — answerable from the phone. | REAL-WORK (B2 + B3 + B5) |
| AC-02 | Member selection card | Reaches the phone; the facilitator stops the turn and never requests participants before approval. | REAL-WORK (B3) |
| AC-03 | Facilitator drafts first | Submits its own draft before requesting anyone. | REAL-WORK (B2) |
| AC-04 | Blind drafts between cloud members | Exactly one explicit reader each; peers cannot read each other. Assert actual `effectiveReaders`. | REAL-WORK (B2) |
| AC-05 | Chat carries no draft content | The timeline says "submitted" and nothing more. | REAL-WORK (B2) |
| AC-06 | Stable operation ids on resume | Interrupt and resume: no second artifact, no duplicate draft. | REAL-WORK (B2) |
| AC-07 | Dispositions are visible | v1 carries raised-by / concern / disposition / reasoning / impact; no version is signed with an unresolved objection. | REAL-WORK (B2) |
| AC-08 | Sign round | `approved` only when `signedCurrent` covers the facilitator and every selected member by identity. | REAL-WORK (B2) |
| AC-09 | Disputed disposition | Exactly one focused follow-up, then sign / revise / ask User / *Consensus: not reached*. Never loop the same item twice. | REAL-WORK (B2) |
| AC-10 | Revise mid-accord | New version unsigned; full fresh sign round. | CODE-OK (local members) |
| AC-11 | Membership change mid-accord | User approval → revise → set access → verify unsigned → focused assessment → full sign round. | REAL-WORK (B2) |
| AC-12 | Termination output | `Consensus: approved by …on [the resolution](#artifact:ID).` — link only, never the body. | REAL-WORK (B2) |
| AC-13 | No `@handle` in accord messages | None present — a plain handle can trigger an unintended extra run. | CODE-OK |
| AC-14 | Rate limits | >4 targets or >8 requests/min → clear errors. | CODE-OK |
| AC-15 | Local-member fallback, lid closed | Members queue as `waiting for desktop`, the phone says so, and the accord resumes on wake without duplicating drafts. | CODE-OK |

---

## 14. AW — Workflow manager auto-watch

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| AW-01 | Role defaults are forced | Auto-watch and the two permissions snap back if edited. | CODE-OK |
| AW-02 | Triggers fire | participant-added, toggle-on, remote-run-terminal, user-message, participant-output — all debounced. | CODE-OK |
| AW-03 | **Wake-limit pause is escapable** | Visible with a reason; a new user message resets depth; the un-pause path is not "toggle the switch off and on." | SMALL-FIX |
| AW-04 | Error pause | Visible and recoverable; `chat.auto-watch.run.error` logged. | SMALL-FIX |
| AW-05 | Every gate is attributable | Break each gate in turn; each emits a diagnosable event. | SMALL-FIX |
| AW-06 | Direct mention does not double-fire | Neither double-handled nor skipped. | CODE-OK |
| AW-07 | Watcher ignores its own output | No self-trigger loop. | CODE-OK |
| AW-08 | Handled request replies excluded | Not re-triggered. | CODE-OK |
| AW-09 | Single-watcher invariant | Second watcher blocked with a clear message. | CODE-OK |
| AW-10 | **Fires on a remote run's terminal** | The watcher wakes from the remote replay path with the lid closed. This is the whole point of auto-watch for cloud work. | CODE-OK |
| AW-11 | Triage honesty | Checks real status (`pending_approval` / `running`), never believes prose like "I'm continuing", and never leaves a passive waiting status when no work is active. | CODE-OK |
| AW-12 | Idle status completeness | All five required fields; names the exact User decision. | CODE-OK |
| AW-13 | No loops | The chain terminates; the batch cap holds. | CODE-OK |

---

## 15. E2E — Small task from the phone to a real beta release

Pick a genuinely small, user-visible task with one regression criterion. The point is the pipeline, not the diff.

| Step | Gate | Status |
|---|---|---|
| E2E-01 | Phone message, lid closed, reaches the Workflow Manager and it runs. | REAL-WORK (B2) if the manager is a cloud member; CODE-OK if the manager is local |
| E2E-02 | `/implementation-workflow` resolves and is invocable. | CODE-OK for a local Codex manager; SMALL-FIX for Claude (no `.claude/skills` copy); REAL-WORK (B5) for a cloud manager |
| E2E-03 | Participant preflight adds both engineers with no substitutions and re-reads the roster. | REAL-WORK (B2) from cloud |
| E2E-04 | `Confirm Scope` and `Confirm Acceptance Criteria` cards reach the phone and are answerable there; criteria are User-owned, locked, and include regression criteria. | REAL-WORK (B3) |
| E2E-05 | `Final Step` card on the main timeline; User selects *Make a release*. | REAL-WORK (B3) |
| E2E-06 | Plan assignment posted between the delimiters; both engineers reply Done; the manager stops. | CODE-OK |
| E2E-07 | Plan accord produces a signed plan artifact. | REAL-WORK (B2) between cloud members; CODE-OK locally |
| E2E-08 | Implementation in a separate worktree with live acceptance QA. Mocks, fixtures, unit tests, typecheck, and builds are supporting evidence, never acceptance evidence. Network disconnect and worker stop forced live. Gate: focused tests + `make typecheck` + targeted tests + `make build` + an all-PASS evidence table. | CODE-OK locally; SMALL-FIX from cloud once BQA/EQA land |
| E2E-09 | Review and a signed required-fix artifact. | REAL-WORK (B2) from cloud |
| E2E-10 | Fixes with refreshed evidence; final review of the **full diff**, auditing the evidence table. | CODE-OK |
| E2E-11 | The manager re-reads the evidence table before the final step. | CODE-OK |
| E2E-12 | **Beta release on the desktop.** Clean remote main, `verify-release.mjs environment` before `npm ci`, `npm ci` in a clean clone, preflight, typecheck, build, package, `verify-release.mjs packaged`, isolated-profile launch with CDP smoke. | CODE-OK — desktop-only by construction (B4) |
| E2E-13 | **Failure after the version push.** Force notarization to fail: the script must either not push bump+tag first, or roll back cleanly and be resumable. | REAL-WORK — the bump and tag are pushed **before** the build; this has already burned two orphan versions |
| E2E-14 | Verify the published artifact: download the ZIP with `gh`, expand, `verify-release.mjs packaged`, codesign + notarization + stapling on app and DMG, relaunch with a fresh profile, confirm the update endpoint serves the same version and URL. | CODE-OK |
| E2E-15 | Endpoint not yet indexed → *"not indexed yet, retry"*, not a crash on `.json()`. | SMALL-FIX |
| E2E-16 | Beta→stable convergence: a beta user is not stranded when stable ships. | REAL-WORK — a product decision, not just a fix |
| E2E-17 | Main-timeline closeout: outcome/artifact, summary, verification, implicit decisions, residual risk. | CODE-OK |
| E2E-18 | **The whole flow from the phone**, lid closed except for the release step. | REAL-WORK (B2 + B3 + B5) — the actual acceptance test for the track |

---

## 16. X — Cross-cutting

| ID | Scenario | Must be true | Status |
|---|---|---|---|
| X-01 | Cross-instance Stop | A second instance on the same userData cancels within ≤15 s. | CODE-OK |
| X-02 | Stop in the registration window | Between run-active and controller registration the request stays queued and is honored. | CODE-OK |
| X-03 | Stop with a surviving grandchild | Settles promptly; `releaseStdio` destroys the pipes so `close` fires. | CODE-OK |
| X-04 | Stop preserves a final message | Already-emitted content is not overwritten. | CODE-OK |
| X-05 | Stop with the worker unreachable | UI reaches cancelled locally and reconciles with zero orphans. | SMALL-FIX — worker cancel is fire-and-forget; assert nothing keeps burning instance time invisibly |
| X-06 | Cancelled activity | Pending cards cancel and move to finished. | CODE-OK |
| X-07 | Large chat load | ~14 000 rows: bounded time, zero missing/extra/invalid/duplicate rows. | CODE-OK |
| X-08 | One corrupt chat does not take down Activity | Every other chat still renders; the bad one is flagged. | CODE-OK |
| X-09 | Schema version floor | A DB written by a newer build is refused cleanly. | SMALL-FIX — nothing enforces a floor |
| X-10 | Write concurrency | Two runs finishing together: no lost update. Measure it — WAL is not enabled, so writers block readers. | SMALL-FIX |
| X-11 | Migration idempotency | Any repair that has produced an emergency `.bak` is idempotent and rollback-tested. | REAL-WORK — two real repair incidents in two days |
| X-12 | Provider selection fallback | Never a silent fallback: a persistent banner names the provider, links to settings, blocks chat creation, and preserves the draft. | CODE-OK |
| X-13 | Transient readiness flap | One transient failure does not block a send. | CODE-OK |
| X-14 | Readiness panel per platform | Every (platform × status) pair yields an actionable command with a Copy button where one exists. | SMALL-FIX |
| X-15 | Unknown model id | The context indicator still renders via a family fallback instead of disappearing. | SMALL-FIX |
| X-16 | Expanded command output stays open | Survives the streaming→finished transition. | CODE-OK |
| X-17 | Activity badge matrix | running / finished / cancelled × read / unread × rail badge × detail pane, plus rapid switching: no flicker, no race, no stuck unread. | CODE-OK |
| X-18 | Avatar contract | `test:avatar-contract` plus a CDP disc/radius sweep. Never add per-kind or per-context padding or disc overrides. | CODE-OK |
| X-19 | Occluded-window open | Opening a conversation while the window is occluded still loads. | SMALL-FIX — user-facing, same root cause as harness rule E-03 |
| X-20 | Warning sanitization | Raw CLI event JSON collapses to a one-line notice; no raw JSON in the timeline. | CODE-OK |
| X-21 | **GitHub push auth on the worker** | A cloud member can open a PR from the box. | **VERIFIED 2026-08-15, four times.** PRs #11 and #13 (Claude), #12 and #14 (Codex) on `juliakrivchikova/AccordAgents-desktop-app`, branches `qa/{claude,codex}-cloud-run-{proof,explicit-worktree}-*`. #13's own body: "E2E proof that @claude ran on the AWS cloud worker from the shared project mirror and created its own Git worktree for isolation." The "needs an explicit credential decision" text was written before this and never updated — `GH_TOKEN`/`GITHUB_TOKEN` are the only forwarded secrets (`remoteRuns.ts:96`) and a `githubApp` permission request kind exists for scoped grants. **This also settles how work gets home from the box: branch, then PR.** |

---

## 17. Suggested order

1. **Harness (E-01…E-09).** Nothing below is trustworthy without it.
2. **Everything marked `CODE-OK` in CR, W, S.** This is the cheapest way to find out how much of the reading is wrong, and it covers your two live complaints — repeated slow sync (S-01) and worker disk (W-15…W-19).
3. **CL-10, the Claude parity audit.** B1 just cleared on one live PASS; the parity invariant deserves a real audit before it is treated as done.
4. **BQA + EQA + SK.** Roughly three days of `SMALL-FIX` work unlocks autonomous browser and Linux-Electron QA. SK-02 is the exception — global-skill sync is `REAL-WORK` and needs a scope and secrets decision first.
5. **B2 — the worker tool surface.** The single highest-leverage item: it blocks every accord case, most of the E2E flow, and screenshot-back-to-chat.
6. **B3 — phone approvals and choices.** Required before "lid closed" is honestly true.
7. **X, continuously.** These are the regression guards.
