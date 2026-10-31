---
name: release-beta
description: Safely issue and verify AccordAgents macOS beta releases. Use when asked to prepare, run, resume, troubleshoot, or document a beta release — the GitHub Actions `Release` workflow or `npm run release:beta` — publish a beta tag, or validate beta DMG, ZIP, signing, notarization, and update-feed artifacts.
---

# Release Beta

Releases are built, signed, notarized and published by the GitHub Actions `Release` workflow
(`.github/workflows/release.yml`) on a GitHub-hosted macOS machine. Nothing releases on a merge: a
release starts only when the User asks for one and you start the workflow. A release is complete only
after the workflow's checks of the exact published download pass.

## Non-negotiable gates

- Release betas from the short-lived `beta` branch, never from `main`. `beta` is cut from
  `main`, must still contain `main` as an ancestor, and receives only merges from `main` or
  feature branches - never direct edits. Stable releases still come from `main`.
- Release only the approved `beta` commit. Confirm `origin/beta` points at it and that
  `git merge-base --is-ancestor origin/main origin/beta` succeeds.
- The approved commit has already passed the targeted tests its changes require; the workflow runs
  typecheck and the packaging checks, not the test suites.
- Start one run per release and never re-run a run that reached its `Release` step (see Recovery).
- Do not report success from typecheck, signing, notarization, or update-feed checks alone. They do not
  prove the packaged app can resolve runtime modules.
- Keep the dedicated CLI parity invariant intact: release only reviewed application behavior; do not
  introduce release-only product behavior.

## 1. Put the approved commit on `beta`

Merge the approved feature branches into `beta` (`--no-ff`, from a clean checkout or clone) and push
`beta` to origin. The workflow releases whatever `origin/beta` holds when it starts.

## 2. Start the release

```bash
gh workflow run release.yml --repo juliakrivchikova/AccordAgents-desktop-app --ref beta -f target=beta
gh run list --repo juliakrivchikova/AccordAgents-desktop-app --workflow release.yml --limit 1 --json databaseId,url,status
gh run watch <run-id> --repo juliakrivchikova/AccordAgents-desktop-app --exit-status   # run in the background
```

Stable releases use `--ref main -f target=patch` (or `minor`/`major`). `-f target=build-only` builds,
signs and notarizes any branch without bumping or publishing and keeps the result as a workflow
artifact for 7 days; use it to try the pipeline itself.

The run, in order: checks the branch matches the target, `npm ci` with native arm64 Node, the
dependency preflight, imports the Developer ID certificate into a throwaway keychain, uploads a tiny
file to Apple notarization (an expired Apple agreement fails here, before any version is used), then
`node scripts/release-mac-arm64.mjs beta`: bump, push, tag, build, sign, notarize, launch the signed
app with a throwaway profile (`scripts/smoke-launch-packaged-app.mjs`), publish. After publishing it
downloads the published assets and checks checksums, ASAR contents, signature, notarization, stapling,
and launches the downloaded app again. The update feed check runs last and only warns.

## 3. Report evidence

Read the run (`gh run view <run-id> --log` for details) and report:

- Released version and tag, and the GitHub Release URL
- Run URL and the final `origin/beta` commit (the bump commit)
- Result of the published-download step, and the `published-launch` screenshot artifact
- Update feed: offered, or the warning if it still lags (the release is published; re-probe the feed,
  never re-run the release)

## Recovery

- A run that failed before the `Release` step changed nothing: fix the cause and start a new run.
- A run that failed inside `Release` may already have pushed the bump commit and tag. Record the
  source commit, tag, release state and the failed stage first. Do not start another run blindly: it
  bumps again and burns another version. Reconcile the existing tag and release before any recovery.
- If the published-download step fails, report the beta as defective immediately. Do not tell users to
  update to it and do not claim release completion. Ask before deleting or replacing a published
  release.
- Missing or expired secrets fail the certificate import or the notarization check. The secrets and
  where they come from are listed at the top of `.github/workflows/release.yml`; only the User can
  renew the Apple agreement or the release-repo token.

## Local fallback

Only when GitHub Actions is unavailable and the User agrees, release from a Mac:

1. Use a clean clone of the approved `beta`. Select native arm64 Node, then
   `node .agents/skills/release-beta/scripts/verify-release.mjs environment`, `npm ci`, and
   `node .agents/skills/release-beta/scripts/verify-release.mjs preflight`.
2. Provide signing credentials through the environment or an ignored `.env.local`. Never commit them.
3. Run `npm run release:beta` as one uninterrupted workflow. It bumps and pushes before building; if it
   fails, follow Recovery above.
4. Download the published ZIP and DMG into a new temporary directory, expand the ZIP with `ditto`, run
   `node .agents/skills/release-beta/scripts/verify-release.mjs packaged <app>`, the signing,
   notarization and stapling checks, and `node scripts/smoke-launch-packaged-app.mjs <app>`.
5. Confirm the beta update endpoint returns the same version and ZIP URL, and remove the temporary
   clone and directories.
