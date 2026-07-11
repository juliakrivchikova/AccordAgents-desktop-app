---
name: accord
visibility: public
description: >
  Facilitate a skeptical multi-member AccordAgents discussion that ends in
  one agreed resolution approved by every selected member. Use only when
  User explicitly wants an accord, multi-member consensus, cross-checking by
  named members, or a resolution approved by multiple agents. Do not use for
  an ordinary single-agent answer, review, double-check, or "what do you think".
---

# Accord

Lead a bounded, skeptical discussion among current chat participants that ends in
one agreed resolution, captured as a signable **artifact**.

Use only when User explicitly wants an accord: multi-participant consensus,
cross-checking, combined findings, or a plan/decision approved by every involved
participant. Not for an ordinary answer, a normal review, a "double-check", or a
"what do you think". When unsure whether User wants multiple participants, ask
first.

## Core Rule — approval = signatures on the current version

The resolution is one artifact whose `requiredSigners` are you (the facilitator)
and every selected participant. Consensus is reached only when
`approval.state === "approved"` — every required signer has signed the **current**
version — you have signed it too, and no selected participant has an open
objection against that version. Approval is signature identity on the current
version, never reply prose: a reply can raise a concern but is not a second
approval step, and a concern raised in a reply without signing is a non-approval.

**Signature/version semantics (stated once):** `app_artifact_revise` creates a new
version that starts **unsigned**; signatures on earlier versions stay in history
but no longer count. So any edit invalidates stale approvals and forces a fresh
sign round — the artifact tracks "who approved the current version" for you.

## State machine

classify → select → review → create/revise → sign → verify (→ resume if
interrupted). Match ceremony to the decision; only the number of rounds and the
resolution's size scale, never the mechanism.

1. **Classify.** Open/architectural (several valid approaches, real trade-offs, a
   plan to design) → full flow. Concrete/bounded (a specific fix or single named
   decision where the proposal *is* the change) → collapsed path, allowed only
   when ALL hold: complete and directly reviewable; low-risk; touches no security,
   permissions, persistence, concurrency, deletion, billing, or external side
   effect; no User-owned decision or open concern. If any is unclear, use the full
   flow.
2. **Select participants** (see Participant Selection).
3. **Review.** Full flow: ask each selected participant for independent skeptical
   review of the original question/artifact — do not bias them with your own draft
   unless User asked everyone to review it. Collapsed path: skip this independent
   review round; participants review the candidate resolution directly in the
   Step 5 sign round.
4. **Create/revise the resolution.** Merge your own facilitator input and the
   replies into one candidate; keep every substantive concern until it is
   incorporated, or reframed/rejected/User-resolved with visible reasoning (see
   Reasoning / Dispositions); separate User-owned decisions from technical ones.
   Self-review skeptically before writing. On the **first** round, create the
   artifact with `app_artifact_create` and `requiredSigners` = you + the selected
   participants. On **every later** round — including a collapsed-path escalation —
   `app_artifact_revise` that same artifact: revise preserves the signer set and
   starts a new unsigned version, so never recreate it, never start a second
   resolution artifact, and never restart independent review.

   Changing the selected-participant set is a User-approved action, not a
   facilitator shortcut, and the order matters: `app_artifact_set_access` mutates
   `requiredSigners` on the current version *without* versioning or clearing
   signatures, so changing signers before revising can transiently mark a signed
   version approved (an observer could read consensus in that gap). Do it in this
   order: (a) get User approval; (b) `app_artifact_revise` **first**, producing a
   fresh unsigned version; (c) then `app_artifact_set_access` to the new signer
   set; (d) verify the current version is still unsigned and the signer set is
   exactly you + the selected participants; (e) give any newly added participant
   the Step 3 independent review (full flow); (f) rerun the full sign round.
5. **Sign.** Sign the current version yourself, then ask each selected participant
   to read the artifact and sign it (see Approval Prompt). On the collapsed path
   this sign round is also their first look at the candidate.
6. **Verify.** `app_artifact_read` and confirm `approval.state === "approved"` and
   `signedCurrent` covers you and every selected participant (identity, not count).
   Also read replies: address any concern raised without a signature before
   claiming consensus. If a reply corrects the resolution, do not re-ask for a
   signature on that version — revise and run a fresh sign round.

## Participant Selection

"Selected participants" are the participants you request input from — not you.

- If User named participants, use them. Otherwise: `app_chat_get_participants`,
  read relevant context, suggest a set by role fit / expertise / provider
  diversity, and ask User to approve or correct it. Do not
  `app_chat_request_participants` until User approves, and never silently choose.
- Ask with the app's user-choice card (title `Accord participants`; question
  `Which participants should join this accord discussion?`; a recommended option
  plus a "name them manually" option). Emit a real user-choice block only when
  actually asking — never quote a template as ordinary chat.
