# Built-In `/accord` Skill Plan

## Goal

Add a built-in app skill named `/accord` that lets one facilitator participant
lead a skeptical multi-participant discussion and produce one canonical
resolution approved by all selected participants.

The feature should support implementation plans, code review finding merges,
technical decisions, and other questions where User wants independent agent
opinions, double-checking, and an explicit shared resolution.

## Product Behavior

- User invokes `/accord` on a facilitator participant.
- If User explicitly names the participants to include, the facilitator uses
  that set.
- If User does not name participants, the facilitator inspects roster/context,
  suggests candidates, and asks User to approve or correct the set before
  requesting participant replies.
- The facilitator formulates its own initial suggestion or findings before
  requesting independent participant review.
- Participants independently review the question/artifact skeptically.
- The facilitator merges concerns, resolves disagreements, and self-reviews the
  candidate resolution.
- Reframed or rejected participant concerns are documented in a
  `Reasoning / Dispositions` section and approved through the same canonical
  message approval flow.
- User-owned decisions are asked with the app's user-choice flow before the
  canonical resolution is published.
- The facilitator publishes one canonical resolution message as a reply to
  User's original request.
- The canonical approval target is the immutable chat message version, identified
  by `messageId`. Reactions approve that exact message version; publishing a new
  resolution creates a new message, and reactions on older versions do not count.
- The facilitator adds its own `✅` reaction to that canonical message.
- Every selected participant must read that exact message and add `✅` to that
  same message before consensus is claimed.
- The facilitator verifies approval by reading the canonical message with
  `app_chat_read_messages` and checking `metadata.reactions["✅"]` for every
  required participant actor.
- If any participant objects, the facilitator continues focused discussion on
  the disputed item and publishes a new canonical message when the resolution
  changes. Reactions on older versions do not count.

## Implementation Plan

### 1. Add a Generic Chat Message MCP Tool

Add `app_chat_send_message` to the app MCP server.

Suggested request shape:

```json
{
  "content": "Message content",
  "threadId": "visible-thread-id",
  "parentMessageId": "optional-visible-parent-message-id",
  "chatThreadRootId": "optional-visible-root-message-id"
}
```

Suggested response shape:

```json
{
  "ok": true,
  "messageId": "created-message-id",
  "sequence": 123,
  "threadId": "thread-id"
}
```

Constraints:

- Tool is scoped to the current conversation from the issued MCP token.
- It must not accept arbitrary `conversationId`.
- It can post only into a visible thread/message scope for the active
  participant run.
- It should reject empty content.
- It should reject parent/root IDs outside the visible snapshot.
- It should create a normal `participant` message authored by the requesting
  participant.
- It should write through the `ChatService` mutation queue, not a stale
  conversation snapshot.
- It must not silently truncate content. The created chat message must preserve
  the exact `content` submitted by the tool. If a hard storage or transport
  ceiling ever applies, reject with an explicit error instead of shortening the
  message.
- It should enforce a per-run send limit.
- It should store message metadata indicating the app MCP/tool source.
- After appending the message, the send path must make the created message
  usable by the same requester in the same run. Because the `/accord` skill uses
  normal same-run `app_chat_read_messages` and `app_chat_react` after send, the
  implementation should update the requesting MCP actor/token
  `snapshotMaxSequence` to include the created message. An atomic send-plus-own
  `✅` helper may also exist, but it does not replace same-run read visibility
  when the skill needs to re-read the canonical message.
- It should be available to chat participants as a chat-context MCP tool, not
  administrator-only roster tooling.

Optional accord metadata for messages created by `/accord`:

```json
{
  "accordResolution": {
    "sourceMessageId": "original-user-message-id",
    "version": 1,
    "selectedParticipantIds": ["participant-id"],
    "requiredApproverIds": ["facilitator-id", "participant-id"],
    "supersedesMessageId": "optional-prior-canonical-message-id",
    "status": "candidate"
  }
}
```

This metadata is for verification/debugging. It is not a v1 app-native
orchestration engine.

Likely files:

- `src/main/services/appMcp.ts`
- `src/main/services/chat.ts`
- `src/shared/types.ts` if a shared request/response type is desired
- `src/main/services/chat.permissions.test.ts`

### 2. Keep Reaction Semantics

Current `app_chat_react` already supports this approval model:

- Reactions are keyed by actor.
- A participant can react to a visible message ID returned by
  `app_chat_read_messages`.
- `app_chat_read_messages` returns `metadata.reactions`, including each
  reactor's `actorId`, `actorLabel`, `actorKind`, and timestamp.
- Reactions reject messages newer than the participant's visible snapshot.

The new send-message tool is needed because the facilitator's normal final
response is appended only when the run ends, so approval participants cannot
react to that final response during the same `/accord` flow.

Approval authority:

- `✅` reactor identity on the canonical message is the approval signal.
- Text replies are used to detect objections, corrections, or caveats; they are
  not a second exact-string approval requirement.
- Verification must use reactor identity, not only reaction count.

Extend `app_chat_read_messages` with optional `messageId`:

