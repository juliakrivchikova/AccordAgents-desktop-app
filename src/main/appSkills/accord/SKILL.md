---
name: accord
visibility: public
description: >
  Facilitate a skeptical multi-participant AccordAgents discussion that ends in
  one canonical resolution approved by every selected participant. Use only when
  User explicitly wants an accord, multi-participant consensus, cross-checking by
  named participants, or a resolution approved by multiple agents. Do not use for
  an ordinary single-agent answer, review, double-check, or "what do you think".
---

# Accord

Use this skill to lead a bounded, skeptical discussion between current
AccordAgents chat participants and produce one canonical resolution.

Use it only when User explicitly wants an accord: multi-participant consensus,
cross-checking by named participants, combined findings, or a plan/decision
approved by every involved participant. Do not use it for an ordinary
single-agent answer, a normal review, a "double-check", or a "what do you think"
question. When in doubt about whether User wants multiple participants involved,
ask before starting.

## Core Rule

Approval authority is the `✅` reactor set on the canonical message. Consensus is
reached only when:

- You have skeptically reviewed and approved the final resolution yourself.
- You published one canonical resolution message with `app_chat_send_message`.
- You added your own `✅` reaction to that canonical message.
- Every selected participant read that exact canonical message (by its
  `messageId`).
- The canonical message's `metadata.reactions["✅"]` includes you and every
  selected participant actor.
- No selected participant has an unresolved objection or correction outstanding
  against that exact message.

Approval is determined by the `✅` reactor identity on the canonical message, not
by any exact reply text. A participant's text reply is only a signal: it can
raise an objection/correction, but it is not required as a second approval step.
Do not claim consensus from prose alone, and do not require any participant to
type an exact phrase.

## Participant Selection

In this skill, "selected participants" means the other chat participants the
facilitator requests input from. It does not include the facilitator.

If User explicitly names participants, use those participants.

If User does not explicitly name participants:

1. Call `app_chat_get_participants`.
2. Read the active thread and relevant recent context with
   `app_chat_read_messages`.
3. Suggest candidate participants based on role fit, relevant expertise,
   provider diversity, and the question being discussed.
4. Ask User to approve or correct the participant set.
5. Do not call `app_chat_request_participants` until User explicitly approves.

After you emit the participant-selection choice, STOP your turn. Do not request
participants, infer participants, or address other participants in the same turn.
End the turn with only the choice and wait for User's selection. Resume the accord
flow on your next turn after User has chosen.

When asking User to approve suggested participants, emit the app's normal
user-choice card with: title `Accord participants`; question `Which participants
should join this accord discussion?`; a recommended option to use the suggested
set; an alternate option for User to name participants manually.

Only emit a real user-choice block when you are actually asking User to choose.
Never quote a user-choice example, template, or this skill's wording as ordinary
chat output. If you are explaining rather than asking, describe it in prose.

Do not silently choose participants when User did not name them.

Do not force a specific number of participants. A single
`app_chat_request_participants` call can target at most 4 selected participants;
if User explicitly wants more, handle them in sequential batches while preserving
the same canonical approval process, and stay within the participant-request rate
limits (do not issue more than 8 participant requests per minute).

## Workflow

1. Understand User's original question, artifact, proposal, or review target.
2. Formulate your own initial suggestion or findings as facilitator input.
3. Select participants using the participant selection rules.
4. Ask selected participants for independent skeptical review.
5. Merge your facilitator suggestion and participant replies into a candidate
   resolution.
6. Include reasoning for any concern that was reframed, rejected, or resolved by
   User choice.
7. Review the candidate yourself skeptically.
8. If corrections are needed, revise before publishing.
9. Publish one canonical resolution message as a reply to User's original
   request using `app_chat_send_message`. It returns the `messageId` and
   `sequence`; the message is immediately visible to you for the rest of this
   turn.
10. Add your own `✅` reaction to the canonical message using `app_chat_react`.
11. Ask selected participants to read and approve that exact canonical message by
    `messageId`.
12. If a participant objects, run one focused follow-up round for that disputed
    item (see Disputed Dispositions). Revise and publish a new canonical message
    when warranted, or ask User for any User-owned decision.
13. Verify approval by reading the canonical message and checking its `✅`
    reactor set.
14. Report consensus only after verification, or clearly report that consensus
    was not reached.

## Facilitator Initial Suggestion

Before asking other participants, formulate your own concrete suggestion,
finding list, plan, or decision. Treat it as one participant-quality input to
the final resolution, not as a neutral transcript summary.

To preserve independent review, do not use your draft to bias selected
participants unless User explicitly asked everyone to review that draft.
Normally ask participants to review the original question/artifact first, then
merge their answers with your own suggestion.

When merging, include your suggestion only where it survives the same skeptical
standard applied to other participant input.

## Independent Review Prompt

Ask participants to be skeptical and independent:

```text
Review this independently. Do not agree by default.

Question/artifact:
...

Look for blockers, incorrect assumptions, missing edge cases, hidden
requirements, simpler alternatives, and verification gaps.

<task-specific instruction>

If you have a concern, reply with the concrete missing concern, correction, or
risk. If you have no concerns, say so plainly.

Reply directly here with your findings. Your reply is shared with everyone
automatically — do not repost it as a separate message.
```

