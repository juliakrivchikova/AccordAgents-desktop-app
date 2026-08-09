# Windows compatibility matrix

This document is the NIC-403 baseline for the AccordAgents Windows port. It records what is already portable, what is blocked on Windows, what is intentionally macOS-only, and what still needs installed-app evidence.

Baseline source revision: upstream `main` at `0d4ef2cf660227de57e817d5ddd490622e408c43`.

Target product environment: Windows 11 x64. Automated clean-host evidence comes from GitHub Actions `windows-latest` (Windows Server 2025 at the time of this baseline) with Node.js 20. It is portability evidence, not Windows 11 acceptance.

## Failure classification

Every Windows failure belongs to one of these categories:

- **Pre-existing upstream failure**: reproducible from the current upstream source and not caused by Windows-specific behavior.
- **Windows portability blocker**: product or runtime behavior that must change for supported Windows execution.
- **Expected macOS-only behavior**: intentionally unavailable on Windows for the current milestone.
- **Unrelated test/environment issue**: the test host or dependency installation prevents the intended behavior from being exercised.

The Windows workflow uses `continue-on-error` only so later checks still run and produce evidence. Its final enforcement step fails the job if any validation step failed, so failures are not hidden to make CI green.

Clean-host evidence is collected from GitHub Actions on the Windows Server-backed `windows-latest` runner. The first branch run (`31337105537`) exposed the host-specific test-fixture assumptions. After those fixtures were made portable, follow-up run `31337653232` passed dependency installation, typecheck, both production builds, and the command/readiness/file-opening/link/Accord/activity checks. Its remaining failures are the classified SQLite blocker (NIC-405), the pre-existing renderer harness TS1343 failure, and the Codex Stop cancellation blocker (NIC-406).

Local Windows 11 x64 follow-up on this branch resolves NIC-405 and NIC-407: the app now bundles the pinned official SQLite CLI outside ASAR and Forge produces a Squirrel installer. The packaged and installed apps both launched through the real Electron renderer, initialized SQLite with `pragma integrity_check` returning `ok`, and detected the workstation's signed-in native Codex, Claude Code, and Antigravity executables. Clean-runner confirmation remains separate from this local installed-app evidence.

## Automated baseline

| Check | Local Windows result | Classification | Notes |
| --- | --- | --- | --- |
| `npm ci` | Pass | Baseline pass | Installed 1,062 packages. npm reported existing dependency audit findings; those are outside NIC-403. |
| `npm run typecheck` | Pass | Baseline pass | Strict renderer and main-process TypeScript checks both pass. |
| `npm run build:main` | Pass | Baseline pass | Main process and preload compile successfully on Windows. |
| Renderer production build (`vite build`) | Pass | Baseline pass | Production renderer bundles successfully. |
| `npm run test:command` | Pass after NIC-403 fixture portability fix | Test harness portability | Three generic tests used `sh` even though their assertions were platform-neutral. They now use Node child processes. POSIX process-group assertions remain explicit Windows skips. |
| `npm run test:cli-readiness` | Pass locally and in the baseline runner | Baseline pass plus local native-executable proof | Windows lookup uses `where.exe`; version and authentication probes use the exact resolved path. The installed app reported the workstation's Codex 0.144.1, Claude Code 2.1.222, and Antigravity 1.1.11 as detected, runnable, and authenticated. |
| `npm run test:file-opener` | Pass on clean Windows runner | Baseline pass | IntelliJ launcher fixtures were made host-portable. This workstation's generated `node_modules/electron` payload is broken, so clean-host CI is the authoritative result for Electron-importing tests. |
| `npm run test:storage` | Pass locally with 22 tests | Resolved locally; clean-runner confirmation pending | Storage tests use the bundled, hash-verified SQLite 3.53.4 executable instead of requiring a host installation. |
| `npm run test:links` | Pass | Baseline pass | External links, message links, and local file reference parsing pass on Windows. |
| `npm run test:accord` | Pass | Baseline pass | Accord launcher preference and target reconciliation tests pass on Windows. |
| `npm run test:chat-progress-renderer` | Pass | Baseline pass | Current upstream focused activity renderer suite passes on Windows. |
| `npm run test:renderer-components` | Fail on clean Windows runner | Pre-existing upstream failure | `tsconfig.renderer-tests.json` compiles a CommonJS harness that now reaches renderer files using `import.meta`, causing TS1343. This is present at the baseline upstream revision and is not Windows-specific. |
| `npm run test:permissions` | Fail on clean Windows runner after NIC-403 fixture fixes | Windows portability blocker + test harness portability | Unix shebang `codex`/`ssh` fixtures, `/dev/null`, and hard-coded `/` source expectations were made host-portable or explicitly POSIX-only. The remaining Codex Stop test fails with `Stop hung after dead approval pipe`, which is NIC-406 cancellation evidence. AWS worker key-material tests pass on the clean GitHub Windows runner. |

## Compatibility matrix