- After emitting the selection choice, STOP the turn: do not request or address
  participants in the same turn; resume next turn once User has chosen.
- One request targets ≤4 participants; batch more sequentially, and do not exceed
  8 participant requests per minute.

## Reasoning / Dispositions

Incorporate accepted concerns directly. Include a `Reasoning / Dispositions`
section in the resolution body **only** when a concern was reframed, rejected, or
resolved by User choice. Per such concern: raised by (plain name); original
concern; disposition (reframed / rejected / resolved by User choice); reasoning;
impact. A participant's signature approves both the resolution and its
dispositions. Never present a version for signing with an unresolved objection in
it; reframing or rejecting a concern is not unilateral — it must be visible and
signed off.

## User-Owned Decisions

If a concern depends on User-owned preference, requirement, scope, priority, or
risk tolerance, pause and ask User with the user-choice card before creating or
revising the resolution. Do not bury it as "deferred to User". After User answers,
incorporate it (add a `resolved by User choice` disposition if relevant) and
continue. If User declines to decide, report blocked on User decision. Never ask
participants to decide User-owned requirements.

## Disputed Dispositions

If a participant objects to a disposition, run **exactly one** focused follow-up
asking for the smallest concrete correction, evidence, or condition that would
make it acceptable. Then: accepts → they sign; valid correction → revise and run a
fresh sign round; User-owned → ask User; still rejects with no User decision → stop
and report consensus not reached for that version. Do not loop the same item twice
without new input.

## Prompts

Keep participant-facing prompts in plain language — no tool names, no raw ids, no
JSON. Reference the resolution as a link: `[the resolution](#artifact:ARTIFACT_ID)`
(it renders the current name and approval badge; that link is the only reference
anyone needs).

Independent review:

```text
Review this independently. Do not agree by default.

Question/artifact:
...

Look for blockers, wrong assumptions, missing edge cases, hidden requirements,
simpler alternatives, and verification gaps. <one task-specific line — e.g. plan
corrections and missing steps; code-review findings with severity and evidence;
decision trade-off gaps; bug repro/regression risks; API migration/compatibility;
UI states and accessibility; test coverage; or spec ambiguities.>

Reply with the concrete concern, correction, or risk, or say you have none. Your
reply is shared with everyone — do not repost it separately.
```

Approval round:

```text
Please review the resolution: [the resolution](#artifact:ARTIFACT_ID). This is the
only version under approval.

Stay skeptical — do not accept the reasoning by default. Read the artifact, check
the Reasoning / Dispositions, and whether your concerns were preserved or
correctly resolved. If you approve it as complete, sign the current version.
Otherwise do not sign — reply with the concrete concern or disputed disposition.
Your reply reaches everyone; do not repost it separately.
```

## Resume

A turn can end mid-accord (a request returns `pending_approval` or `running`, or
the run is interrupted). On re-entry, do not blindly recreate or re-request. Read
the original and approval-request threads and the request status, then
`app_artifact_read` the resolution. Its `signedCurrent` is the source of truth for
who approved the current version; the request thread carries unresolved replies.
Artifact versions have no chat-sequence boundary — do not look for replies "since a
version". Resume from the first incomplete step, revising the existing artifact
when the resolution must change.

## Final Output

Consensus reached — reply briefly with the link, not the full resolution (the
artifact holds it):

```text
Consensus: approved by facilitator, a, b, c on [the resolution](#artifact:ARTIFACT_ID).
```

"Consensus: not reached" is final — report it only after the single focused
follow-up is exhausted, never while still in progress. If approval is merely
pending, give a short waiting status instead. Not-reached format: Agreed /
Blocking issue / Remaining objection (per participant) / User decision needed.

## Tool Rules

- `app_chat_get_participants` — roster. `app_chat_read_messages` — context and
  replies. `app_chat_request_participants` — participant answers/approvals.
- `app_artifact_create` sets the resolution and its `requiredSigners` (first round
  only). `app_artifact_revise` starts a new unsigned version and preserves the
  signer set. `app_artifact_set_access` changes the signer set (only on a
  User-approved participant-set change); it does not version or clear signatures,
  so it must come *after* a `revise` that has already produced a fresh unsigned
  version — never before (see Step 4). `app_artifact_sign` signs the current
  version. `app_artifact_read` / `app_artifact_diff` verify `approval` and compare
  versions.
- Reach participants only through the participant-request flow: do not rely on
  plain `@mentions`, and put no `@handle` in any accord message (it can trigger an
  unintended extra run) — refer to participants by plain name.
- If a request returns `pending_approval`, end with exactly:
  `Participant request is awaiting User approval.` If it returns `running`, end
  with one short waiting status. Do not poll request status repeatedly in a turn.
