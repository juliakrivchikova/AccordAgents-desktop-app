---
name: app-chat-reply
description: >
  Reply to a participant request that was addressed to your handle. Use this
  skill when another participant triggered your turn through a participant
  request and your output is the reply they are waiting on.
---

# Reply to a participant request

Use this skill when another participant triggered your turn through a
participant request and your output is the reply they are waiting on.

A participant request is a structured ask from one participant to another. The
requester is paused on your answer. In the normal path, answer directly in the
active request thread; the app can attach an unambiguous reply to the request
and resume the requester.

Do not use this skill when the user pinged you directly, when you are starting
a new topic, or when no participant request is currently addressed to you.

## Identify which request you are answering

Before you reply, decide exactly which request your answer belongs to.

1. Look at the message that triggered your turn and the thread it was posted
   in. The request you are answering is the pending participant request whose
   `target` is you and whose `prompt` matches that triggering message in that
   thread. In normal operation there is exactly one.
2. If exactly one request is addressed to you and its prompt matches the
   triggering message, answer that request directly in the active thread.
3. If two or more requests could plausibly match and the thread does not
   disambiguate, do not guess. Ask for clarification in one short normal chat
   message and end your turn.
4. If zero requests are addressed to you, you were not triggered by a
   participant request. Answer as a normal chat message.

## Reply

Write the answer directly in the current chat thread. If the requester asked
for an exact format, output only that required content. If you cannot answer,
state the blocker clearly in the reply.

## Reading context

Use this order when deciding what to answer:

1. The triggering message and its thread.
2. Recent messages in the same thread, if any.
3. App-provided request metadata in the current turn, if present.

Do not reread the full chat history unless the request cannot be understood
from the triggering message, current thread, or request metadata.

## What not to do

- Do not use this skill when you were not triggered by a participant request.
- Do not guess when multiple requests could match. Ask for clarification
  instead.
- Do not pick a request just because it is the only one addressed to you, if
  its prompt clearly does not match the triggering message.
- Do not claim the requester resumed; just provide the answer.
