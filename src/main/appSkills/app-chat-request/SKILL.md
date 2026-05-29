---
name: app-chat-request
description: >
  Ask another AccordAgents chat participant for a concrete answer using the
  participant request MCP tool. Use this skill when you need to consult, ping,
  request, hand off, or ask another @participant to respond to a question or
  task. Do not rely on plain @mentions when the target is expected to answer.
---

# Request another chat participant

Use this skill when another current chat participant should answer a concrete
question or task.

A normal `@handle` mention is only prose. It is appropriate for attribution,
discussion, or referring to what someone said. When the target participant is
expected to answer, use `app_chat_request_participants` so the app can validate
policy, ask User for approval when needed, run the target, attach the reply, and
resume your turn.

Do not use this skill when User is only asking you to answer directly, when a
participant is mentioned only for attribution, or when the other participant is
not expected to respond.

## Prepare the request

1. Identify the target participant handle and the exact prompt they should
   answer.
2. If the target handle is explicit in the current turn, use it directly. Do
   not call discovery just to confirm an obvious handle.
3. If the target is ambiguous, missing, or described by role instead of handle,
   call `app_chat_get_participants` once and choose the matching current
   participant. If no single target is clear, ask User to clarify in a normal
   chat message and end your turn.
4. Keep the prompt concrete and self-contained. Include only the context the
   target needs to answer. Do not ask the target to decide User-owned goals,
   preferences, or acceptance criteria.
5. Include a short `reason` when it helps User understand why approval is being
   requested.
6. When asking another participant to review a plan, prefer scrutiny-first
   wording such as: "Review this plan for blockers, incorrect assumptions,
   missing edge cases, or simpler alternatives. If none, reply with only
   `No objections.`" Avoid "confirm or add" unless confirmation is truly the
   only task. The app also rewrites confirm/agree-style prompts before they
   reach the target, but starting with scrutiny-first wording yourself reduces
   bias more reliably.

## Call the tool

Call `app_chat_request_participants`:

```json
{
  "requests": [
    {
      "target": "target-handle",
      "prompt": "Concrete question or task for the target participant.",
      "reason": "Optional brief reason this participant input is needed."
    }
  ],
  "timeoutMs": 120000,
  "resumeRequester": true
}
```

Use the handle with or without `@`. For multiple independent targets, include
one request item per target. Do not include yourself as a target.

## After the tool returns

- If the tool returns replies in this turn, use those replies immediately in
  your answer.
- If the tool returns `pending_approval`, end your turn with exactly:
  `Participant request is awaiting User approval.`
- If the tool returns `running`, end your turn with one short status line that
  says the request is waiting for participant replies.
- If the tool returns `failed`, explain the failure briefly and do not invent a
  participant answer.
- Do not repeatedly poll status in the same turn.

Use `app_chat_get_participant_request_status` only to recover a previous
request after timeout, interruption, approval delay, or session resume.

## What not to do

- Do not rely on implicit mention detection for normal participant requests.
- Do not write only a plain `@handle` question when the target is expected to
  answer.
- Do not ask another participant for User-owned clarification.
- Do not claim that approval was granted unless the tool result says so.
- Do not say a target answered until the reply appears in the tool result or
  transcript.
