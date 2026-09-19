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
own round button beside it, as Slack does it. The bar shows only on those three
home screens of a paired phone; inside a chat it is gone, and it steps aside
while a choice opened from Activity is on screen and while the chat search is
open. The Chats header no longer carries the search button; the bar's button
opens the chat search, switching to Chats first when another tab is open.

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

Settings holds only what the phone can do about itself: the pairing, message
alerts (offered while undecided, otherwise described — iOS does not let a web
app switch its own alerts off, so there is no switch), and waking the cloud
machine when the pairing carries the key for it.