- When `messageId` is supplied, return that exact message if it belongs to the
  current conversation and is visible to the actor snapshot.
- Include `metadata.reactions` in the returned message.
- Reject or omit invisible, wrong-conversation, or wrong-ID messages.
- Keep the existing thread/sequence pagination behavior for non-ID reads.

### 3. Add Public App-Owned Skills

Current app-owned bridge skills are synced into provider roots as
`accordagents-*` and hidden from slash discovery. `/accord` should be public and
slash-discoverable.

Add public app-skill support:

- internal skills remain hidden and keep generated names like
  `accordagents-app-chat-request`
- public skills can sync into collision-safe app-owned folders but preserve
  public frontmatter names, e.g. folder `accordagents-accord` with
  `name: accord`
- generated manifest entries and marker JSON must include visibility such as
  `"internal"` or `"public"`
- `UserSkillsService` must use manifest visibility when deciding whether to
  skip a generated folder; marker-only visibility is too late because the
  current generated-folder name gate runs before marker inspection
- `UserSkillsService` should hide only internal generated skills and expose
  public generated skills in slash search
- `renderCodexSkill` and `renderClaudeSkill` must preserve `name: accord` for
  public skills while keeping collision-safe generated folders; internal skills
  keep generated frontmatter names
- if a user-owned skill named `accord` already exists, app-owned `/accord` must
  not silently override it. Slash discovery should produce deterministic
  behavior, preferably a visible ambiguity/collision diagnostic or a clearly
  documented priority rule

Likely files:

- `src/main/services/appSkills.ts`
- `src/main/services/userSkills.ts`
- `src/main/services/appSkills.test.ts`
- `src/main/services/userSkills.test.ts`
- `src/main/appSkills/accord/SKILL.md`

### 4. Update Runtime Instructions for New Tool

Add `app_chat_send_message` to the chat MCP tool list and static participant
instructions so agents know:

- it posts a normal participant message in the current conversation
- it should be used for publishing canonical `/accord` resolution messages
- it returns the message ID and sequence for the created message
- the created message is visible to the requester in the same run
- the returned message ID can be passed to `app_chat_react`
- `app_chat_read_messages` can read the exact canonical message by `messageId`
- reactions approve the exact chat message version, identified by `messageId`

Likely file:

- `src/main/services/chat.ts`

### 5. Verification

Run:

```sh
npm run test:app-skills
npm run test:permissions
make typecheck
make build
```

Add targeted tests:

- public app-owned `/accord` is slash-discoverable
- internal bridge skills remain hidden
- generated public skill keeps frontmatter `name: accord`
- public `/accord` collision with a user-owned `/accord` has deterministic
  behavior
- `app_chat_send_message` creates a participant message in a visible thread
- `app_chat_send_message` rejects invisible parent/root message IDs
- `app_chat_send_message` rejects empty content
- `app_chat_send_message` never silently truncates content
- `app_chat_send_message` enforces per-run send limits
- `app_chat_send_message` writes through the chat mutation queue and preserves
  concurrent participant replies/reactions
- facilitator can read a message created by `app_chat_send_message` in the same
  run
- facilitator can add `✅` to a message created by `app_chat_send_message` in
  the same run
- `app_chat_read_messages` can return one visible message by `messageId`
- participant can `✅` react to the canonical message created by
  `app_chat_send_message`
- approval verification uses reactor actor IDs, not only reaction count
- reactions on an older canonical message do not count after a new canonical
  version is published

### 6. Non-Goals For v1

- Do not replace the generated public skill approach with a native app command.
- Do not build first-class `DecisionRecord` or app-state orchestration.
- Do not add a new approval UI; canonical message reactions plus MCP
  verification are enough for v1.
- Do not require exact `No objections.` text as an approval signal.
- Do not scope `app_chat_send_message` only to `/accord`; keep it generic, but
  bounded.

## Proposed `src/main/appSkills/accord/SKILL.md`

````markdown
---
name: accord
description: >
  Facilitate an explicit multi-participant AccordAgents accord discussion. Use
  this skill when User asks for participant consensus, approval, an agreed plan,
  combined approved findings, or another shared resolution approved by involved
  participants.
---

# Accord

Use this skill to lead a bounded, skeptical discussion between current
AccordAgents chat participants and produce one canonical resolution.

Do not use this skill for a normal single-agent answer, ordinary review,
ordinary double-check, or "what do you think" request. Use it only when User
explicitly wants multi-participant accord, consensus, approval, or a resolution
approved by all involved participants.

## Core Rule

Consensus is approved only when:

- You have skeptically reviewed and approved the final resolution yourself.
- You published one canonical resolution message with `app_chat_send_message`.
- The canonical message contains the exact version under approval; reactions
  approve that chat message version, identified by `messageId`.
- You added your own `✅` reaction to that canonical message.
- Every selected participant read that exact canonical message.
- Every selected participant added `✅` to that same canonical message.
- You verified the canonical message's `metadata.reactions["✅"]` includes you
  and every selected participant.
- No selected participant has an unresolved correction, caveat, or disputed
  disposition after the final approval round.

