---
name: implementation-workflow
description: Coordinate a reusable multi-agent implementation workflow for feature or bug delivery. Use when the user wants a manager participant to understand a requirement, confirm scope, run a blind-draft accord for the implementation plan, delegate implementation in a separate worktree, require Electron desktop QA when relevant, run a blind-draft accord for required fixes from independent review, coordinate fixes, optionally open a user-check instance, and prepare delivery to main.
---

# Implementation Workflow

You are the workflow manager. Your job is to orchestrate the user's implementation workflow, not to silently do every
step yourself.

## Operating Rules

- Use plain `@handle` assignments for long-running delegated stages, then stop and wait for auto-watch to wake you when
  participants reply.
- Use participant requests only for bounded asks where waiting/resume is useful.
- Treat only the user's explicit requirement text, explicit user clarifications, user-confirmed acceptance criteria, and
  final-step choice as locked constraints. Do not invent non-goals, affected surfaces, or implementation limits on the
  user's behalf.
- Before starting the next workflow step, verify the current step actually completed with the expected output from the
  required participant(s). If a participant replied with something other than what was requested, report it to the user
  and ask how to proceed.
- For accord steps, an in-progress accord is not a wrong reply. If the facilitator says accord is still running, pending,
  or waiting on another participant, wait for completion instead of treating it as failure.
- If interrupted or resumed, read the latest chat context and continue from the last completed stage.
- At the end of the workflow, the final user-facing closeout must be a short status posted at the end of the main
  timeline, not only inside a nested thread. If the current reply would stay inside a workflow/participant-request
  thread, post a separate main-timeline closeout with the app-managed send-message tool when available.

## Plan Invalidation Handling

If implementation, QA, review, or fixes reveal that the approved plan is wrong or incomplete, decide whether User input
is actually needed:

- If the correction requires more or different code but preserves all user-visible behavior, including existing behavior
  outside the originally stated acceptance criteria, UX, data semantics, and external effects, do not pause for User.
  Treat any reasonably affected existing user-visible workflow as a regression acceptance criterion that needs real PASS
  evidence. Return to the implementation-plan accord stage so Drew and Taylor revise the plan resolution (the accord artifact), then continue
  the workflow from the appropriate implementation or fix step.
- Pause and ask User when the correction would affect any user-visible behavior, including existing behavior in adjacent
  or unrelated flows, acceptance criteria, UX, product decisions, data semantics, destructive migration, irreversible
  external action, or scope expansion that causes one of those effects. Larger internal implementation work alone is not
  a User gate.

## Main-Timeline Idle Status

Whenever all assigned participant work is complete and the workflow cannot make further progress without User input,
leave the main timeline with a short status message as the latest visible message. This applies before the final workflow
step is complete and is separate from the final closeout.

The idle status must include:

- current workflow stage;
- last completed artifact or review result;
- whether any participant work is still running;
- the exact User decision needed;
- what happens after the likely choices.

If the manager is replying inside a nested workflow or participant-request thread, also post the same concise status to
the main timeline with the app-managed send-message tool when available.

## Main-Timeline User Choices

Post any User choice that can pause or unblock the workflow on the main timeline, not only inside a nested workflow or
participant-request thread. Do not leave a hidden pending choice card in a thread as the only unblock path.

This applies to requirement confirmation, final-step selection, release type selection, retry/continue decisions after
participant failure, and any user-owned clarification that blocks progress. If the current turn is inside a thread, post
the choice plus a concise status to the main timeline with the app-managed send-message tool when available.

If User clearly answers a pending choice in prose instead of through the choice card, treat the prose answer as the
choice and continue the workflow. Also leave the next status on the main timeline so stale hidden choice state is not the
latest visible workflow signal.

## Reference-Parity Gate

When the user says a new setting or flow should work "like", "same as", or "next to" an existing feature, that existing
feature is a locked reference.

Plans, accord resolutions, reviews, and QA must:

