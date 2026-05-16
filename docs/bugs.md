# Bugs

## New Chat Intro Renders as a Full Message Card

When a new chat is created, the app currently renders the initial system text as a normal chat message card attributed to `Arbiter`:

```text
Chat started.
Participants:
- User
- @admin
```

This should not appear as an `Arbiter` message. The arbiter did not say this, and attributing a system-created chat event to an agent is confusing. It makes the chat feel like an agent response rather than a lightweight room event.

Desired behavior:

- Show a compact Slack-style join/system notice instead of a full message card.
- The notice should communicate that the user and default/admin participant joined the chat.
- The notice should be attributed to the app/system, not to `Arbiter` or any participant.
- The notice should not dominate the first screen or look like an arbiter/agent response.
- The chat should still persist the system/audit event for history and debugging.

## Running Participant Status Appears in Too Many Places

When a participant is responding, the UI currently shows the same state in multiple places at once:

- In the chat header, for example `@admin is responding.`
- In the timeline as a `@admin Thinking` row.
- Above the composer as another `@admin is responding.` status line.

This is visually noisy and makes the running state feel duplicated.

Desired behavior:

- Show one running/thinking indicator for the participant turn.
- Prefer placing it directly under the user message that triggered the response.
- Do not repeat the same status in the header and composer at the same time.
- Keep the indicator compact and clearly connected to the pending participant reply.
