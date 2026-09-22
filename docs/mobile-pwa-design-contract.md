# Mobile PWA Design Contract

The mobile PWA must match `design_handoff/Mobile (packed).html` exactly at the component/geometry level. This is not an approximate visual reference.

## V1 Acceptance Scope

For v1, Mobile control is device-level access to the current desktop/app instance:

- the QR flow must use the managed AccordAgents relay/static origin by default, with no endpoint setup required from the user;
- the PWA must show the available chat list and let the user open and work with any existing chat in that app instance;
- the v1 UI must not present "Invite person", per-chat invite setup, or custom relay/static/outbox endpoint fields on the managed-default path.

The pairing/package architecture may keep future extension points for scoped chat invites and different participants, but those are not v1 acceptance behavior.

The functional PWA uses the "Chat timeline" screen from the handoff as the paired-conversation default:

- stage background `#eceef2`
- phone frame `390px x 844px`, `44px` radius, white surface, border `#dcdee5`, and the same two-layer shadow
- status bar height `52px`, `9:41` typography, signal and battery indicators
- chat header padding `2px 16px 12px`, `44px` icon buttons, bottom border `#f0f1f4`
- timeline padding `16px 18px 10px`, `20px` message gap
- user bubble max width `82%`, background `#eceff3`, radius `18px 18px 6px 18px`, padding `11px 14px`
- composer height `46px`, pill radius `23px`, input background `#f6f7f8`, border `#e7e9ee`, and circular `46px` send button

Desktop/browser QA may show the phone frame centered. Narrow real-mobile viewports fill the viewport without the outer preview border/shadow, but the interior component geometry and typography stay the same.

## Chats header

Decided by the User on 2026-09-15 (PWA polish round): the handoff's "New chat"
button is not rendered. The phone cannot create a chat — that needs the desktop's
member roster and a protocol the phone does not have — and a control that does
nothing is worse than none. The "Search chats" button stays and filters the list
the phone already holds (title, last sender, last message) without asking the
desktop. The header geometry is otherwise the handoff's.

## Dark appearance

Decided by the User on 2026-09-15 (PWA polish round): the PWA follows the phone's
own appearance setting. Under `prefers-color-scheme: dark` the stylesheet restates
its surface variables with the desktop's dark palette (`src/renderer/styles/app-theme.css`,
`.dark`), so a chat looks the same on both. The light values stay the handoff's;
component geometry and typography do not change between the two.

## Members' avatars, hidden rows, folded projects (2026-09-18 parity round)

Avatars are the desktop's, by the desktop's own rule. `src/shared/chatAvatarCatalog.ts`
is the one description of which picture a member shows (catalog id, provider,
glyph or photo, the hashed default when nothing was chosen, a drawn avatar by
id, the app mark for the chat assistant); the desktop renderer derives its
options from it and the phone loads it verbatim as `mobile-shared.js`, with
every built-in avatar copied under its catalog id by the mobile build. A drawn
avatar's bytes are asked for once per session (`mobile.avatar.request`); initials
stand in until they arrive, as on the desktop. The phone never guesses a picture
from a handle. The disc contract is the desktop's too: one frame, a glyph at
75 % or a photo at 100 %, per-kind disc colours stated once.

What the desktop keeps off its timeline stays off the phone's: internal system
triggers ("Auto-resumed @x after member request"), control text, waiting
statuses, inferred request carriers. A hidden member message still travels,
flagged, because it can be the message that ends a run; the phone settles the
run's row on it and stores no bubble. Rows stored before the desktop stopped
sending them are swept once on the first launch of this shell.

Projects in the chat list fold and unfold from their header, with the desktop's
chevron. Phone-only, because the phone is reopened many times a day: the fold is
remembered across launches, and a folded header shows how many chats it holds
and the unread dot when one of them has news. While a search is open the headers
are plain labels and every match is shown.

## Bottom bar, Activity and Settings (2026-09-19)

