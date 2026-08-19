# Cloud Runs Workspace Parity

## Principle

Cloud Runs must preserve the workspace semantics users get from local AccordAgents runs.

If a scenario works locally with Codex or Claude in the selected project directory, the same scenario should work in Cloud Runs unless there is a documented, user-visible cloud-only constraint. Cloud execution can differ in transport, setup, and authentication, but it must not silently change how participants share, inspect, or modify project files.

This follows the dedicated CLI parity invariant: working with one participant through AccordAgents should feel like working with that agent through its regular CLI.

## Product Requirement

AccordAgents must not manage hidden per-participant or per-run project copies as the default cloud workspace model.

For a selected repository:

- Local participants run against the selected project/workspace.
- Cloud participants should run against the cloud mirror of that same selected project/workspace.
- The app may maintain a remote mirror for sync and persistence, but that mirror is the shared project workspace, not an invisible private copy per participant.
- Cloud participants must be able to create Git worktrees themselves, using the same Git operations they would use locally.
- Worktrees created by one cloud participant must be visible to other cloud participants on the same worker when the path is provided or discoverable.
- Uncommitted changes in a participant-created worktree must be reviewable by another cloud participant, the same way local participants can review another local worktree by path or diff.

## Worktree Model

Isolation is an agent workflow decision, not a hidden app behavior.

When a task needs isolation from the shared mirror state, the participant should be instructed to create a Git worktree explicitly, for example under a documented project worktrees directory on the worker. The participant should choose or receive a meaningful branch/worktree name, perform the work there, and report:

- worktree path
- branch name, if any
- whether changes are committed or uncommitted
- exact files changed

Other participants can then inspect that same worktree path for review, follow-up edits, or PR creation.

AccordAgents should not silently replace the participant's cwd with an automatically generated per-run clean checkout. That breaks local/cloud parity and makes uncommitted cross-participant review non-obvious or impossible from the user's point of view.

## Sync And Cleanup

Cloud sync must not delete remote Git state that may contain participant work.

Required behavior:

- Preserve `.git/worktrees/**` during mirror sync.
- Preserve participant-created worktree directories unless the user explicitly asks for cleanup or the app runs a clearly labeled maintenance action.
- Do not use `rsync --delete` or equivalent cleanup in a way that can wipe uncommitted remote worktrees.
- Do not hide cloud-created worktrees from later cloud participants.

If cleanup is needed for disk pressure, it must be explicit, scoped, and explain what will be deleted.

## Acceptance Criteria

Cloud workspace parity is satisfied only when these scenarios work:

- Claude cloud participant creates an uncommitted change in a Git worktree; Codex cloud participant can inspect and review that exact uncommitted change.
- Codex cloud participant creates an uncommitted change in a Git worktree; Claude cloud participant can inspect and review that exact uncommitted change.
- A participant can create a new Git worktree on the cloud worker using normal Git commands.
- The worktree remains available for another participant after the creating run completes.
- A participant can still create a clean branch/PR when instructed, without inheriting unrelated dirty state from the shared mirror.

The last case should be solved with correct task instructions and explicit worktree creation, not by AccordAgents automatically creating hidden per-run project copies.

## Reasoning

Hidden per-run copies solve dirty-state leakage, but they introduce a worse product mismatch:

- local AccordAgents does not copy the project directory per participant;
- users expect cloud participants to collaborate through the same workspace model as local participants;
- cross-participant review often requires reading uncommitted changes before a branch or PR exists;
- hidden app-created checkouts make it unclear where work lives and how another participant should inspect it.

The correct model is a shared cloud project mirror plus explicit, participant-created Git worktrees when isolation is needed.

## What the Mirror Copies

Decided by User on 2026-08-15, after a review flagged that `Certificates.p12` and `.env.local` had been synced to the AWS worker.

**The app does not decide what a cloud participant may see.** The mirror copies the working tree as-is, including files that hold secrets. This is intentional, not a defect.

The exclusions in `DEFAULT_MIRROR_EXCLUDES` (`src/main/services/remoteMirrorSync.ts`) exist only to keep heavy build and dependency directories out of the transfer. They are a performance rule, never a policy rule. Do not add secret-shaped filters (`*.p12`, `.env*`, `*.pem`, `*.key`) to that list.

Reasoning, which follows directly from the parity principle at the top of this document:

- Anything a local participant can read in the project, a cloud participant must also be able to read. A cloud agent that silently sees a different filesystem is exactly the kind of divergence a user would have to learn.
- An app-curated deny list is unbounded and unknowable. It will omit something a real task needs, and the resulting failure appears as an unexplained missing file rather than a stated constraint.
- Withholding a file is a decision about the user's own project. That decision belongs to the user, not to AccordAgents.

Consequence, stated so it is not discovered later: the worker holds the same secrets as the laptop, so **worker access control is what protects them.** SSH ingress is restricted to the caller's address, and that restriction is load-bearing rather than incidental. Treat worker reachability, key handling, and instance termination as security-relevant.

If secrets are found in a mirror during review, report it as expected behavior with a pointer to this section. Do not delete them and do not open it as a defect.

### Deferred: user-chosen sync contents

Wanted, not scheduled, and explicitly not critical as of 2026-08-15: a view showing what the sync will copy, letting the **User** include or exclude paths.

This does not contradict the rule above. The app never decides; the user may. Until that exists, the answer to "should this file go to the worker?" is always yes.
