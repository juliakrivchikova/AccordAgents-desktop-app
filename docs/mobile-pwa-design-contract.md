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
