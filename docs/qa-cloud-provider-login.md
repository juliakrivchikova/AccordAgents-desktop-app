# Cloud provider sign-in verification

Verified on 2026-09-13 using commit `1bc2552`, a separate macOS Electron
instance and the User's existing running AWS instance. The separate desktop
profile created its own cloud environment; the User's normal cloud profile
was not reset or signed out.

## Real successful Claude sign-in

1. Settings → AWS → Diagnostics → Set up opened the native Claude Code
   authorization page and displayed the application's sign-in card.
2. The User clicked Authorize in Chrome. The page displayed the new request's
   authentication code.
3. Copy code → paste into Code from Claude → Complete sign-in used the real
   browser clipboard and Electron input controls. No code was passed in a
   command-line argument, logged by the QA script or saved in the repository.
4. The application reached `Worker ready (1 warning).`; its
   `Claude Code signed in` check passed and the setup controls became available.
5. A subsequent Diagnostics → Check also passed Claude authentication without
   another login, confirming that the native CLI saved the session.

This isolated profile enabled Claude only. Its single warning was for Codex,
which was deliberately disabled and unauthenticated in that environment.
It was not a Claude failure. The test did not sign out the User's Codex profile
or start a participant turn. The actual screenshot is saved locally as
`screenshots/qa-claude-login-success.png` (ignored by git).

Earlier real Electron checks verified cancellation, retry, rejecting a code
for another request, and restoring the form after reopening Settings.
The final successful browser approval resolves the previously recorded
end-to-end verification gap.

## Contract correction and review

`scripts/toggle-policy-contract.test.mjs` still looked for the removed
`.gen-doctor-auth-copy` focus rule in the old settings stylesheet. It now
checks the actual shared copy button, the imported provider stylesheet and
the visible keyboard-focus outline. This corrects the test without changing
application behavior or weakening its accessibility requirement.

The complete correction was reviewed with the gstack review checklist,
including the unchanged copy component and CSS import. No remaining findings.
Data size is bounded by the source files the test reads; it never loads chat
history or authentication codes. Those source strings stay in the test
process and assertion output, with no database or network destination.

Validation of the correction: all 6 toggle-policy contract checks passed, as
did `make typecheck`, `make build` and `git diff --check`. The product source
remained at the already-reviewed implementation while this real QA ran.
