---
name: release-beta
description: Safely issue and verify AccordAgents macOS beta releases. Use when asked to prepare, run, resume, troubleshoot, or document `npm run release:beta`, publish a beta tag, or validate beta DMG, ZIP, signing, notarization, and update-feed artifacts.
---

# Release Beta

Treat `npm run release:beta` as release orchestration, not dependency installation. A release is complete only after the exact published ZIP passes dependency inspection and launches successfully.

## Non-negotiable gates

- Release only the approved `main` commit. Confirm local and remote `main` match.
- Preserve unrelated user changes. Use a clean isolated clone when the primary checkout is dirty.
- In an isolated clone, run `npm ci`. Never copy or symlink `node_modules` from another checkout.
- Use native macOS arm64 Node. Do not release through Rosetta or an x64 Node binary.
- Run `npm run release:beta` as one uninterrupted workflow. Do not replace it with individual build, tag, or upload commands.
- Do not report success from typecheck, signing, notarization, or update-feed checks alone. They do not prove the packaged app can resolve runtime modules.
- Keep the dedicated CLI parity invariant intact: release only reviewed application behavior from `main`; do not introduce release-only product behavior.

## 1. Prepare a real clean checkout

1. Record the approved commit and verify remote `main` points to it.
2. If the active checkout contains staged, unstaged, or untracked user work, leave it untouched and create a temporary clean clone.
3. Before installing anything, select native arm64 Node and verify it:

   ```bash
   node .agents/skills/release-beta/scripts/verify-release.mjs environment
   ```

   Ensure `npm` uses that same Node installation. This check must happen before `npm ci`; npm selects architecture-specific optional packages during installation.
4. Install dependencies inside that checkout with `npm ci` while the arm64 Node installation is first on `PATH`.
5. Provide signing credentials through the normal environment or an ignored `.env.local`. Never commit credentials.
6. Run the deterministic dependency preflight:

   ```bash
   node .agents/skills/release-beta/scripts/verify-release.mjs preflight
   ```

The preflight must confirm arm64 Node, a real local `node_modules` directory, the full locked production/development dependency tree, arm64-native optional packages, and local build binaries. Any failure is blocking.

## 2. Prove packaging before publication

Run the relevant tests, then build an unsigned/local package from the same checkout and dependency tree:

```bash
make typecheck
make build
npm run package -- --platform=darwin --arch=arm64
node .agents/skills/release-beta/scripts/verify-release.mjs packaged out/AccordAgents-darwin-arm64/AccordAgents.app
```

Run all targeted tests required by the implementation or release assignment in addition to these commands.

Launch that packaged app with an isolated user-data directory and a dedicated CDP port. Read and follow `../electron-desktop-qa/SKILL.md` for the live-app workflow. Require all of the following:

- The main process stays alive with no uncaught exception.
- The renderer loads through Electron with its preload bridge.
- A screenshot and timestamped launch log are captured.
- The app reports the expected pre-release version.

Stop the process and remove only the temporary profile created for this check.

## 3. Issue the beta

From the same clean checkout, with the same real dependency tree and arm64 Node, run:

```bash
npm run release:beta
```

Do not interrupt or manually continue individual subcommands. The release script bumps and pushes the version before building; if it fails, first record the source commit, tag, release state, and exact failed stage. Do not blindly rerun it because that can create another beta version. Reconcile the existing tag and release before any recovery action.

## 4. Verify the exact published artifact

1. Download the published arm64 ZIP from its GitHub Release into a new temporary directory. Use `gh` through the environment's required approved/external execution path.
2. Expand the ZIP with `ditto` and run:

   ```bash
   node .agents/skills/release-beta/scripts/verify-release.mjs packaged /path/to/unpacked/AccordAgents.app
   ```

3. Verify the exact downloaded app and DMG with the repository's signing, notarization, and stapling checks.
4. Launch the downloaded app with a fresh isolated user-data directory and repeat the Electron/CDP smoke workflow.
5. Confirm the beta update endpoint returns the same version and ZIP URL.

If the published app fails, report the beta as defective immediately. Do not tell users to update to it and do not claim release completion. Ask before deleting or replacing an already published release.

## 5. Report evidence

Report only after every gate passes:

- Released version and tag
- GitHub Release URL
- Final remote `main` commit
- `npm ci` and dependency-preflight result
- Typecheck, build, and targeted-test results
- Local packaged-ASAR inspection and live-launch evidence
- Published ZIP ASAR inspection and live-launch evidence
- Signing, notarization, stapling, and update-feed results
- Temporary checkout/profile cleanup status and confirmation that user work was preserved
