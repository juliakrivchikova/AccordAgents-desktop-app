# Concurrent Chat Fan-Out Manual QA

Manual QA coverage for the concurrent chat fan-out change. These cases assume the app is running in Electron and the tester is using the normal UI.

Use `docs/inspecting-the-desktop-app.md` only if you need to inspect DOM state or capture screenshots. Do not test this through the Vite browser URL.

## Setup

- Start the app with `make dev`.
- Create two chat conversations:
  - `Chat A`
  - `Chat B`
- In `Chat A`, add at least two participants, for example `@drew` and `@casey`.
- In `Chat B`, add at least one participant.
- Use prompts that naturally take long enough to observe active states, for example:
  - `@drew Think carefully for a while, list several approaches, and do not rush.`
  - `@casey Independently analyze this in detail and compare tradeoffs.`

## QA-01: Send Another Message While Same Chat Is Running

Steps:
1. Open `Chat A`.
2. Send a message mentioning `@drew` with a long-running prompt.
3. While `@drew` is still responding, type a second message in the composer.
4. Send the second message mentioning `@casey`.

Expected:
- The composer remains editable while `@drew` is running.
- The send button is enabled for the second message.
- The second user message appears immediately in the transcript.
- `@casey` starts responding without waiting for `@drew` to finish.
- Both in-flight participant bubbles are visible at the same time.

## QA-02: Same Participant Mention Queues

Steps:
1. Open `Chat A`.
2. Send a long-running message to `@drew`.
3. While `@drew` is still responding, send another message also mentioning `@drew`.

Expected:
- The second user message appears immediately.
- A queued badge appears for the second `@drew` response.
- Badge copy says: `Queued — waiting for @drew`.
- Only one `@drew` response actively streams at a time.
- The queued `@drew` response starts after the first `@drew` run finishes or is stopped.

## QA-03: Multiple Mentions Fan Out In Parallel

Steps:
1. Open `Chat A`.
2. Send one message mentioning both participants, for example `@drew @casey compare these options in detail`.

Expected:
- Both `@drew` and `@casey` start from the same user message.
- Each participant gets its own in-flight response bubble.
- Each in-flight bubble has its own Stop button.
- One participant finishing does not remove or interrupt the other participant's in-flight bubble.

## QA-04: Stop One Participant Only

Steps:
1. Start parallel responses from `@drew` and `@casey`.
2. Click Stop on only the `@drew` in-flight bubble.

Expected:
- Only `@drew` stops.
- Any partial `@drew` reply is removed.
- A system message appears: `@drew stopped by user.`
- `@casey` continues responding.
- `@casey` can still finish and append a normal final reply.

## QA-05: Stop All Active Runs

Steps:
1. Open `Chat A`.
2. Start at least two active participant runs.
3. Click the Stop all control at the top of the chat view.

Expected:
- Stop all is visible only while the current chat has one or more active runs.
- Clicking Stop all stops every in-flight participant in the current chat.
- Each stopped participant gets a one-line system message: `@<handle> stopped by user.`
- Partial participant replies are removed.
- Stop all disappears after all active runs stop.

## QA-06: Work In Another Chat While Chat A Is Running

Steps:
1. Open `Chat A`.
2. Start a long-running participant response.
3. Before it finishes, switch to `Chat B`.
4. Send a message in `Chat B`.

Expected:
- Switching to `Chat B` works while `Chat A` is running.
- `Chat B` composer is editable and can send.
- `Chat B` participant starts responding.
- `Chat A` continues running in the background.
- Sidebar shows active indicators for conversations with active runs.

## QA-07: Sidebar Active Spinner

Steps:
1. Start a long-running response in `Chat A`.
2. Switch to `Chat B`.
3. Start a long-running response in `Chat B`.
4. Let only one chat finish first.

Expected:
- A spinner appears on `Chat A` in the sidebar while it has an active run.
- A spinner appears on `Chat B` in the sidebar while it has an active run.
- When one chat finishes, only that chat's spinner is removed.
- The other chat's spinner remains until its own run finishes or is stopped.

## QA-08: Sidebar New Activity Blue Dot

Steps:
1. Open `Chat A`.
2. Start a participant response.
3. Switch to `Chat B` before `Chat A` finishes.
4. Wait for `Chat A` to receive a new reply or stop message.

