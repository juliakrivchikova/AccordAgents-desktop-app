# Urgent alerts (Telegram, then a phone call)

Asked for by the User on 2026-11-12: a member that watches something for her
(a deployment, a long job) must reach her outside the app when it goes wrong,
even when she forgot it was watching.

## What happens

1. The member calls the app MCP tool `app_urgent_alert` with one message
   (≤ 1000 characters). The call returns at once.
2. The User's server writes a red **Urgent alert** card into the chat as the
   member's message (`metadata.urgentAlert`), sends the message to her
   Telegram with one **Got it** button, and waits (5 minutes by default,
   Settings → Alerts).
3. Without a reaction it calls her phone through her Twilio account and reads
   the message out: 1 confirms, 2 repeats. Without 1 it calls twice more,
   3 minutes apart (three calls in all), then says nobody answered.
4. What ends it: Got it in Telegram, 1 on the call, or Got it on the card in
   the app (computer or phone). A text reply in Telegram does not. Got it on
   the card folds it into one line (the message, then how it ended); a click
   opens it. After Got it in Telegram or on the call the card stays open with
   the outcome, and its cross folds it.

The card (approved by the User on 2026-11-15 after five design reviews,
header variant 5A): the red header whatever the state; the member and the
time; the message; one status band that says what happens now ("Calling you
in 0:49", "Calling you now · call 1 of 3", "Nobody answered 3 calls · no more
calls", "Got it · …", "Not sent outside the app") with what happened before
in one grey line. While the alert waits for her (waiting, calling, nobody
answered) the band has Got it and the header has no cross. The wording is
`urgentAlertStatus` / `urgentAlertOutcome` in `src/shared/urgentAlerts.ts`,
shared by the desktop and the phone. An alert's card below a member's reply
does not make a "finished answering" note: it would only repeat the reply.
5. Several alerts are separate: each has its own message, wait and calls. How
   often to alert is the User's arrangement with the member; the app does not
   group or limit them.

Decisions and the approved design: chat "Agent alerts via messenger and phone
call", artifact "План: Urgent alert — Telegram и звонок".

## When her server cannot take an alert

The card appears in any case (the User, 2026-11-27). When the computer's
raise does not get through (the server is not reached within 20 seconds,
the link has not started, a server older than urgent alerts, or the server
refuses it), the computer puts the same red card up in the chat itself, at
once: "Not sent outside the app", with why. Telegram and the calls stay the
server's.

- The card is a placeholder message (`serverPlaceholder`, state `unsent`,
  `UrgentAlertView.unsent`): never sent to the server (nor moved there with
  the chats), kept with the chat across restarts. Its message id is
  `urgentAlertCardMessageId(chat, member, requestId)`, the id the server
  gives its own card for the same request, so the server's card replaces it
  in place when it arrives: one card, never two. A server older than this
  change writes its card under another id; the computer then takes its card
  down when the raise is answered.
- What is not settled with the server is kept in the client state
  `urgent-alerts.unsent` (`UrgentAlertOutbox`), across restarts, in stages:
  waiting (raised again every 30 seconds with the same request id, so never
  twice), reached (the server took it; let go when its card arrives through
  the feed, `ServerChat` → `unsentAlertCards.serverMessageArrived`), closed
  (she pressed Got it on this computer's card). Once it gets through,
  Telegram and the calls follow as for any alert (approved by the User,
  2026-11-27).
- Got it on that card before then: it is never raised again, the member's
  repeated call does not send it, and if a raise did reach the server after
  all (an answer lost to a timeout, a raise on its way), the server's alert
  is closed as soon as it is known (the answer, or its card in the feed),
  tried again until the server confirms. The card folds ("Got it in the
  app", "Not sent outside the app"). A card the server's took over sends Got
  it there.
- A refusal (a chat or member the server does not know yet, a chat that
  would not take the card) is asked again 20 times, then the card says the
  server did not take it and it is not raised any more.
- The member's tool result says what happened: sent (Telegram, call), a card
  only because nothing is set up, or a card only because the server could
  not take it (and that it may have gone out when the server did not answer
  in time).
- A cloud machine has no screen of its own and reaches the User only through
  her server: it keeps raising the alert until the server takes it, and the
  card then reaches her through the server like every card. Its member hears
  that nothing may have reached her yet.
- A running turn's older copy of the chat never brings the unsent card back
  over the server's (`mergeStoredChat`: a placeholder never wins over the
  server's copy of the same message, and `urgentAlert` is taken from the
  stored copy).

In the sessions view (docs/main-session.md) a member's alert card stands on
the main timeline as well as in that member's session, on the computer and
the phone; Got it in either place folds it in both.

## When members use it

Every member, the main session included, gets the standing rule in its
instructions (`URGENT_ALERT_INSTRUCTIONS` in `memberSessions.ts`) and the
same in the tool's description: emergencies only, where the User has to act
within minutes and a chat message could be missed; never for progress,
finished work, questions, choices, a failed test or build, or anything that
can wait an hour; one alert per incident, then the details in a chat message
(the User, 2026-11-27).

## Where it lives

- `src/shared/urgentAlerts.ts` — wire format, states, what the card says
  (shared by the desktop card and the phone's, through `mobileSharedRules.ts`).
- `src/hub/hubAlerts.ts` and `hubAlerts/` — the alert's course on the server: settings
  (`hub_documents` key `urgent-alerts`), alerts (`urgent_alerts` table),
  Telegram long polling, calls and their status, Twilio key presses.
- `src/hub/alertChannels.ts` — Telegram Bot API and Twilio REST clients,
  Twilio signature check, what the call says.
- `HubOps.writeServerMessage` — the only way the server writes a chat message
  itself: alert cards only, with `serverWriter = "server"`, so every device
  (including the member's own) takes it from the feed and none may change it.
- `src/main/services/urgentAlertTools.ts` (`UrgentAlertOutbox`) +
  `wireUrgentAlertToolHandler` — the tool on the computer and on cloud
  machines (same code), through `ServerChatLink.alerts` → `POST /v3/alerts`;
  the computer's own card while the server cannot take an alert is
  `ChatService.unsentAlertCards` (`chat/server/unsentAlertCards.ts`).
- Desktop: `chat-urgent-alert-card.tsx`, Settings → Alerts
  (`alerts-settings-section.tsx`, `alerts-settings-parts.tsx`,
  `alerts-connect-dialogs.tsx`, `alerts-phone-dialog.tsx`; what each state
  says is `src/shared/urgentAlertSettings.ts`).
- Phone: `urgentAlertCardElement` in `src/mobile/app/chat/urgentAlerts.js`; its Got it
  (and its cross on a card nobody closed) posts `close` to `/v3/alerts`.

## Settings → Alerts

Approved by the User on 2026-11-15 after five design reviews:

- One band on top says whether an alert reaches her now, the worst first: a
  channel that stopped working (red, with Reconnect), including a phone whose
  last test call failed (red "Calls aren't going out" with the reason and
  Change phone call; the User, 2026-11-15; a test whose result was lost to a
  restart is not a failure), the server inside the
  app (alerts only while the Mac is awake; answering counts as Got it, with
  Set up your server), her server that Twilio cannot reach, Telegram only,
  a call only, all set, or off.
- "What happens when an alert comes in": Telegram at once, then calls at the
  wait and 3 minutes apart; the wait is chosen there.
- "Where alerts go": Telegram and Phone call, each with its status beside its
  name (Ready / Needs attention / Not finished / Not set up / Not tested), its
  last test, the next action, and ⋯ (Use a different bot, Change, Remove,
  each removal confirmed). Never "Ready" next to an error.
- The phone is Ready only once a test call reached her: 1 pressed on it, or,
  where Twilio cannot reach the server, answered. The connect dialog makes
  that call before Save (`phone.try` / `phone.try-status`, keypad TwiML with
  its own token, signed by the keys it was placed with); the page's Test
  call (`phone.test`) keeps its outcome as the phone's `lastTest`. Telegram
  keeps its last test message and whether Got it came back.
- Changing the phone or the number reuses the saved Twilio keys (requests
  without keys use the saved ones). Buying a number is never chosen for her
  and says its price. On a trial account her phone is checked against
  Twilio's verified numbers.

## With and without the User's own server

- **Own server** (public HTTPS): calls use a keypad; Twilio posts the key to
  `/v1/alerts/twilio?alert=…&token=…`, checked by `X-Twilio-Signature`. The
  computer tells the server its address (`public-url`) with every Settings →
  Alerts request. Works with the computer closed.
- **No server** (the server inside the app, loopback only): Twilio cannot
  reach it, so the call reads the message twice and answering it counts as
  Got it (voicemail can be taken for the User — accepted by the User
  2026-11-12). Alerts work only while the computer is awake. Telegram works
  the same (long polling, outbound only).

Call state is always read by polling Twilio, never from status webhooks, so a
call ends correctly even when Twilio cannot reach the server.

## Local QA

The server reads these only for loopback addresses:

- `ACCORDAGENTS_ALERTS_TELEGRAM_URL`, `ACCORDAGENTS_ALERTS_TWILIO_URL` —
  stand-ins for Telegram and Twilio (`http://127.0.0.1:<port>`).
- `ACCORDAGENTS_HUB_PUBLIC_URL` — where Twilio reaches the server (a tunnel),
  which turns the keypad on for a local server.

Tests: `src/hub/hubAlerts.test.ts` (whole course against stand-ins, restart,
signatures, rights), `src/shared/urgentAlerts.test.ts`,
`src/main/services/urgentAlertTools.test.ts` (the outbox) and
`src/main/services/urgentAlert.unsent.test.ts` (a real chat, link and server
going away and coming back, restart), in `npm run test:hub`.