Decided by the User on 2026-09-19: the phone gets a bottom bar, option B of the
proposal — a floating capsule with Chats · Activity · Settings and search on its
own round button beside it, as Slack does it. The bar shows on those three home
screens of a paired phone, and it steps aside while a choice opened from
Activity is on screen and while the chat search is open. The Chats header no
longer carries the search button; the bar's button opens the chat search,
switching to Chats first when another tab is open.

**Inside a chat (2026-09-20).** The 2026-09-19 decision had the bar gone inside
a chat. The User changed it the next day, pointing at Slack: in a chat the bar
is there too, below the composer, and it leaves only while the keyboard is up —
with the keyboard open there is no room for it and it would sit on top of it.
So inside a chat the bar is in the column under the composer rather than
floating over the timeline, the composer gives up its own bottom safe-area room
to the bar, and the bar is hidden exactly while the composer holds focus (the
same test the height tracker uses for the keyboard, so the two cannot disagree).
A reader who was at the latest message stays there when the bar comes and goes.
A tab tapped inside a chat leaves the chat for that screen, the way the back
button does, and leaves the chat's dialogs closed behind it; so does the bar's
search button, because it searches the chat list. The chat's own dialogs — a
picture at full size, the members sheet — take the bar with them while they are
open, as the opened choice does on Activity; the live-reply view does not,
because it is a screen of the chat rather than a dialog.

The Activity number keeps counting while a chat is open, because in there the
bar is the only place the User is told that something is waiting. It is the
number alone that is recomputed, never the lists, and it is recomputed from
rows already read: a pass over a week of stored rows costs hundreds of
milliseconds on a phone with a busy week behind it, and inside a chat that
would be paid again every second or so while a member streams into it. What
waits for the User is counted from the cards, which are read from storage
anyway, so a question arriving for another chat is counted at once; what can
lag behind until the chat is left is the count of finished updates. The number
is the same one the home screens show, the open chat's own waiting cards
included — it is one count of what waits, not a count of elsewhere.

Activity is built on the phone from what the relay already delivered — the
timeline rows every `mobile.timeline.events` batch stores and the cards riding
with them (`src/mobile/mobile-activity.js`). Nothing new is asked of the desktop.
Only chats in the desktop's chat list are shown; a batch for a chat the phone's
list does not have yet asks for the list again. Its three lists follow the
desktop's Activity:

- Running — a member run still in progress, one row per run and member, with a
  small round stop (44px to tap). A row that reached the phone well before a
  chat list saying nothing runs in that chat is a run the phone never saw end,
  and is left out.
- Pending — a permission or a choice a member is waiting on. A permission is
  answered in the row (Allow/Deny) and so shows every word of what is being
  allowed, line breaks kept, with the machine it will run on; one tap answers
  it and the other option goes dead. A choice shows its question and opens in
  full: the message it belongs to, then the chat's own card laid out for
  reading — options stacked at full width because they are whole sentences,
  "Answer in your own words", and Cancel.
- Finished — finished member messages from the last 7 days, one row per chat
  and member, with a count badge when the row stands for more than one run
  (accent while unseen, grey once seen). The message a waiting question belongs
  to is listed under Pending only.

Every row reads "<chat title> by @handle" on its first line (the handle in the
plain weight), then the message; the whole row opens its chat, or the thread the
update is in. A finished update counts as seen once its chat was opened on the
phone after the update reached the phone — both times on the phone's own clock,
never compared with a desktop stamp. The list tab is chosen once (Pending when
something waits, else Running, else Finished) and then kept until the User
changes it, so rows do not move under a finger; a tap that lands within a
moment of the list being redrawn is ignored. The Activity tab's number is what
waits for the User plus the finished updates not seen yet.