Expected:
- `Chat A` shows a small right-aligned blue dot in the sidebar after new activity arrives while it is not selected.
- The dot is visually distinct from the active spinner.
- Opening `Chat A` clears the blue dot.
- The dot does not reappear until new activity arrives while `Chat A` is not selected.

## QA-09: Current Chat Does Not Mark Itself Unread

Steps:
1. Open `Chat A`.
2. Start a participant response and keep `Chat A` selected until it finishes.

Expected:
- `Chat A` does not show the blue unread dot while it is selected.
- Streaming updates and the final reply appear normally in the current chat.

## QA-10: Spinner Turns Into Blue Dot For Background Completion

Steps:
1. Open `Chat A`.
2. Start a long-running participant response.
3. Switch to `Chat B` while `Chat A` is still running.
4. Wait for `Chat A` to finish.

Expected:
- `Chat A` shows a spinner while the run is active.
- After the run finishes, the spinner disappears.
- If `Chat A` has new activity since it was last viewed, the blue dot appears.

## QA-11: Rename Is Blocked Only In Active Chat

Steps:
1. Start a long-running response in `Chat A`.
2. Try to rename `Chat A`.
3. Switch to idle `Chat B`.
4. Try to rename `Chat B`.

Expected:
- Rename is disabled or rejected in `Chat A` while it has active runs.
- The UI explains that chat names cannot be edited while participants are running.
- Rename remains available in idle `Chat B`.

## QA-12: Add Participant Is Blocked Only In Active Chat

Steps:
1. Start a long-running response in `Chat A`.
2. Try to add a participant to `Chat A`.
3. Switch to idle `Chat B`.
4. Try to add a participant to `Chat B`.

Expected:
- Add participant is disabled or rejected in `Chat A` while it has active runs.
- Add participant remains available in idle `Chat B`.
- Active runs in one chat do not block participant management in another idle chat.

## QA-13: Pending Mention Approval Works During Active Run

Steps:
1. Start a long-running response in `Chat A`.
2. Create or wait for a pending mention approval card in the same chat.
3. Approve the pending mention.

Expected:
- The approval controls remain usable while another participant is running.
- Approving the mention starts the approved participant run.
- The original active run continues unless it is the same participant and must queue.

## QA-14: Pending Mention Rejection Works During Active Run

Steps:
1. Start a long-running response in `Chat A`.
2. Create or wait for a pending mention approval card in the same chat.
3. Reject the pending mention.

Expected:
- The rejection is saved immediately.
- No participant run starts for the rejected mention.
- Existing active runs continue unaffected.

## QA-15: Unknown Mention Does Not Start A Run

Steps:
1. Open `Chat A`.
2. Send a message mentioning a participant that does not exist, for example `@missing can you help?`.

Expected:
- The user message appears in the transcript.
- A system warning appears: `No participant named @missing.`
- No participant response starts for `@missing`.
- No sidebar spinner appears solely because of the unknown mention.

## QA-16: Image-Only Message Can Be Sent During Active Run

Steps:
1. Start a long-running response in `Chat A`.
2. While it is running, attach a valid image to a new message.
3. Send the image-only message, or send the image with text mentioning another participant.

Expected:
- The composer allows sending once the image attachment is ready.
- The image message appears immediately.
- If another participant is mentioned, that participant can start while the first run is active.
- If the image is still loading or invalid, the send button remains disabled.

## QA-17: Stop Does Not Leave Stale Busy UI

Steps:
1. Start one participant response.
2. Click Stop on that in-flight bubble.
3. Wait a few seconds.

Expected:
- The stopped bubble is removed.
- The stopped system message appears.
- The chat composer remains usable.
- The sidebar spinner clears if there are no other active runs in that chat.
- Rename and add-participant controls become available again after the stop completes.

## QA-18: App Restart Clears Stale Running State

Steps:
1. Start a long-running chat response.
2. Quit or force-close the app while the response is active.
3. Relaunch the app.
4. Reopen the same chat.

Expected:
- The app does not remain permanently busy.
- Stale pending participant bubbles are marked interrupted or cleared according to existing recovery behavior.
- The chat composer is usable.
- Sidebar spinner is not stuck forever for the recovered chat.