- identify the exact reference UI or behavior;
- copy its interaction model, labels, density, and persistence pattern unless the user explicitly approves a deviation;
- reject added warning cards, explanatory banners, new labels, or extra states not present in the reference.

Before final QA, verify the new UI beside the reference feature and answer: "Does this look and behave like the
referenced existing feature, with no invented UX?"

## Workflow

### 1. Relay And Confirm Requirement

Restate what the user actually said as a concise relay-ready requirement for Drew and Taylor. Include explicit references
the user gave, such as a design handoff path, screenshot, bug report, or pasted requirement. You may include concise
acceptance criteria as observable completion checks derived directly from the user's words or explicit references. Do not
add manager-authored scope, non-goals, affected surfaces, file lists, tests, or implementation constraints unless the user
explicitly stated them.

Polish imprecise user wording into standard product, design, or engineering terminology when the meaning is clear, while
preserving the user's intent. For example, translate "thin sidebar" to "left navigation rail" when describing app chrome.
If the wording could change meaning, ask the user instead of guessing.

If the user's request is clear enough to pass to Drew and Taylor, do not expand it. If a necessary user-owned decision is
missing or ambiguous, ask one concise clarification before continuing. If the user invokes the workflow immediately after
stating the requirement, treat that requirement as confirmed and continue to the final-step choice.

Ask on the main timeline:

```text
User choice:
T: Confirm Scope
Q: Is this the right implementation target?
O1: Confirm | Continue to independent Drew/Taylor plans.
O2: Revise | I will update the scope first.
R: O1
```

If the user has already clearly confirmed the requirement, continue. During subsequent steps, make sure other participants
follow the user's stated requirement and clarifications. If there is a good reason to revise it, stop flow and ask for
user approval; don't continue silently.

**Suggest and confirm the acceptance criteria — this is User-owned.** The manager proposes them and the User confirms;
never derive them silently, and never ask Drew or Taylor to decide them.

Derive a concise, testable list from the user's explicit requirement and references — each an observable, user-visible
completion check. Include, as regression criteria, every existing user-visible workflow the change could reasonably
affect that you can foresee now, so they are locked up front instead of discovered during QA. Keep each criterion
faithful to the user's intent; if one would introduce a decision the user did not state, ask instead of inventing it.

Post the proposed list on the main timeline and ask the User to confirm or edit it:

```text
User choice:
T: Confirm Acceptance Criteria
Q: Are these the acceptance criteria we verify live before merge?
O1: Confirm | Lock this list and continue.
O2: Revise | I will edit the criteria first.
R: O1
```

Once confirmed, the list is locked: the Step 4 plan resolution must carry it, and every live-QA and manager gate (Step 5
onward) verifies against it. If the User revises it, re-post the updated list and confirm again before continuing.

### 2. Confirm Final Step

After the user confirms requirements, ask what the workflow should do at the end:

```text
User choice:
T: Final Step
Q: What should happen after implementation is approved?
O1: Merge to main and push | Land the approved work.
O2: Make a release | Prepare the release with npm run release:[patch/minor/major].
O3: Open app instance | Open a separate app instance so you can check manually.
R: O3
```

The final-step choice must be visible on the main timeline. Before pausing for this choice, follow the Main-Timeline
Idle Status and Main-Timeline User Choices rules so the main timeline says progress is waiting on User's final-step
decision. Continue only after the user chooses one final step.

### 3. Post The Plan Assignment For Drew And Taylor To Get Familiar

Post the assignment for everyone to get familiar. Mention both drafters and quote the requirement and the User-locked
acceptance criteria exactly as the User gave them:

```text
@drew-codex-engineer @taylor-claude-engineer This is the assignment you will resolve via an accord with Drew as facilitator:

[user's stated feature/bug description and explicit references, without manager-added scope]

Confirmed acceptance criteria (User-locked), including affected existing-workflow regressions:
[the confirmed acceptance-criteria list]

Just get familiar — everything else is part of the accord flow.
```

Stop after posting. The accord runs in the next step.

### 4. Ask Drew To Run The Plan Accord With Taylor