Replace `<task-specific instruction>` with the relevant instruction for the
actual task. Do not include irrelevant task branches in the prompt.

Examples:

- Implementation plan: `Return concrete plan corrections, missing steps,
  edge cases, risk areas, or verification gaps.`
- Code review: `Return findings with severity, file/line when available,
  evidence, and the concrete fix.`
- Technical decision: `Return incorrect assumptions, trade-off gaps, simpler
  alternatives, and decision risks.`
- Bug fix: `Return likely root-cause gaps, repro assumptions, missed failure
  modes, regression risks, and verification needed to prove the fix.`
- Architecture/API change: `Return contract ambiguities, ownership/data-flow
  gaps, migration risks, compatibility concerns, and simpler alternatives.`
- UI/design change: `Return interaction gaps, unclear states, accessibility
  concerns, visual hierarchy issues, and edge cases across screen sizes.`
- Test plan: `Return missing coverage for happy paths, edge cases, failure
  modes, concurrency/stale state, and manual verification gaps.`
- Documentation/spec: `Return ambiguous requirements, missing user flows,
  unstated assumptions, inconsistent terminology, and examples that should be
  added.`

## Merge Rules

- Preserve every substantive concern until it is incorporated, reframed with
  visible reasoning, rejected with visible reasoning, or resolved by User
  choice.
- Do not drop an item because it is inconvenient or not approved yet.
- Deduplicate overlapping findings, but keep attribution when useful.
- Separate User-owned decisions from technical disagreements.
- For code review, order findings by severity and include evidence.
- For plans, include implementation steps, edge cases, failure modes, and
  verification.
- If participants disagree, resolve the disagreement explicitly instead of
  choosing silently.
- Rejecting or reframing a participant concern is not a unilateral facilitator
  decision. It must be visible in `Reasoning / Dispositions` and approved by the
  participant through the canonical message approval flow.

## Reasoning / Dispositions

Accepted participant concerns should be incorporated directly into the
resolution. Do not list accepted concerns separately just to say they were
accepted.

The canonical resolution must include a `Reasoning / Dispositions` section only
when a participant concern was reframed, rejected, or resolved by User choice.

For each such concern, include:

- raised by: participant name (no `@`)
- original concern: the concern as stated
- disposition: reframed / rejected / resolved by User choice
- reasoning: why this disposition is correct
- impact: how the final resolution changed, or why it did not change

Disposition meanings:

- reframed: the concern is valid, but the final resolution uses a different
  formulation, scope, or fix than the participant originally proposed
- rejected: the concern is incorrect, out of scope, already covered, or not
  worth the added complexity, with concrete reasoning
- resolved by User choice: the concern depended on User-owned preference,
  requirement, scope, priority, or risk tolerance, and User chose a path

Participant approval of the canonical message means approval of both the final
resolution and every entry in `Reasoning / Dispositions`.

Do not include unresolved objections in an approved canonical resolution. If a
selected participant still rejects a disposition or keeps an objection, there is
no accord yet.

## User-Owned Decisions

If a concern depends on User-owned preference, requirement, scope, priority, or
risk tolerance, pause and ask User with the app's user-choice format before
publishing the canonical resolution.

Do not hide User-owned decisions inside the resolution as "deferred to User."

After User answers:

- incorporate the decision into the resolution
- if relevant, include a `resolved by User choice` entry in
  `Reasoning / Dispositions`
- continue the accord approval flow

If User does not answer or explicitly declines to decide, report consensus not
reached or blocked on User decision.

## Disputed Dispositions

If the canonical message reframes or rejects a participant concern, that
disposition must be visible in `Reasoning / Dispositions`.

During approval, the participant either approves that disposition by reacting
`✅` to the canonical message or objects.

If the participant objects, run exactly one focused follow-up round for that
disputed item:

```text
You did not approve this disposition in the canonical resolution.

Original concern from the participant (use plain name, no `@`):
...

Current disposition:
reframed / rejected

Facilitator reasoning:
...

Current impact on the resolution:
...

What is the smallest concrete correction, evidence, or condition that would make
this acceptable?
```

Outcomes after that single focused round:

- If the participant accepts the disposition, continue approval.
- If the participant provides a valid correction, revise and publish a new
  canonical message, then run a fresh approval round on the new message.
- If the issue depends on User-owned criteria, ask User with the user-choice
  format.
- If the participant still rejects the disposition and no User-owned decision can
  resolve it, stop and report consensus not reached for that version. Do not loop
  the same disputed item more than once without new input.

## Facilitator Self-Review

Before publishing any canonical resolution, review it yourself skeptically.

Check:

- every participant concern is included, resolved, or explicitly addressed in
  `Reasoning / Dispositions`
- no edge case or verification gap was dropped
- the resolution answers User's original request
- the plan or findings are concrete enough to act on
- User-owned decisions are not silently decided by agents
- the final text is the exact version you are willing to approve

Only publish after you personally agree the resolution is exhaustive and
correct.

## Publish Canonical Resolution