Do not claim consensus from prose alone. Reactions must be attached to the exact
canonical message under approval.

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

When asking User to approve suggested participants, emit a real app user-choice
card with:

- title: Accord participants
- question: Which participants should join this accord discussion?
- recommended option: use the suggested participants
- alternate option: User names participants manually

Only emit a user-choice block when actually asking User to approve participants.
Never quote or print a user-choice example as ordinary explanatory text.

Do not silently choose participants when User did not name them.

Do not force a specific number of participants. The common case may be one
selected participant plus the facilitator, but use however many User approves
and the question warrants. A single `app_chat_request_participants` call can
target at most 4 selected participants; if User explicitly wants more, handle
them in batches while preserving the same canonical approval process.

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
   request using `app_chat_send_message`.
10. Add your own `✅` reaction to the canonical message using `app_chat_react`.
11. Ask selected participants to read and approve that exact canonical message.
12. If any participant objects, run at most one focused follow-up round for that
    disputed item, revise the canonical resolution when warranted, ask User for
    any User-owned decision, then publish a new canonical message for approval.
13. Report consensus not reached for that version only after the focused
    follow-up cannot resolve the objection and no User-owned decision can
    resolve it.
14. Final answer only after approval, or clearly report that consensus was not
    reached.

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

If you have no concerns, reply exactly: No objections.
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

- raised by: @participant
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

If the participant objects, run a focused follow-up only for that disputed item:

```text
You did not approve this disposition in the canonical resolution.

Original concern from @participant:
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

Outcomes:

- If the participant accepts the disposition, continue approval.
- If the participant provides a valid correction, revise and publish a new
  canonical message.
- If the issue depends on User-owned criteria, ask User with the user-choice
  format.
- If the participant still rejects the disposition and no User-owned decision can
  resolve it, report consensus not reached.

Run at most one focused follow-up round per disputed item before deciding which
outcome applies.

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

Publish the candidate/final resolution as a reply to User's original request:

```json
{
  "content": "Consensus candidate / final resolution text...",
  "threadId": "original-user-thread-id",
  "parentMessageId": "original-user-message-id",
  "chatThreadRootId": "original-user-thread-root-id"
}
```

Use the returned `messageId` as the canonical approval target.

Immediately add your own approval reaction:

```json
{
  "messageId": "canonical-message-id",
  "emoji": "✅"
}
```

The canonical approval target is the chat message identified by the returned
`messageId`. Reactions approve that exact message version.

## Approval Round Prompt

Ask every selected participant to approve the same canonical message:

```text
Read message <canonical-message-id> with app_chat_read_messages using
messageId. This is the only version under approval.

Stay skeptical. Do not accept the facilitator's reasoning by default. Double
check the resolution, the Reasoning / Dispositions section, and whether your
original concerns were preserved or correctly resolved.

If you approve that exact message as complete:
Add ✅ to message <canonical-message-id>.

If you do not approve, do not add ✅. Reply with the concrete missing concern,
correction, or disputed disposition.
```

If a participant objects, continue focused discussion on the disputed item. Ask
User with the user-choice format if the issue depends on User-owned criteria.
When warranted, revise the resolution, publish a new canonical message, add your
own `✅`, and ask participants to approve the new message. Older approvals do
not count for the new version.

## Approval Verification

Before claiming consensus, call `app_chat_read_messages` with the canonical
`messageId`. Inspect `metadata.reactions["✅"]`.

Approval is complete only when the `✅` reactors include:

- your participant actor
- every selected participant actor

Use reactor identity, not only the reaction count. A count can be misleading if
User or an unrelated participant reacted.

## Final Output

If consensus is reached, reply briefly with:

```text
Consensus: approved by @facilitator, @a, @b, @c on message <messageId>.
```

Do not repeat the full resolution if the canonical message already contains it,
unless User asks for a copy.

If consensus is not reached after focused follow-up, reply with:

```text
Consensus: not reached.

Agreed:
...

Blocking issue:
...

Remaining objection:
- @a: ...

User decision needed:
...
```

## Tool Rules

- Use `app_chat_get_participants` for roster discovery.
- Use `app_chat_read_messages` to inspect context and exact approval messages.
- Use `app_chat_read_messages` with `messageId` to read the canonical approval
  target.
- Use `app_chat_read_messages` to verify `✅` reaction actors before claiming
  consensus.
- Use `app_chat_request_participants` for participant answers.
- Use `app_chat_send_message` to publish the canonical resolution.
- Use `app_chat_react` to approve the canonical message yourself.
- Do not rely on plain `@mentions` when another participant is expected to
  answer.
- If `app_chat_request_participants` returns `pending_approval`, end with:
  `Participant request is awaiting User approval.`
- If it returns `running`, end with one short waiting status.
- On resume after `pending_approval`, `running`, approval delay, or
  interruption, first read the original thread, identify the latest canonical
  accord candidate message if one exists, check its `✅` reactor set, read any
  participant replies since that message, and resume from the first incomplete
  step. Do not blindly republish or re-request participants.
- Do not repeatedly poll request status in the same turn.
- Do not ask participants to decide User-owned requirements.
````
