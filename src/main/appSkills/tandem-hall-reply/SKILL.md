````markdown
---
name: ai-consensus-reply
description: >
  Reply to a participant request that was addressed to your handle. Use this
  skill when another participant triggered your turn through a participant
  request and your output is the reply they are waiting on. Use the reply MCP
  tool instead of answering only with an ordinary chat message.
---

# Reply to a participant request

Use this skill when another participant triggered your turn through a
participant request and your output is the reply they are waiting on.

A participant request is a structured ask from one participant to another. The
requester is paused on your answer. When you reply through
`app_chat_reply_to_participant_request`, your answer is attached to the request
and the requester is resumed. Plain chat messages do not resume the requester.

Do not use this skill when the user pinged you directly, when you are starting
a new topic, or when no participant request is currently addressed to you.

## Identify which request you are answering

Before you reply, decide exactly which pending request your answer belongs to.

1. Look at the message that triggered your turn and the thread it was posted
   in. The request you are answering is the pending participant request whose
   `target` is you and whose `prompt` matches that triggering message in that
   thread. In normal operation there is exactly one.
2. If the triggering context does not make the match obvious, call
   `app_chat_get_pending_requests` with `{}`. The server filters to pending
   requests addressed to you. Match candidates by `threadId` first, then by
   `prompt` content.
3. If exactly one pending request is addressed to you **and** its prompt
   matches the triggering message, use that request's `id`.
4. If two or more pending requests could plausibly match and the thread does
   not disambiguate, do not guess. Post a single normal chat message asking
   the user which request to answer. List each candidate on its own line as
   `requestId — requester — first line of prompt`. End your turn. Do not call
   the reply tool.
5. If zero pending requests are addressed to you, you were not triggered by a
   participant request. Answer as a normal chat message and do not call the
   reply tool.

## Reply

Call `app_chat_reply_to_participant_request`:

```json
{
  "requestId": "the id you chose above",
  "response": "Your answer to the requester."
}
```

`requestId` is mandatory. Use the exact id from the pending request. Do not
invent, shorten, transform, or pass `null`.

`response` is mandatory. Put the full answer here. If the requester asked for
an exact format, put only that required content in `response`. If you cannot
answer, still call the reply tool and put the blocker in `response`.

After the tool succeeds, end the turn with exactly this single line of prose:

Replied

## Reading context

Use this order when deciding what to answer:

1. The triggering message and its thread.
2. Recent messages in the same thread, if any.
3. `app_chat_get_pending_requests({})` for compact request metadata.

Do not reread the full chat history unless the request cannot be understood
from the triggering message, current thread, or pending-request metadata.

## What not to do

- Do not call the reply tool when you were not triggered by a participant
  request.
- Do not call the reply tool without a concrete `requestId`. Do not pass
  `null`.
- Do not pick a pending request just because it is the only one addressed to
  you, if its prompt clearly does not match the triggering message. Ask
  instead.
- Do not poll `app_chat_get_pending_requests` repeatedly in the same turn.
- Do not put the answer in final prose in addition to `response`. The single
  `Replied` line is the only prose after a successful reply.
- Do not answer a participant request only by writing a normal chat message.
````