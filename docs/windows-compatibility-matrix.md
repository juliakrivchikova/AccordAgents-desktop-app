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

Clean-host evidence is collected from GitHub Actions on the Windows Server-backed `windows-latest` runner. The first branch run (`31337105537`) exposed the host-specific test-fixture assumptions. After those fixtures were made portable, follow-up run `31337653232` passed dependency installation, typecheck, both production builds, and the command/readiness/file-opening/link/Accord/activity checks. That run identified the SQLite blocker (NIC-405), the renderer harness TS1343 failure, and the Codex Stop cancellation blocker (NIC-406). All three now have focused local Windows fixes and regression coverage; the next branch run is their clean-runner confirmation.

Local Windows 11 x64 follow-up on this branch resolves the runtime and installed-alpha gates owned by NIC-404 through NIC-407 and NIC-409. The app bundles the pinned official SQLite CLI outside ASAR, Forge produces a Squirrel installer, Windows command shims launch without shell interpolation, and Stop terminates descendant trees. The installed app detected and authenticated the workstation's signed-in Codex, Claude Code, and Antigravity CLIs, completed one real turn through each provider from a repository path containing spaces, exercised Git and local-file IPC, and preserved the full chat across a local 1.10.0 to 1.10.1 upgrade. Clean-runner confirmation remains separate from this local installed-app evidence.

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
| `npm run test:renderer-components` | Pass locally with 56 tests | Resolved harness failure; clean-runner confirmation pending | The shared harness now typechecks as ES modules and uses the repository's existing esbuild ESM test pattern, so transitive `import.meta` assets execute under Node instead of CommonJS. |
| `npm run test:permissions` | Focused CLI permissions/Gemini suites pass locally with 110 tests | NIC-406 resolved; broader host-policy gaps remain classified | The dead-approval-pipe Stop case now settles promptly, and Windows warm-agent shutdown kills descendants. A full local run still encounters this workstation's known symlink-privilege and Bash-coupling failures; clean CI remains authoritative for those unrelated cases. |

## Compatibility matrix

| Area | Current Windows baseline | Classification | Owning issue / next evidence |
| --- | --- | --- | --- |
| Application startup | Packaged and Squirrel-installed Windows apps both reached the real Electron renderer from isolated profiles. | Proven locally | Repeat on the maintainer's Windows regression host. |
| SQLite persistence | Windows x64 packages include pinned SQLite 3.53.4 outside ASAR. Storage and artifact persistence tests pass, packaged restart succeeds, and the installed database passes `pragma integrity_check`. | Proven locally | Confirm on the clean runner and retain the pinned binary provenance check. |
| CLI discovery/readiness | Windows uses native `where.exe` discovery, prefers runnable PATHEXT entries over extensionless npm shims, and probes the resolved path. The installed app detected and authenticated Codex 0.144.1, Claude Code 2.1.222, and Antigravity 1.1.11. | Proven locally | Confirm the focused command/readiness suite on the clean runner. |
| CLI execution | A shared `cross-spawn` seam launches native executables and `.cmd`/`.bat` shims without passing unescaped argument arrays through `shell: true`. Tests cover both shim extensions, paths with spaces, metacharacters, exact argv preservation, and an injection marker. Installed Codex, Claude, and Antigravity turns all completed from a repository whose absolute path contained spaces. | Proven locally | Retain the dedicated-CLI parity tests and clean-runner coverage. |
| Cancellation | Windows abort, timeout, and warm-agent shutdown use `taskkill.exe /PID ... /T /F`; POSIX process groups remain unchanged. Descendant fixtures exit, and Stop rejects immediately even when the approval-refusal pipe never settles. | Proven locally | Confirm on the clean runner and retain provider-specific Stop regression coverage. |
| Repository selection | The installed New chat flow selected a saved recent repository whose absolute path contained spaces. | Proven locally | Repeat on the maintainer's Windows regression host. |
| Git operations | Installed-app IPC identified the spaced workspace as a Git repository, reported `M README.md`, produced the expected working-tree diff, and found both README paths. | Proven locally | Repeat on the maintainer's Windows regression host. |
| Local file opening | Installed-app IPC inspected `README.md` as inside the selected workspace and successfully invoked the Windows reveal action for its absolute spaced path. | Proven locally | Repeat the visible shell integration on the maintainer's Windows regression host. |
| Remote-worker SSH transport | The default operation-lease integration fixture is POSIX-only and skipped on Windows. Its lease script has direct coverage, but the native Windows-to-Linux `ssh.exe` boundary is not exercised. | Test coverage gap | Exercise the native Windows-to-Linux boundary in the remote-worker follow-up rather than treating local CLI launch coverage as proof. |
| AWS remote-worker SSH keys | Clean GitHub Windows tests pass when Git for Windows supplies Bash. On this workstation, PATH resolves `bash.exe` to the WSL launcher and the same native path is misinterpreted. | Environment-sensitive portability gap | NIC-413 removes machine-dependent Bash coupling and covers paths containing spaces without unsafe shell concatenation. This is not an NIC-403 clean-run blocker. |
| Packaging | `npm run make:win-x64` produces a branded Squirrel Setup executable, full NuGet package, and RELEASES manifest. Install and shortcut creation pass locally. | Proven locally | Signing and Windows updates remain outside this milestone. |
| Installed-app smoke testing | Install, renderer launch, bundled SQLite initialization, provider authentication and real turns, Git/file operations, paths with spaces, restart, and a 1.10.0 to 1.10.1 upgrade pass locally. The isolated profile retained one conversation, five messages, settings, and `pragma integrity_check = ok`. | Proven locally | Maintainer regression testing and clean-runner confirmation remain before release support claims. |

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
| NIC-404 | Resolved locally with PATHEXT-aware lookup, safe `.cmd`/`.bat` launch support, exact provider-path execution, injection regression tests, and real turns from a spaced repository path. |
| NIC-405 | Resolved locally by bundling and resolving the pinned official Windows x64 SQLite CLI outside ASAR. |
| NIC-406 | Resolved locally with Windows process-tree termination for abort/timeout/warm shutdown and non-blocking Stop behavior for a dead approval-refusal pipe. |
| NIC-407 | Resolved locally with a branded Squirrel Windows x64 installer, lifecycle handling, and a successful later-version upgrade that preserved the isolated user profile. |
| NIC-408 | Open Terminal and Antigravity native `/goal` are macOS-only and need explicit Windows UX/gating. |
| NIC-413 | AWS worker SSH-key generation is coupled to whichever `bash` wins PATH. GitHub's Git Bash passes; this workstation's WindowsApps/WSL Bash misinterprets the native path. |

## Remaining Windows confirmation

The local installed-alpha checklist is complete for this branch. Before a release-quality support claim:

1. Confirm the branch workflow on a clean GitHub `windows-latest` runner.
2. Have the maintainer exercise the Windows installer and run macOS regression checks against the focused cross-platform changes.
3. Keep the updater, signing, Open Terminal UX, Antigravity native `/goal`, and AWS Bash decoupling in their existing follow-up issues.

The isolated Antigravity turn completed successfully but displayed an app-MCP setup warning. That warning did not block readiness, authentication, or the noninteractive provider reply and should be regression-checked separately from the Windows launcher path.
