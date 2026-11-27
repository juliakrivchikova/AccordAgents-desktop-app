---
name: implement-change
description: >
  Implement requested features and fixes. Choose focused checks for small changes
  and verify workflows across the affected boundaries for broader changes.
---

# Implement Change

Own the change end to end. Do not replace implementation with planning or delegate participant-owned stages unless the user explicitly asks for delegation.

## Small changes

For a small, isolated change, implement the fix and run the focused test or
reproduction and any cheap checks that directly apply. Report the result.
Start a server, browser or benchmark for a small change only when the User asks.

For broader changes, use the workflow below.

## Verify the affected lifecycle

Before editing, trace the affected path from the user action to its final result.
Keep a compact map in the working context: states and transitions, who owns each
state, and where data is applied, persisted, acknowledged or sent outside the app.
Read the connected callers and consumers, including unchanged code.

For each new state or mechanism, identify its interactions with existing
transitions and verify the applicable cases: cancellation before and during work,
failure before and after persistence, duplicate or delayed delivery, reconnect,
and restart. Choose cases from the actual path; do not invent irrelevant work.
Exercise the coordinating path across its real boundaries; focused fault-injection
tests support real end-to-end QA, and a helper test alone does not prove the caller.

If a finding recurs in the same path, stop patching individual symptoms: re-read
the whole affected path, identify shared failure causes, and check sibling
transitions before the next fix. Then rerun earlier regressions and the cases
introduced by the fix. Keep edits within the authorized scope.

In review and completion notes, distinguish verified cases, failures, and cases
not checked; report remaining gaps without claiming the path is fully verified.

## Workflow

1. Read `docs/parity-requirements.md` and the repository instructions. Confirm the user-visible requirement and acceptance criteria; ask the user only when a missing product decision would materially change behavior.
2. Inspect the current data flow, ownership boundaries, working tree, and existing tests. Apply the lifecycle check above and preserve unrelated user changes.
3. Implement the smallest correct change that satisfies every acceptance criterion. Cover the happy path, empty or missing data, retries, stale state, concurrency, and relevant upstream failures.
4. Add focused regression tests, then run the relevant targeted suites, `make typecheck`, and `make build`. Fix failures caused by the change.
5. Perform end-to-end QA through the real user-visible path:
   - Use `/electron-desktop-qa` for Electron renderer behavior and follow `docs/inspecting-the-desktop-app.md`.
   - Test PWA behavior in the real PWA against the real Electron app and actual relay/integrations involved; a browser fixture or mocked event is supporting evidence only.
   - Force controllable failure paths such as disconnect, retry, cancellation, or restart when they are relevant.
   - If live verification requires deployment or another external mutation the user did not authorize, ask before doing it.
6. Repeat the affected checks after fixes until every acceptance criterion passes. Stop and report a concrete blocker when real QA is technically impossible; do not silently substitute a weaker check.

## Compact when most of the context is no longer needed

Context size alone is not the signal. Compact when most of what your context holds will not be needed for what comes next. Typical cases (the list is not complete):

- A big stage is finished: the implementation with its tests, the review with its fixes, the end-to-end QA, or the whole task.
- A long investigation or approach turned out to be a dead end.
- Large outputs have served their purpose: logs, test runs, file dumps, screenshots.
- You are switching to unrelated work.

Judge any other case by the same question: would a short summary carry everything the next step needs?

- In AccordAgents Chat a compaction you request with `app_chat_request_compaction` runs only after your turn ends, and then the app calls you again to go on. At that point report what is done and what comes next. Request compaction with instructions naming what the next step needs: branch and head, changed files, open findings, how to verify. Then end your turn; go on with the next step when you are called again. Do not request it when nothing is left to do.
- Outside AccordAgents, tell the user at that point that it is a good moment for `/compact`.
- Do not compact while the details in your context are still needed. A question like "is it time to compact?" is not a reason in itself: answer it by the question above.

## Completion

Report the changed files, the checks performed and any remaining gaps.
Commit, push, deploy or release only when the User explicitly requests it.
