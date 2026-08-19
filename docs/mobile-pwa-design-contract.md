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
