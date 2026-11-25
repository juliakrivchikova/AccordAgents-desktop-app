---
name: fix-with-e2e-repro
description: >
  Fix a defect by reproducing it end-to-end first and proving the fix with the
  same reproduction. Use whenever User reports something broken, slow, hung,
  lost, or wrong — a bug, a regression, "почини", "поправь", "не работает" —
  before reading code or forming a theory. Not for new features or refactors.
---

# Fix with an end-to-end reproduction

**A fix starts with a reproduction that fails and ends with the same
reproduction passing.** The repro comes before the diagnosis, not after it.

This exists because reading code and log archaeology repeatedly produced
confident hypotheses instead of fixes. A reproduction settles the cause in one
run and then proves the result.

## The loop

1. **Reproduce first.** Drive the real path end to end — the actual app, the
   actual worker, the actual phone. Not a unit stub of the suspected function.
   State plainly that it fails on the current build, and paste the observable
   failure (the error, the timing, the missing row).
2. **Only then diagnose.** With a repro in hand, a theory is testable in
   minutes; without one it is an opinion.
3. **Fix.**
4. **Close with the same repro, green.** Same script, same steps, same
   assertions. A different check is not the same proof.
5. **Keep the repro** when it is cheap to keep — as a test under `scripts/` if
   it fits the existing stands, otherwise say where it lives.

## Cost is not a reason to skip it

User has explicitly accepted the cost: **"минуты и центы — для меня это ок,
зато надежно."**

A cloud-run repro pays for an EC2 boot and a project-mirror sync. Do it anyway.
That is precisely the area where reading code has already misled us more than
once, and the whole point is that the answer stops depending on anyone's
reading.

Do not ask permission to spend minutes or cents on a reproduction. Do ask before
anything genuinely destructive or outward-facing.

## When a reproduction is genuinely impossible

Say so explicitly, in one sentence, and name what you verified instead.

Never substitute a unit test, a code reading, or a log excerpt silently and
present it as the reproduction. "I could not reproduce this end to end because
X; what I verified instead is Y" is an acceptable report. Implying a proof you
did not run is not.

If the repro is impossible only because a mechanism is missing (no stand for
that path yet), say that too — the missing stand is usually worth building once
and is often the more valuable half of the task.

## Existing stands to reuse

Check for an existing harness before writing a new one:

- `scripts/mobile-e2e-phone-turn.test.mjs` — real relay + mailbox + built PWA in
  headless Chrome, driven through its own composer.
- `npm run test:permissions` — chat permissions, cancellation, repo file
  mentions, rename, role archive, participant requests, CLI permissions,
  warnings.
- `npm run test:accord` — launcher preference and target reconciliation.
- `npm run test:app-skills` — app-skill service tests.
- `/electron-desktop-qa` — the CDP route for anything the user can see in the
  desktop app.

For cloud-run defects there is no ready stand; drive a real remote run and read
`userData/debug-logs/<date>.jsonl` plus the worker's own state.

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

## Reporting

Report the repro's before/after honestly. If the fix is partial, say which part
of the reproduction is green and which is still red. Do not report a defect as
closed while any leg of its reproduction still fails.
