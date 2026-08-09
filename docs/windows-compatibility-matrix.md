# Windows compatibility matrix

This document is the NIC-403 baseline for the AccordAgents Windows port. It records what is already portable, what is blocked on Windows, what is intentionally macOS-only, and what still needs installed-app evidence.

Baseline source revision: upstream `main` at `0d4ef2cf660227de57e817d5ddd490622e408c43`.

Target environment: Windows 11 x64. GitHub Actions uses `windows-latest` with Node.js 20, matching the repository's documented Node.js 20+ requirement.

## Failure classification

Every Windows failure belongs to one of these categories:

- **Pre-existing upstream failure**: reproducible from the current upstream source and not caused by Windows-specific behavior.
- **Windows portability blocker**: product or runtime behavior that must change for supported Windows execution.
- **Expected macOS-only behavior**: intentionally unavailable on Windows for the current milestone.
- **Unrelated test/environment issue**: the test host or dependency installation prevents the intended behavior from being exercised.

The Windows workflow uses `continue-on-error` only so later checks still run and produce evidence. Its final enforcement step fails the job if any validation step failed, so failures are not hidden to make CI green.

Clean-host evidence is collected from GitHub Actions on `windows-latest`. The first branch run (`31337105537`) proved dependency installation, typecheck, both production builds, command/readiness/file-opening/link/Accord/activity tests, and exposed the remaining failures without short-circuiting the job.

## Automated baseline

| Check | Local Windows result | Classification | Notes |
| --- | --- | --- | --- |
| `npm ci` | Pass | Baseline pass | Installed 1,062 packages. npm reported existing dependency audit findings; those are outside NIC-403. |
| `npm run typecheck` | Pass | Baseline pass | Strict renderer and main-process TypeScript checks both pass. |
| `npm run build:main` | Pass | Baseline pass | Main process and preload compile successfully on Windows. |
| Renderer production build (`vite build`) | Pass | Baseline pass | Production renderer bundles successfully. |
| `npm run test:command` | Pass after NIC-403 fixture portability fix | Test harness portability | Three generic tests used `sh` even though their assertions were platform-neutral. They now use Node child processes. POSIX process-group assertions remain explicit Windows skips. |
| `npm run test:cli-readiness` | Pass | Baseline pass with coverage limit | Service-level readiness logic passes because command lookup/execution are dependency-injected in these tests. This does not prove real Windows executable discovery. |
| `npm run test:file-opener` | Pass on clean Windows runner | Baseline pass | IntelliJ launcher fixtures were made host-portable. This workstation's generated `node_modules/electron` payload is broken, so clean-host CI is the authoritative result for Electron-importing tests. |
| `npm run test:storage` | Fail on clean Windows runner | Windows portability blocker | GitHub Actions records `spawn sqlite3 ENOENT`; `sqlite3` is absent from the clean runner. This is the expected NIC-405 blocker. |
| `npm run test:links` | Pass | Baseline pass | External links, message links, and local file reference parsing pass on Windows. |
| `npm run test:accord` | Pass | Baseline pass | Accord launcher preference and target reconciliation tests pass on Windows. |
| `npm run test:chat-progress-renderer` | Pass | Baseline pass | Current upstream focused activity renderer suite passes on Windows. |
| `npm run test:renderer-components` | Fail on clean Windows runner | Pre-existing upstream failure | `tsconfig.renderer-tests.json` compiles a CommonJS harness that now reaches renderer files using `import.meta`, causing TS1343. This is present at the baseline upstream revision and is not Windows-specific. |
| `npm run test:permissions` | Windows failure isolated after NIC-403 fixture fixes | Windows portability blocker + test harness portability | Unix shebang `codex`/`ssh` fixtures, `/dev/null`, and hard-coded `/` source expectations were made host-portable or explicitly POSIX-only. The remaining locally reproducible Codex Stop test times out after the provider closes its approval stdin, which is NIC-406 cancellation evidence. AWS worker key-material tests pass on the clean GitHub Windows runner. |

## Compatibility matrix

