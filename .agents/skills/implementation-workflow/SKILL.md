---
name: implementation-workflow
description: Coordinate a reusable multi-agent implementation workflow for feature or bug delivery. Use when the user wants a manager participant to understand a requirement, confirm scope, ask Drew and Taylor for independent implementation plans, drive accord, delegate implementation in a separate worktree, require Electron desktop QA when relevant, collect reviews, coordinate fixes, optionally open a user-check instance, and prepare delivery to main.
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

Ask:

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

Before pausing for this choice, follow the Main-Timeline Idle Status rule so the main timeline says progress is waiting
on User's final-step decision. Continue only after the user chooses one final step.

### 3. Ask Both Drew And Taylor To Prepare Implementation Plan

To ask both Drew and Taylor to prepare implementation plans, respond as follows:

```text
@drew-codex-engineer @taylor-claude-engineer we need to [implement new feature/fix bug]:

[user's stated feature/bug description and explicit references, without manager-added scope]

prepare exact implementation plan independently, add plan for QA verification steps and full test coverage
```

Stop after assigning. Resume when both plans are done and continue with the next step.

Before continuing, inspect both replies. Continue only if each reply is an implementation plan with concrete approach,
code/file changes, QA verification, and test coverage. If either reply says the work is already implemented instead of
providing a plan, or otherwise answers the wrong stage, report that to the user and ask how to proceed. Do not start
accord or implementation from incomplete or wrong-stage plan replies.

### 4. Ask Drew To Come To Accord With Taylor

To ask Drew to come to accord with Taylor, respond as follows:

```text
@drew-codex-engineer have an /accord on exact implementation plan with Taylor
```

The accord must produce one canonical plan with final scope, file-by-file changes, risks, tests, Electron QA when
relevant, and unresolved questions.

Do not proceed to next step until the canonical plan is approved or the user overrides. If Drew reports that accord is
still in progress, wait. Ping @drew-codex-engineer and ask him to finish accord only if he stopped or the request failed.

### 5. Ask Drew To Implement The Approved Plan In A Separate Worktree

To ask Drew to implement, respond as follows:

```text
@drew-codex-engineer implement the plan you agreed with Taylor on in a separate worktree and do QA with /electron-desktop-qa
```

Require focused tests while developing, then `make typecheck`, relevant targeted tests, `make build`, and
`/electron-desktop-qa` for Electron UI changes.

### 6. Ask Both To Review

To ask for review, respond as follows:

```text
@drew-codex-engineer, @taylor-claude-engineer review the whole implementation [worktree path] independently, run focused subagents if needed to find bugs and regressions
```

Stop after assigning. Resume when both reviews are in.

### 7. Ask Drew To Come To Accord With Taylor On Full List For Required Fixes Before Merge

To ask Drew to come to accord with Taylor on required fixes, respond as follows:

```text
@drew-codex-engineer Based on what was locked during planning part, by user explicitly and review findings, have an /accord with Taylor regarding the complete list of required corrections before merge
```

Do not proceed to next step until the canonical list is approved. If Drew reports that accord is still in progress, wait.
Ping @drew-codex-engineer and ask him to finish accord only if he stopped or the request failed.

### 8. Ask Drew To Implement Fixes

To ask Drew to implement fixes, respond as follows:

```text
@drew-codex-engineer implement all agreed required fixes in the same worktree, update regression tests, rerun relevant verification, and rerun Electron QA if UI changed
```

### 9. Ask Taylor To Review Again And Confirm Implementation Is Ready For Main

To ask Taylor for final review, respond as follows:

```text
@taylor-claude-engineer review the full implementation diff again, not only the agreed fixes: check the whole worktree diff against the locked scope and canonical plan, look for regressions introduced by the fix round, and confirm implementation is ready for main
```

If Taylor does not approve, return to the required-fix accord stage.

### 10. Execute Final Step

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
chosen `patch`, `minor`, or `major`, ask before assigning the release. Then ask Drew:

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
- If one participant fails during independent plan/review, tell the user and ask whether to retry or continue with one
  answer.
- If the user sends new requirements mid-run, update the state and choose the right restart point: scope confirmation,
  plan accord, or fix-list accord.
