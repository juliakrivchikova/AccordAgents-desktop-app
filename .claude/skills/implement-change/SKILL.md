---
name: implement-change
description: Carry ANY change the User asks for through implementation, tests, the gstack review, and real end-to-end QA in the running app or the installed PWA. Invoke this for every request that alters repository behavior or what the User sees, with no exception for size: a one-line CSS tweak, a copy change, a config value, a rename, a bug fix, a new feature. Triggers on implement, build, add, change, update, tweak, adjust, rename, remove, fix, "почини", "поправь", "сделай", "измени", "не работает", and on any follow-up correction to a change already made. If in doubt whether a request is big enough, it is: invoke it. Do not use only for pure questions, status checks, or reading code.
---

# Implement Change

Own the change end to end. Do not replace implementation with planning or delegate participant-owned stages unless the user explicitly asks for delegation.

## No size exemption

Every change goes through the whole workflow, whatever it looks like from the
inside. There is no threshold below which the review and the end-to-end QA are
skipped, and "it is one line", "it is only CSS", "I can see it is right by
reading it", and "the User is waiting" are not reasons — they are the exact
reasoning that has shipped broken work here more than once. A CSS fix that was
obviously correct on inspection reached the User clipped, because a percentage
height needs the parent to resolve one and reading the rule does not tell you
whether it does.

Two consequences worth stating plainly:

- **Speed is not yours to trade.** Doing the QA costs minutes. If that delay
  matters, say so and let the User choose; never make the trade silently by
  skipping the step.
- **A follow-up correction is a change too.** The second, third and fourth
  attempts at the same defect each get the same treatment as the first. That is
  where the skipping usually happens.

## Workflow

1. Read `docs/parity-requirements.md` and the repository instructions. Confirm the user-visible requirement and acceptance criteria; ask the user only when a missing product decision would materially change behavior.
2. Inspect the current data flow, ownership boundaries, working tree, and existing tests. Preserve unrelated user changes.
3. Implement the smallest correct change that satisfies every acceptance criterion. Cover the happy path, empty or missing data, retries, stale state, concurrency, and relevant upstream failures.
4. Add focused regression tests, then run the relevant targeted suites, `make typecheck`, and `make build`. Fix failures caused by the change.
5. Invoke the gstack `/review` skill on the full diff. Address every valid finding, add regression coverage where appropriate, and rerun affected verification. Do not treat source inspection or the implementation author's summary as review.
6. Perform end-to-end QA through the real user-visible path:
   - Use `/electron-desktop-qa` for Electron renderer behavior and follow `docs/inspecting-the-desktop-app.md`.
   - Test PWA behavior in the real PWA against the real Electron app and actual relay/integrations involved; a browser fixture or mocked event is supporting evidence only.
   - Force controllable failure paths such as disconnect, retry, cancellation, or restart when they are relevant.
   - If live verification requires deployment or another external mutation the user did not authorize, ask before doing it.
7. Repeat the implementation, review, and QA loop until every acceptance criterion passes. Stop and report a concrete blocker when real QA is technically impossible; do not silently substitute a weaker check.

## Completion Gate

Finish only when all of the following are true:

- The implementation is complete and scoped to the request.
- Focused tests, typecheck, and build pass.
- The gstack review has run on the final diff and all valid findings are resolved.
- Every acceptance criterion has direct real-workflow PASS evidence from Electron/PWA as applicable.

Report changed files, verification commands, review result, real QA evidence, and any residual risk. Do not merge, push, deploy, or release unless the user explicitly requested it.