| Area | Current Windows baseline | Classification | Owning issue / next evidence |
| --- | --- | --- | --- |
| Application startup | Main and renderer builds pass. Development/installed startup is not yet accepted. | Not yet proven | NIC-407 provides a Windows package; NIC-409 must prove installed startup. |
| SQLite persistence | `StorageService` and `ArtifactStore` execute the external `sqlite3` CLI. `sqlite3` is not installed on the current Windows host. | Windows portability blocker | NIC-405 bundles and resolves `sqlite3.exe`, then reruns persistence/restart checks. |
| CLI discovery/readiness | `lookupCommand()` executes Unix `which`. The current Windows host has `codex.exe`, `claude.exe`, and `agy.EXE`, but no `which`, so production discovery cannot reliably find them. | Windows portability blocker | NIC-404 adds PATH/PATHEXT-aware resolution and Windows launcher tests. |
| CLI execution | `spawn(..., { shell: false })` is safe for native executables, but Windows npm `.cmd`/`.bat` shims cannot be treated like Unix executables. | Windows portability blocker | NIC-404 adds a platform command abstraction with quoting/path-with-spaces coverage and no unsafe interpolation. |
| Cancellation | `runCommand()` disables POSIX process groups on `win32` and falls back to killing the direct child. POSIX descendant/process-group tests are explicitly skipped on Windows. After making the Codex app-server fixture executable on Windows, `Codex Stop still terminates the turn when the approval refusal pipe is dead` times out instead of settling. | Windows portability blocker | NIC-406 must prove full descendant termination for Stop, Abort, timeout, and the dead-approval-pipe case. |
| Repository selection | No Windows-specific source blocker identified in the baseline. | Not yet proven | Exercise repository dialog and selected-path handling in NIC-409 installed-app acceptance. |
| Git operations | `git.exe` is available on the current Windows host; no architectural rewrite is indicated. | Partially proven | Broad service CI plus NIC-409 repository/Git smoke checks. Paths containing spaces remain mandatory acceptance coverage. |
| Local file opening | IntelliJ launcher already contains Windows-specific executable discovery and rejects `.cmd`/`.bat` direct-spawn shims. Generic launcher tests now run on Windows. | Partially proven | Clean-host CI plus NIC-409 installed local-file open/reveal verification. |
| AWS remote-worker SSH keys | Clean GitHub Windows tests pass when Git for Windows supplies Bash. On this workstation, PATH resolves `bash.exe` to the WSL launcher and the same native path is misinterpreted. | Environment-sensitive portability gap | NIC-413 removes machine-dependent Bash coupling and covers paths containing spaces without unsafe shell concatenation. This is not an NIC-403 clean-run blocker. |
| Packaging | Forge makers are currently ZIP/DMG restricted to `darwin`; there is no Windows maker or installer. | Windows portability blocker | NIC-407. Do not treat a future `make` success alone as installed-app acceptance. |
| Installed-app smoke testing | No Windows installer exists yet. | Not yet available | NIC-409 requires clean install, launch, persistence, CLI turns, cancellation, Git/file operations, path-with-spaces, and reinstall/upgrade preservation evidence. |

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
| NIC-404 | Unix `which` command discovery; missing PATH/PATHEXT resolution; `.cmd`/`.bat` direct-spawn limitation. |
| NIC-405 | Persistence shells out to external `sqlite3`; current Windows host has no `sqlite3` command. |
| NIC-406 | Windows disables the existing POSIX process-group path; descendant termination is unproven, related POSIX tests are skipped, and the now-runnable Codex dead-approval-pipe Stop test times out on Windows. |
| NIC-407 | Forge configuration exposes only macOS ZIP/DMG makers. |
| NIC-408 | Open Terminal and Antigravity native `/goal` are macOS-only and need explicit Windows UX/gating. |
| NIC-413 | AWS worker SSH-key generation is coupled to whichever `bash` wins PATH. GitHub's Git Bash passes; this workstation's WindowsApps/WSL Bash misinterprets the native path. |

## Manual Windows checks still required

NIC-403 establishes CI and classification only. It does not claim an installed Windows alpha. The following checks remain manual acceptance evidence for later issues:

1. Start the installed application on Windows 11 x64.
2. Create, persist, restart, and reload conversations/artifacts without separately installing SQLite.
3. Detect and authenticate supported CLI providers using real Windows launchers.
4. Execute real Claude, Codex, and supported Antigravity turns with repository paths containing spaces.
5. Stop, abort, and time out turns while proving no descendant processes remain.
6. Select repositories, inspect Git state, and open/reveal local files.
7. Reinstall or upgrade without losing Electron `userData`.

Those installed-app checks belong to NIC-409 after NIC-404 through NIC-408 have produced a usable package.