| Area | Current Windows baseline | Classification | Owning issue / next evidence |
| --- | --- | --- | --- |
| Application startup | Packaged and Squirrel-installed Windows apps both reached the real Electron renderer from isolated profiles. | Proven locally | Repeat on the clean acceptance host in NIC-409. |
| SQLite persistence | Windows x64 packages include pinned SQLite 3.53.4 outside ASAR. Storage and artifact persistence tests pass, packaged restart succeeds, and the installed database passes `pragma integrity_check`. | Proven locally | Confirm on the clean runner and retain the pinned binary provenance check. |
| CLI discovery/readiness | Windows uses native `where.exe` discovery and probes the resolved executable path. The installed app detected and authenticated this host's native Codex, Claude Code, and Antigravity executables. | Proven locally for native executables | NIC-404 still owns safe `.cmd`/`.bat` launcher support and real-turn path-with-spaces coverage. |
| CLI execution | `spawn(..., { shell: false })` is safe for native executables, but Windows npm `.cmd`/`.bat` shims cannot be treated like Unix executables. | Windows portability blocker | NIC-404 adds a platform command abstraction with quoting/path-with-spaces coverage and no unsafe interpolation. |
| Cancellation | `runCommand()` disables POSIX process groups on `win32` and falls back to killing the direct child. POSIX descendant/process-group tests are explicitly skipped on Windows. After making the Codex app-server fixture executable on Windows, `Codex Stop still terminates the turn when the approval refusal pipe is dead` times out instead of settling. | Windows portability blocker | NIC-406 must prove full descendant termination for Stop, Abort, timeout, and the dead-approval-pipe case. |
| Repository selection | No Windows-specific source blocker identified in the baseline. | Not yet proven | Exercise repository dialog and selected-path handling in NIC-409 installed-app acceptance. |
| Git operations | `git.exe` is available on the current Windows host; no architectural rewrite is indicated. | Partially proven | Broad service CI plus NIC-409 repository/Git smoke checks. Paths containing spaces remain mandatory acceptance coverage. |
| Local file opening | IntelliJ launcher already contains Windows-specific executable discovery and rejects `.cmd`/`.bat` direct-spawn shims. Generic launcher tests now run on Windows. | Partially proven | Clean-host CI plus NIC-409 installed local-file open/reveal verification. |
| Remote-worker SSH transport | The default operation-lease integration fixture is POSIX-only and skipped on Windows. Its lease script has direct coverage, but the native Windows-to-Linux `ssh.exe` boundary is not exercised. | Test coverage gap | NIC-404 must provide the Windows command transport; NIC-409 must exercise it against an installed app and worker. |
| AWS remote-worker SSH keys | Clean GitHub Windows tests pass when Git for Windows supplies Bash. On this workstation, PATH resolves `bash.exe` to the WSL launcher and the same native path is misinterpreted. | Environment-sensitive portability gap | NIC-413 removes machine-dependent Bash coupling and covers paths containing spaces without unsafe shell concatenation. This is not an NIC-403 clean-run blocker. |
| Packaging | `npm run make:win-x64` produces a branded Squirrel Setup executable, full NuGet package, and RELEASES manifest. Install and shortcut creation pass locally. | Proven locally | Signing and Windows updates remain outside this milestone. |
| Installed-app smoke testing | Install, renderer launch, bundled SQLite initialization, native provider authentication, and same-version reinstall pass locally. | Partially proven | NIC-409 still requires real CLI turns, cancellation, Git/file operations, path-with-spaces, and user-data preservation evidence. |

## macOS-only and platform-specific behavior

These items are intentionally excluded from the Windows alpha baseline unless their owning issue says otherwise:

- `npm run signed:mac-arm64`, `make:mac-arm64`, DMG creation, notarization, signing, and macOS release scripts.
- The existing updater bootstrap, which returns immediately when `process.platform !== "darwin"`. Windows updater/signing belongs to NIC-411.
- The current macOS Open Terminal implementation in the Electron main process. Windows Terminal/PowerShell handling or explicit gating belongs to NIC-408.
- Antigravity native `/goal`, which is gated to macOS and depends on `/usr/bin/expect`. It must stay unavailable on Windows for the first alpha unless a supported Windows transport is designed later.
- macOS login-shell PATH expansion tests and Unix/POSIX process-group tests. Their Windows equivalents must be added by NIC-404 and NIC-406 rather than pretending the Unix semantics apply.
- `test:beta-updates` includes the macOS arm64 release dry-run harness and is not part of the Windows baseline workflow.
- `test:chat-goal` exercises the native-goal path whose product feature is currently macOS-only; it is not used as evidence that Windows supports `/goal`.

## Blockers mapped to follow-up issues

| Issue | Baseline evidence |
| --- | --- |
| NIC-404 | Native executable discovery is resolved locally; `.cmd`/`.bat` direct-spawn support and real-turn path-with-spaces evidence remain. |
| NIC-405 | Resolved locally by bundling and resolving the pinned official Windows x64 SQLite CLI outside ASAR. |
| NIC-406 | Windows disables the existing POSIX process-group path; descendant termination is unproven, related POSIX tests are skipped, and the now-runnable Codex dead-approval-pipe Stop test times out on Windows. |
| NIC-407 | Resolved locally with a branded Squirrel Windows x64 installer and lifecycle handling. |
| NIC-408 | Open Terminal and Antigravity native `/goal` are macOS-only and need explicit Windows UX/gating. |
| NIC-413 | AWS worker SSH-key generation is coupled to whichever `bash` wins PATH. GitHub's Git Bash passes; this workstation's WindowsApps/WSL Bash misinterprets the native path. |

## Manual Windows checks still required

NIC-403 establishes CI and classification only. It does not claim an installed Windows alpha. The following checks remain manual acceptance evidence for later issues:

1. Create, persist, restart, and reload a conversation through the installed UI; service-level conversation and artifact persistence already passes with the bundled SQLite runtime.
2. Execute real Claude, Codex, and supported Antigravity turns with repository paths containing spaces; installed-app discovery and authentication already passes for their native executables.
3. Stop, abort, and time out turns while proving no descendant processes remain.
4. Select repositories, inspect Git state, and open/reveal local files.
5. Upgrade to a later version without losing Electron `userData`; same-version reinstall already passes.

Those installed-app checks belong to NIC-409 after NIC-404 through NIC-408 have produced a usable package.
