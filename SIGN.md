# Signing and Releasing AccordAgents

Use this when `.env.local` is already provided.

## Agent Runbook: User Asks for a Signed DMG

1. Do not use `npm run make` as the deliverable. A plain Forge DMG is only a
   packaging check and is not the signed/notarized distribution artifact.

2. Confirm the signing environment is available without printing secrets:
   ```bash
   security find-identity -p codesigning -v
   ```

   The keychain must include the `Developer ID Application` identity matching
   `APPLE_CODESIGN_IDENTITY`.

3. Use `.env.local` if it exists; this is the expected no-extra-input path for
   repeat signed DMG requests. If it is missing, ask the user to restore
   `.env.local` in the repo root from their secure local copy/password manager.
   Do not ask the user to re-explain the signing process. Use Apple signing
   values only from a user-approved source for the current build command. Never
   commit or document Apple IDs, app-specific passwords, certificate passwords,
   or `.p12` files.

4. Build the signed and notarized arm64 artifacts:
   ```bash
   npm run signed:mac-arm64
   ```

   The script cleans `out/` and `signed/`, runs typecheck, packages the app,
   signs the app bundle, notarizes and staples the app, writes the updater ZIP,
   launches the signed app once with a throwaway profile
   (`scripts/smoke-launch-packaged-app.mjs`; a window opens briefly, screenshot
   and log land in `out/launch/`), signs/notarizes/staples the DMG, then writes
   the finished DMG and updater ZIP into `signed/`.

5. Report only the artifact path, checksum, and validation result:
   ```bash
   shasum -a 256 signed/AccordAgents-*-arm64.dmg
   cat signed/AccordAgents-*-arm64.dmg.sha256
   shasum -a 256 signed/AccordAgents-*-darwin-arm64.zip
   cat signed/AccordAgents-*-darwin-arm64.zip.sha256
   xcrun stapler validate "$(pwd)/signed/AccordAgents-0.1.0-arm64.dmg"
   spctl -a -vv --type open --context context:primary-signature "$(pwd)/signed/AccordAgents-0.1.0-arm64.dmg"
   codesign --verify --verbose=2 "$(pwd)/signed/AccordAgents-0.1.0-arm64.dmg"
   ```

   In sandboxed agent sessions, `stapler`, `spctl`, and `codesign` checks may
   need native/escalated execution because macOS code-signing services can fail
   with false file-open or internal Code Signing errors inside the sandbox.

6. If signing fails with `A timestamp was expected but was not found` for a
   loose Electron data resource such as `locale.pak`, do not hand out that
   artifact. Keep the `forge.config.ts` loose-resource signing skip in place and
   rerun `npm run signed:mac-arm64`.

## Restoring the Local Signing Environment

If an agent reports that the signing environment is missing, it means one of
these local-only prerequisites is absent:

- `.env.local` in the repo root with:
  - `APPLE_CODESIGN_IDENTITY`
  - `APPLE_TEAM_ID`
  - `APPLE_NOTARIZE_APPLE_ID`
  - `APPLE_NOTARIZE_PASSWORD`
  - `MACOS_BUNDLE_ID`
- the matching `Developer ID Application` certificate and private key imported
  into the macOS login Keychain.

Agents should first ask the user to restore `.env.local` from their secure local
copy/password manager. If `security find-identity -p codesigning -v` still does
not show the matching `Developer ID Application` identity, ask the user to import
the `.p12` certificate into Keychain Access. Do not commit `.env.local`,
`.p12`, or certificate passwords.

## One-Time Setup

1. Install Xcode from the App Store.

2. Select Xcode command line tools:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   xcrun notarytool --version
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Put the provided `.env.local` in the project root.

5. Import the provided `Developer ID Application` certificate `.p12` into
   Keychain Access:
   - open `Keychain Access`;
   - select the `login` keychain;
   - double-click the `.p12`;
   - enter the `.p12` password;
   - confirm it appears under `My Certificates` with a private key.