Publish the candidate/final resolution as a reply to User's original request, in
User's original thread. The publish step returns the new message's id, and the
message is visible to you immediately. That returned id is the canonical approval
target.

Immediately add your own `✅` reaction to that message. If reacting is ever denied
because the message is not yet visible, re-read it by its id and retry once; if it
still fails, stop and report that you could not attach your approval reaction.

### Referencing the canonical message

Whenever you mention the canonical message in text User will see (the approval
request, the final consensus line, follow-ups), reference it as a link instead of
pasting the raw id. Write a short label and the id like this:

```text
[the resolution](#msg:CANONICAL_MESSAGE_ID)
```

The app renders that as a clickable link that scrolls to the message. The link is
the only reference anyone needs: the reviewer can react directly to the linked
message. Never write a raw message id anywhere in a message User reads, not even in
parentheses or as "message id ...", and never paste JSON or tool names. The link
alone, nothing else.

## Approval Round Prompt

Ask every selected participant to approve the same canonical message. Reference it
with the message link so the request reads cleanly:

```text
Please review the canonical resolution: [the resolution](#msg:CANONICAL_MESSAGE_ID).
This is the only version under approval.

Stay skeptical. Do not accept the facilitator's reasoning by default. Double check
the resolution, the Reasoning / Dispositions section, and whether your original
concerns were preserved or correctly resolved.

If you approve it as complete, add a ✅ reaction to it. If you do not approve, do
not react; reply with the concrete missing concern, correction, or disputed
disposition.

Reply directly here if you have concerns. Your reply reaches everyone
automatically — do not repost it as a separate message.
```

If a participant objects, continue with the single focused follow-up in Disputed
Dispositions. Ask User with the user-choice format if the issue depends on
User-owned criteria. When warranted, revise the resolution, publish a new
canonical message, add your own `✅`, and ask participants to approve the new
message. Older approvals do not count for the new message.

## Approval Verification

After you request approval, read every selected participant's reply with
`app_chat_read_messages` — not only their reactions. A participant may raise a
concern, correction, or caveat in a reply without reacting. Any such reply is a
non-approval: address it before claiming consensus, even if other reactions are
present.

If a participant's reply corrects or disputes the resolution, do not re-ask them
to approve the same version. Revise the resolution, publish a new canonical
message, add your own `✅`, and run a fresh approval round on the new message.
Never request a reaction again on a version a participant has corrected.

Before claiming consensus, call `app_chat_read_messages` with the canonical
`messageId` and inspect `metadata.reactions["✅"]`.

Approval is complete only when the `✅` reactors include:

- your participant actor
- every selected participant actor

Use reactor identity, not only the reaction count. A count can be misleading if
User or an unrelated participant reacted.

## Resume Semantics

A turn can end before the accord is complete (for example,
`app_chat_request_participants` returns `pending_approval` or `running`, or the
run is interrupted). When you are invoked again for the same accord, do not
blindly republish or re-request participants. First:

1. Read the original thread with `app_chat_read_messages`.
2. Identify the latest canonical accord candidate message, if one exists, and
   read it by `messageId`.
3. Check its `✅` reactor set and any participant replies posted since that
   message.
4. Resume from the first incomplete step: publish, self-approve, request
   approvals, focused follow-up, User choice, or verification.

## Final Output

If consensus is reached, reply briefly with the message link (not a raw id):

```text
Consensus: approved by facilitator, a, b, c on [the resolution](#msg:CANONICAL_MESSAGE_ID).
```

Do not repeat the full resolution if the canonical message already contains it,
unless User asks for a copy.

"Consensus: not reached" is a final outcome only. Report it only after the single
focused follow-up is exhausted. Never report it while the accord is still in
progress, and never publish a new canonical message in the same turn after
reporting it. If approval is simply still pending, say so instead (a short waiting
status), not "not reached".

If consensus is not reached after the focused follow-up, reply with:

```text
Consensus: not reached.

Agreed:
...

Blocking issue:
...

Remaining objection:
- <participant>: ...

User decision needed:
...
```

## Tool Rules

- Use `app_chat_get_participants` for roster discovery.
- Use `app_chat_read_messages` to inspect context, and to read the exact
  canonical message by `messageId` (including its `metadata.reactions`).
- Use `app_chat_request_participants` for participant answers.
- Use `app_chat_send_message` to publish the canonical resolution; reuse its
  returned `messageId` as the approval target.
- Use `app_chat_react` to add your own `✅` to the canonical message.
- Do not rely on plain `@mentions` when another participant is expected to
  answer.
- Do not put `@handle` mentions in any accord message you send. You reach
  participants only through the participant-request flow, so an `@handle` in your
  message text is unnecessary and can trigger an unintended extra participant run.
  Refer to participants by plain name without the `@` (e.g. `peer`, `the
  reviewer`, `Drew`), including in review requests, approval requests, and the
  final consensus line.
- If `app_chat_request_participants` returns `pending_approval`, end with:
  `Participant request is awaiting User approval.`
- If it returns `running`, end with one short waiting status.
- Do not repeatedly poll request status in the same turn.
- Do not ask participants to decide User-owned requirements.
