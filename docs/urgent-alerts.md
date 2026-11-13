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
4. What ends it: Got it in Telegram, 1 on the call, or the cross on the card
   in the app (computer or phone). A text reply in Telegram does not. The
   cross on a closed alert folds the card into one line; a click opens it.
5. Several alerts are separate: each has its own message, wait and calls. How
   often to alert is the User's arrangement with the member; the app does not
   group or limit them.

Decisions and the approved design: chat "Agent alerts via messenger and phone
call", artifact "План: Urgent alert — Telegram и звонок".

## Where it lives

- `src/shared/urgentAlerts.ts` — wire format, states, the card's lines (shared
  by the desktop card and the phone's, through `mobileSharedRules.ts`).
- `src/hub/hubAlerts.ts` — the alert's course on the server: settings
  (`hub_documents` key `urgent-alerts`), alerts (`urgent_alerts` table),
  Telegram long polling, calls and their status, Twilio key presses.
- `src/hub/alertChannels.ts` — Telegram Bot API and Twilio REST clients,
  Twilio signature check, what the call says.
- `HubOps.writeServerMessage` — the only way the server writes a chat message
  itself: alert cards only, with `serverWriter = "server"`, so every device
  (including the member's own) takes it from the feed and none may change it.
- `src/main/services/urgentAlertTools.ts` + `wireUrgentAlertToolHandler` — the
  tool on the computer and on cloud machines (same code), through
  `ServerChatLink.alerts` → `POST /v3/alerts`.
- Desktop: `chat-urgent-alert-card.tsx`, Settings → Alerts
  (`alerts-settings-section.tsx`, `alerts-connect-dialogs.tsx`).
- Phone: `urgentAlertCardElement` in `src/mobile/mobile-app.js`; its cross
  posts `close` to `/v3/alerts`.

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
signatures, rights) and `src/shared/urgentAlerts.test.ts`, in `npm run test:hub`.