6. Verify the certificate identity exists:
   ```bash
   security find-identity -p codesigning -v
   ```

   The output must include the exact `APPLE_CODESIGN_IDENTITY` value from
   `.env.local`.

## Build

Run from any branch:

```bash
npm run signed:mac-arm64
```

The finished files will be in `signed/`:

```text
AccordAgents-<version>-arm64.dmg
AccordAgents-<version>-arm64.dmg.sha256
AccordAgents-<version>-darwin-arm64.zip
AccordAgents-<version>-darwin-arm64.zip.sha256
```

The DMG is for direct user downloads. The ZIP is required by
`update.electronjs.org` for macOS auto-updates.

## Release to GitHub

Stable release artifacts are published to the public release repository
configured in `package.json` as `config.releaseRepo`:

```text
juliakrivchikova/AccordAgents-Releases
```

Beta release artifacts are published to the separate public release repository
configured as `config.betaReleaseRepo`:

```text
juliakrivchikova/AccordAgents-Beta-Releases
```

Both release repositories must be public before `update.electronjs.org` can
discover new releases. The source repository and release repositories are
separate; release artifacts are never published to the source repository (the
signed Windows files only pass through a draft there, see Windows below).

Releases are normally built and published by the GitHub Actions `Release`
workflow (`.github/workflows/release.yml`), started by hand — a merge never
releases:

```bash
gh workflow run release.yml --repo juliakrivchikova/AccordAgents-desktop-app --ref beta -f target=beta
gh workflow run release.yml --repo juliakrivchikova/AccordAgents-desktop-app --ref main -f target=patch
```

`-f target=build-only` signs, notarizes and launch-checks any branch without
bumping or publishing. Stable targets work once this workflow is on `main`. The workflow needs the repository secrets listed at the
top of `release.yml`. It runs the same `release-mac-arm64.mjs` as below, pinned
to the commit the run was started for, then downloads the published assets and
checks and launches them.

To release from a Mac instead, run stable releases from `main` and beta releases
from `beta`, with a clean worktree. Each release command enforces its source
branch automatically. The active GitHub CLI account must have write access to the
target release repository:

```bash
gh auth switch --user <your-github-username>
npm run release:patch
npm run release:beta
npm run release:minor
npm run release:major
```

The release script bumps the version, commits the bump and creates source tag
`v<version>` locally, runs `npm run signed:mac-arm64`, pushes the bump and the
tag together only after that build succeeded (a failed build is rolled back and
uses no version), then creates or updates the GitHub Release in the selected
release repository with:

```text
AccordAgents-<version>-arm64.dmg
AccordAgents-<version>-arm64.dmg.sha256
AccordAgents-<version>-darwin-arm64.zip
AccordAgents-<version>-darwin-arm64.zip.sha256
```

Use `--draft` or `--prerelease` only for manual inspection releases. Drafts and
prereleases are ignored by the public update service, so normal app updates need
a published, non-prerelease release.

`npm run release:beta` always targets `config.betaReleaseRepo` by default,
calculates the next version as `x.y.(z+1)-beta.1` from a stable version, and
publishes an ordinary GitHub Release. Do not pass `--draft` or `--prerelease`
for beta releases; beta users only receive updates that
`update.electronjs.org` can see.

When a beta cycle graduates to stable, publish the final stable build to the beta
release repository too. That lets users who left `Beta updates` enabled converge
automatically. The manual fallback is to turn `Beta updates` off in Settings and
restart the app so the stable feed is checked on next launch.

## Verify Auto-Updates

Each `release:*` command checks that `update.electronjs.org` can find the
published ZIP asset before it finishes. The check uses the public release repo,
platform `darwin-arm64`, and the version created by that release run.

## Windows

