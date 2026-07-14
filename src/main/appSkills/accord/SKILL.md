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

## Core Rules — independent drafts first; approval = current signatures

Before anyone sees another participant's proposal, every Accord author must submit
one frozen, attributable draft to the same collecting artifact. You (the
facilitator) submit first, before requesting participants. Each selected
participant submits independently. Draft bodies are not chat content: User can
always read every draft; you can read every participant draft because each
participant explicitly includes you in its audience; peers cannot read one
another's drafts. Public chat may say that a draft was submitted, but must never
contain draft content, snippets, readers, or summaries.

After all required drafts are frozen, publish canonical `v1` by synthesizing them
and recording every required current draft as a considered source. Draft
authorship is provenance, never approval and never a signature. The published
resolution's `requiredSigners` are you and every selected participant. Consensus
is reached only when
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

classify → select → create collection → facilitator draft → blind participant
drafts → synthesize/publish v1 → sign → verify (→ resume if interrupted). Match
the resolution's size to the decision; never skip independent draft submission.

1. **Classify.** Decide how much analysis and how many correction rounds the
   question needs. Concrete/bounded decisions may produce short drafts, but they
   still use the same independent-draft, publication, and signature mechanism.
2. **Select participants** (see Participant Selection).
3. **Create the collection.** Create exactly one artifact with
   `initialState: "collecting_drafts"`. Its allowed and required draft authors are
   you plus every selected participant. Audience policy is explicit per author:
   your allowed/required readers are empty; every participant's allowed and
   required readers contain only you. User and each draft author are implicit
   readers. Use `accord:<chatThreadRootId>:create` as the stable operation id.
   Do not set required signers yet. Do not create a second resolution artifact on
   retry or resume. Immediately read the collecting artifact back and assert the
   normalized audience policy before any participant request: your policy has no
   explicit readers, and every selected participant's allowed and required reader
   lists contain exactly you. If any selected participant can read another
   participant's draft, stop and correct the roster policy first.
4. **Submit your facilitator draft first.** Before asking any participant,
   formulate your own concrete independent resolution. Save it with no explicit
   readers, then submit/freeze it. Use stable operation ids derived from the root,
   such as `accord:<chatThreadRootId>:draft:<facilitator>:save:1` and
   `accord:<chatThreadRootId>:draft:<facilitator>:submit`. Verify your draft is
   `submitted`. Never paste or summarize its body in chat.
5. **Collect blind participant drafts.** Only after Step 4 is durable, request
   each selected participant using the Independent Draft Prompt. Each participant
   must save and submit one proposal whose only explicit reader is you. A response
   containing prose without a frozen draft is incomplete. After replies, read the
   artifact's durable draft state and verify one current submitted draft for every
   required author. Do not treat chat replies as proposal storage. Do not publish
   early.
6. **Synthesize and publish v1.** Read all submitted drafts through the artifact
   service. Merge your facilitator input and the participant proposals into one
   candidate; keep every substantive concern until it is
   incorporated, or reframed/rejected/User-resolved with visible reasoning (see
   Reasoning / Dispositions); separate User-owned decisions from technical ones.
   Self-review skeptically, then publish canonical v1 on that same artifact with
   `requiredSigners` = you + selected participants. The source manifest must list
   every current required draft as `considered`; do not imply signatures. Use
   `accord:<chatThreadRootId>:publish:v1` as the stable operation id. On every
   later correction, revise that same published artifact: revision preserves the
   signer set and starts a new unsigned version. Never recreate it and never
   restart independent draft collection merely because a signing concern caused
   a revision.

   Before publishing, inspect every current submitted draft and assert its actual
   `effectiveReaders` set: your facilitator draft is readable by exactly User and
   you; each participant draft is readable by exactly User, its author, and you.
   If any peer participant appears, or any expected reader is absent, stop and
   correct the draft/roster state before synthesis. Policy intent alone is not
   sufficient evidence of blind collection.

   Changing the selected-participant set is User-approved. While collecting,
   update the roster and audience policy with the current roster revision, then
   collect any newly required independent draft before publication. After
   publication, the order matters: (a) get User approval; (b)
   `app_artifact_revise` first, producing a fresh unsigned version; (c) then
   `app_artifact_set_access`; (d) verify the signer set and unsigned state; (e)
   request a focused independent assessment from a newly added participant; (f)
   rerun the full sign round.
7. **Sign.** Sign the current version yourself, then ask each selected participant
   to read the published artifact and sign it (see Approval Prompt).
8. **Verify.** `app_artifact_read` and confirm `approval.state === "approved"` and
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

Independent draft submission:

```text
Create your own independent proposal before seeing anyone else's. Do not agree by
default and do not ask for another proposal.

Question/artifact:
...

Submit your complete proposal as a draft on [the collecting
resolution](#artifact:ARTIFACT_ID). Share its content only with the facilitator;
User and you already have implicit access. Save, then submit/freeze it. Use stable
retry keys derived from this request's chat-thread root so a resumed request does
not create a duplicate.

Your chat reply is public metadata only. Say that the draft was submitted, or
report a blocking error. Do not include its content, snippets, readers, summary,
or conclusions in chat.
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
the run is interrupted). On re-entry, do not blindly recreate, resave, resubmit,
publish, or re-request. Read the original/request threads and request status, then
read the resolution artifact:

- `collecting_drafts`: roster, current submitted drafts, and missing required
  authors are the source of truth. Resume from the first incomplete author. A
  submitted facilitator draft means participant requests may begin. Stable
  operation ids make lost responses safe to retry.
- `published`: v1 and its source manifest are the source of truth that synthesis
  completed. `signedCurrent` is the source of truth for current approvals; the
  request thread carries unresolved signing replies.

Artifact versions have no chat-sequence boundary — do not look for replies "since
a version". Revise the published artifact when the resolution must change.

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
- First round: `app_artifact_create` with `collecting_drafts` creates the durable
  inbox; draft save/submit tools create attributable frozen proposals;
  `app_artifact_draft_read` enforces content audiences; `app_artifact_publish`
  atomically creates v1, its source manifest, and required signers only after all
  required drafts are submitted.
- Later rounds: `app_artifact_revise` starts a new unsigned version and preserves
  the signer set. `app_artifact_set_access` changes signers only after a fresh
  revise for a User-approved participant change. `app_artifact_sign` signs the
  current version. `app_artifact_read` / `app_artifact_diff` verify approval and
  compare published versions.
- Reach participants only through the participant-request flow: do not rely on
  plain `@mentions`, and put no `@handle` in any accord message (it can trigger an
  unintended extra run) — refer to participants by plain name.
- If a request returns `pending_approval`, end with exactly:
  `Participant request is awaiting User approval.` If it returns `running`, end
  with one short waiting status. Do not poll request status repeatedly in a turn.