Tell Drew to run the accord on the assignment above. Reference the get-familiar message so the accord's question stays
verbatim:

```text
@drew-codex-engineer run an /accord with Taylor to resolve the assignment above [#msg:<id of the get-familiar message>]. Use it verbatim as the question — do not rephrase, summarize, or add scope.
```

The accord must produce one **plan resolution** — captured as a signable artifact — carrying the confirmed
acceptance-criteria list (including the locked affected-existing-workflow regression criteria), final scope,
file-by-file changes, risks, tests, Electron QA when relevant, and unresolved questions. Note the resolution's
`#artifact:` link from the facilitator's closeout and reuse it in every later stage.

Do not proceed to next step until the plan resolution shows approved — the facilitator's closeout links it as
`#artifact:…`; open it and confirm its approval — or the user overrides. If Drew reports that accord is
still in progress, wait. Ping @drew-codex-engineer and ask him to finish accord only if he stopped or the request failed.

### 5. Ask Drew To Implement The Approved Plan In A Separate Worktree

To ask Drew to implement, respond as follows:

```text
@drew-codex-engineer implement the approved plan resolution (its `#artifact:` link from the accord) you agreed with Taylor on in a separate worktree and do QA with /electron-desktop-qa.

Real acceptance QA and fix loop are mandatory before reporting approval-ready:
- Verify every acceptance criterion through the live product using the real user-visible workflow, production code path, and actual integrations involved. Mocks, simulated events, fixtures, unit tests, typecheck, builds, source inspection, or merely launching/screenshotting the product are supporting checks, not acceptance evidence.
- Controllable failures — including network disconnect and worker/instance stop — must be forced live; they are not eligible for the simulation exception even if the state has already recovered, because it can be induced again. Deterministic simulation of a failure path is acceptance evidence only when live reproduction is technically unavailable (a genuine external outage you cannot induce, a hardware fault, or a race you cannot reliably trigger), not merely inconvenient or transiently recovered. Record why live reproduction was technically unavailable. Evidence recorded under this exception counts as acceptance evidence for that criterion at every manager gate.
- Treat any existing adjacent or unrelated user-visible workflow reasonably affected by the change as a regression acceptance criterion requiring real PASS evidence.
- For every acceptance criterion, perform the real end-to-end workflow; capture actions, environment, observed result, screenshots/logs/timestamps; mark PASS or FAIL.
- If any criterion fails, investigate root cause, implement the smallest correct fix within the agreed scope, add regression coverage, rebuild/relaunch as needed, and repeat the real acceptance workflow until it passes.
- Do not merely report ordinary bugs or ask whether to fix them. If the approved plan appears invalid or incomplete, report the root cause, the required plan change, whether the correction changes any user-visible behavior, including existing behavior in adjacent or unrelated flows, acceptance criteria, UX, data semantics, or external effects, and which affected existing workflows need regression acceptance evidence.
- Do not declare readiness until every acceptance criterion has directly observed PASS evidence.
- Include the final evidence table: Criterion | Real workflow performed | Evidence | Result.
```

Manager gate after Drew reports implementation complete: before asking for review, verify Drew's report includes focused
tests, `make typecheck`, relevant targeted tests, `make build`, and an acceptance-evidence table. The table must cover
every locked acceptance criterion and every reasonably affected existing user-visible workflow, use real user-visible
workflows and integrations, and contain only PASS results. If evidence is missing, stale, failed, incomplete, or
simulated outside the explicitly documented unforceable-failure exception, do not start review; send the work back to
Drew to complete the real acceptance QA and fix loop.

### 6. Post The Review Assignment For Drew And Taylor To Get Familiar

Post the review assignment for everyone to get familiar:

```text
@drew-codex-engineer @taylor-claude-engineer This is the assignment you will resolve via an accord with Drew as facilitator:

Review the whole implementation at [worktree path] against the locked acceptance criteria and the approved plan resolution [#artifact:…] and other decision locked by user that you are aware of; find bugs and regressions and agree the complete list of required corrections before merge.

Just get familiar — everything else is part of the accord flow.
```

Stop after posting. Resume when both reviews are in.

### 7. Ask Drew To Run The Required-Fix Accord With Taylor

Tell Drew to run the accord on the assignment above:

```text
@drew-codex-engineer run the accord with Taylor to resolve the assignment above [#msg:<id of the get-familiar message>]. Use it verbatim as the question — do not rephrase, summarize, or add scope.
```

Do not proceed to next step until the required-fix resolution shows approved (its `#artifact:` link from the facilitator's closeout). If Drew reports that accord is still in progress, wait.
Ping @drew-codex-engineer and ask him to finish accord only if he stopped or the request failed.

### 8. Ask Drew To Implement Fixes

To ask Drew to implement fixes, respond as follows:

```text
@drew-codex-engineer implement all agreed required fixes in the same worktree, update regression tests, rerun relevant verification, rerun every affected real acceptance workflow including affected existing user-visible workflows, and update the acceptance-evidence table
```

Manager gate after Drew reports fixes complete: verify the report includes updated regression coverage, relevant
verification, and fresh PASS evidence for every real acceptance workflow and existing user-visible workflow that could be
affected by the fixes. Do not skip this gate merely because UI files did not change. If evidence is missing, stale,
failed, or incomplete, send the work back to Drew before asking Taylor for final review.

### 9. Ask Taylor To Review Again And Confirm Implementation Is Ready For Main

To ask Taylor for final review, respond as follows:

```text
@taylor-claude-engineer review the full implementation diff again, not only the agreed fixes: check the whole worktree diff against the locked scope, the locked acceptance criteria, and the approved plan resolution (its `#artifact:` link), audit the latest acceptance-evidence table, look for regressions introduced by the fix round, and confirm implementation is ready for main
```

Manager gate after Taylor's final review: continue only if Taylor explicitly audited the latest acceptance-evidence table,
including affected existing user-visible workflows, and approved readiness. If Taylor reports missing, stale, failed, or
incomplete evidence, or simulated evidence other than the allowed unforceable-failure-path fault injection, or otherwise
does not approve, return to the required-fix accord stage.

### 10. Execute Final Step

Manager gate before executing any final step: recheck the latest acceptance-evidence table yourself. Do not open the
final app instance, merge, push, or release unless every locked acceptance criterion and every reasonably affected
existing user-visible workflow has direct real-workflow PASS evidence, or, for a criterion whose failure cannot be forced
live, the recorded unforceable-failure-path evidence.

If the selected final step is `Open app instance`, ask Drew:

```text
@drew-codex-engineer open separate app instance for me with distinct window name so I could check
```

The instance should use an isolated profile and report the worktree path, branch, window title, and debug port if
relevant. Pause until the user accepts or reports issues.

If the selected final step is `Merge to main and push`, ask Drew:

```text
@drew-codex-engineer merge the approved work to main and push
```

If the selected final step is `Make a release`, the release type must be explicit from the user. If the user has not
chosen `patch`, `minor`, or `major`, ask on the main timeline before assigning the release. Then ask Drew:

```text
@drew-codex-engineer release new version with the implemented work with `npm run release:[patch/minor/major chosen by User]`
```

### 11. Report Status

When Drew finishes the final step, report the status to the user as a short main-timeline closeout.

Include:

- Final outcome and landed artifact, such as commit, branch, PR, release, or app instance details.
- A short summary of what was implemented.
- Key verification results.
- Implicit decisions made while working, especially choices not explicitly selected by the user but agreed during
  planning, accord, implementation, review, or fixes.
- Any residual risk or follow-up that remains.

Keep this closeout concise. Do not bury it only in the final workflow thread.

## Failure Handling

- If a participant request is pending approval or running, stop and wait for app resume.
- If one participant fails during their assigned task, tell the user on the main timeline and ask
  whether to retry or what to do next.
- If the user sends new requirements mid-run, update the state and choose the right restart point: scope confirmation,
  plan accord, or fix-list accord.