**What the phone can vouch for (2026-09-21).** The phone is a replica fed by
several channels — the live socket, the mailbox, the pages it asks for, a
machine's own channel — and for a while nothing reconciled that replica with
the desktop. A card closed on the desktop stayed "waiting" on the phone for
days (the User's screenshot of 2026-09-20), because the batch that closed it
was lost, or was never written: a cancelled choice changes no message row, and
a batch with cards and no rows was dropped before it reached the mailbox. Now:

- The desktop's chat list carries, per chat, the cards still waiting there and
  when the list was built. The phone drops a pending card it holds that the
  list no longer names, unless the card is younger than the list (it may have
  missed it) or was learned from a machine directly (the desktop cannot vouch
  for it). Answered cards are kept: they are the record under their messages.
- The page a chat is opened with carries the chat's cards, so opening a chat
  reconciles it too. A batch of cards with no rows is written to the mailbox
  like any other, and the desktop remembers cards as delivered only once the
  mailbox has taken them.
- After a phone's answer, whatever became of it, the desktop sends the chat's
  cards as it holds them now — "still pending" included — so a card the
  desktop could not act on is never answered on the phone for ever.
- "Answer sent. Waiting for the machine to apply it." is a mark the phone keeps
  across launches, named after the queue entry that carries the answer; while
  that entry has not reached the desktop the card says "Answer saved on this
  phone. Not delivered yet." instead. The mark goes when the desktop states the
  card answered or withdraws it. A mark older than ten minutes with the card
  still waiting has stopped meaning anything — the answer was lost on its way
  or refused — so the card unlocks and says "Answer sent, but not applied yet.
  You can answer again."; an answer the desktop refused five times unlocks at
  once ("The desktop did not take this answer. You can answer again."). A
  second answer replaces the first one still on its way rather than racing
  it: the earlier queue entry is set aside, never sent. An answer the desktop
  or the mailbox has already taken is not lost, only waiting for the desktop
  to be up: that card stays locked for a day, because a second answer given
  meanwhile only raced the first, and the older one won on the desktop.
- The desktop answers a refused batch with an empty ack only when it refuses
  it for good (a chat outside the pairing's scope, a malformed event). A
  failure of its own — storage that did not answer — gets no ack, so the
  phone keeps the event and tries the mailbox; counted as refusals, five bad
  minutes on the desktop set a message aside for good.
- Sending twice in a row works: the second message is queued while the first
  is still going out, and goes out right behind it. A tap on a row in
  Activity is dropped only for half a second after rows have actually moved,
  not after every redraw (the clock, a streaming preview kept every Allow and
  Stop dead a third of the time while a member streamed).
- A message opens on its own screen on tap, except a system note: the desktop
  offers a thread on every message but those, and the phone offers exactly
  what the desktop does. A reply written with a thread open is placed by that
  thread on the desktop; a thread root the chat does not hold sends the
  message to the chat itself, with a warning, rather than into a thread nobody
  can open.
- A launch that cannot reach the relay keeps the push subscription it has: the
  relay's key is fetched before the old subscription is given up, and a launch
  that could not register tries again on the next return to the foreground.
- On the desktop, an answer read from the mailbox that cannot be applied is
  tried again on the following polls, five times, then given up — and the
  chat's cards are sent again either way, so the phone hears the state the
  desktop actually holds. A refused batch on the live tunnel is answered with
  an empty ack rather than silence, so it cannot hold other chats' sends
  behind the ack timeout.
- The queue is offered to the desktop for every chat, on launch, on return to
  the foreground and while the app is open — never for what a member's own
  machine already holds. Clearing a finished row in Activity names the update
  under every identity it goes by (its run and its message), so a later copy
  of the same message from another path cannot bring it back.
- The timeline store is read by chat, through an index: applying one delivered
  batch used to scan the whole store per row (2.5 s for forty rows on a store
  of eight thousand, measured in Chrome), which is why messages arrived in
  lumps and the live text stood still; it is about 0.1 s now.

Settings holds only what the phone can do about itself: the pairing, message
alerts (offered while undecided, otherwise described — iOS does not let a web
app switch its own alerts off, so there is no switch), and waking the cloud
machine when the pairing carries the key for it.