Windows x64 ships only with stable releases. Betas have no Windows build, and
the Windows app always follows the stable feed, so its Settings have no `Beta
updates`. Windows builds are signed with the Certum code-signing certificate,
whose key stays in Certum's cloud and is reached only through SimplySign
Desktop on the User's Windows PC, after she signs in there with the code from
its phone app. Everything else runs in the `Windows release` workflow
(`.github/workflows/windows-release.yml`):

1. A stable `Release` run starts it for its tag once macOS is published; by
   hand: `gh workflow run windows-release.yml --repo
   juliakrivchikova/AccordAgents-desktop-app --ref main -f tag=v<version>`.
   `Build` builds the unsigned app from the tag on a GitHub-hosted Windows
   machine, checked out with LF line endings like the macOS build (the app
   ships skills, prompts and the cloud machine runtime byte for byte), checks
   its archive, launches it and keeps it as an artifact. `Publish` then waits.
2. On the Windows PC, within a week (the unsigned app is kept for 7 days),
   with SimplySign Desktop signed in and the GitHub CLI signed in as the User,
   the reviewer of `windows-signing`: in a clean clone checked out at the tag,
   `npm ci`, then `npm run sign:windows-x64 -- --run <run id>`. It checks that
   the run is one of this workflow and built the commit the tag names here,
   downloads the unsigned app, signs its files, packs and signs the installer,
   checks every signature, puts the files in the draft release
   `windows-signed-<run id>` of this repository and approves `Publish`. The
   clone supplies only the installer's metadata, so its line endings do not
   matter.
3. `Publish` checks that the tag still names the built commit and that the
   installer from the draft carries the release certificate before running
   anything from it. It installs the installer on a clean GitHub machine,
   checks the signatures of everything installed as Windows sees them, checks
   that the NuGet package and `RELEASES` are the ones inside the signed
   installer (anyone who can write to this repository can write to the draft),
   launches the installed app, and only then adds to the GitHub Release of the
   tag:

   ```text
   AccordAgents-<version>-win32-x64-Setup.exe
   AccordAgents-<version>-win32-x64-Setup.exe.sha256
   accordagents-<version>-full.nupkg
   accordagents-<version>-full.nupkg.sha256
   RELEASES
   ```

   The NuGet package and `RELEASES` go up first and the installer last: the
   update service offers a release to Windows as soon as it carries an `.exe`,
   and Squirrel then reads `win32-x64/<installed version>/RELEASES`. A
   published installer is never replaced. Then it checks the published
   download, removes the draft, and checks the update feed, which only warns.

Without a tag the workflow is a trial of the selected branch: it builds, waits
for the signature, installs and launches, and publishes nothing. GitHub starts
a workflow by hand only when its file is on the default branch, so
`windows-release.yml` can run once it is on `main`, as it is after the first
stable release that carries it.

One-time setup: Settings → Environments → `windows-signing`, with the User as
a required reviewer, so `Publish` waits for the signature. Without the
environment `Publish` fails at once for want of the draft, and
`sign:windows-x64` re-runs it. The certificate's SHA1 thumbprint is
`config.windowsSignCertSha1` in `package.json`; change it when the certificate
is renewed.

What gets our signature is decided by `scripts/windows-sign-file.cjs`:
`resources/sqlite/win32-x64/sqlite3.exe` stays unsigned, because the app checks
that file byte for byte before it opens storage and a signed copy refuses to
start; files that arrive signed by their own publisher (Microsoft's ConPTY and
`d3dcompiler_47.dll`) keep that signature; every other binary gets ours. `npm
run sign:windows-x64 -- --check <Setup.exe> [<app folder>]` checks those rules.

If Windows betas ever ship, pad the beta number for Squirrel first: it compares
prerelease text character by character, so `beta10` would sort below `beta9`
and installed apps would keep starting the older version.

## If macOS Asks for Keychain Access

Allow `codesign`, `xcrun`, or `electron-osx-sign` to use the private key.
Choose `Always Allow` if available.
