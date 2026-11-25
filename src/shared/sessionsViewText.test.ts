import assert from "node:assert/strict";
import test from "node:test";

import { cliFailureNoticeText } from "./warnings";
import { sessionsMentionText, sessionsViewLabel, sessionsViewNames, sessionsViewNamesOf, sessionsViewReplyText, sessionsViewSummaryText, sessionsViewText } from "./sessionsViewText";
import type { ChatMessage, ChatParticipant } from "./types";

const NAMES = sessionsViewNames("main", [["drew", "Fix the logout"], ["gone", "Check the docs"]]);
const HANDLE = /(^|[^A-Za-z0-9_@./\\-])@(main|drew|gone)\b/i;

/** Every shape of text the app writes with a member's handle that a
 *  sessions-view chat can show (notices, failed replies, cards, status
 *  lines, task rows), with the main session and a member in each place. */
function appTexts(main: string, member: string): string[] {
  return [
    // Fork notices (postForkNotice).
    `@${main}'s copy of @${main}'s session may include what @${main} did after you tapped Fork: its session file could not be read.`,
    `@${main}'s copy of @other's session may include what @other did after you tapped Fork: Claude Code compacted the session after it.`,
    `@${main} could not start from a copy of @${main}'s session in the chat "Remember the word APPLE", so its next turn starts a clean session.`,
    `@${main} could not start from a copy of @other's session in the chat "T", so it started a clean session from the saved chat context.`,
    `@${main} could not start from a copy of @other's session in the chat "T": @${main} now runs on Codex, not Claude Code, so it starts a clean session.`,
    `@${main} could not start from a copy of @other's session in the chat "T": that session is not on the cloud machine @${main} runs on, so it starts a clean session.`,
    `@${member} could not start from a copy of @${main}'s session, so its next turn starts a clean session.`,
    `@${member} could not start from a copy of the main session's session, so it started a clean session from the saved chat context.`,
    `@${member} could not start from a copy of the session it was forked from, so this turn started a clean session.`,
    // Failed and stopped replies (cliFailureNoticeText, machineTurnOutcome, chat.ts).
    ...[main, member].flatMap((handle) => [
      cliFailureNoticeText("process exited", { label: `@${handle}` }),
      cliFailureNoticeText("timed out after 3600000ms", { label: `@${handle}` }),
      cliFailureNoticeText("stopped by user", { label: `@${handle}` }),
      cliFailureNoticeText("rate limit", { label: `@${handle}` }),
      cliFailureNoticeText("AuthRequired https://mcp.slack.com", { label: `@${handle}` }),
      cliFailureNoticeText("boom", { label: `@${handle}` }),
      `@${handle} stopped by user.`,
      `Stop not confirmed for @${handle}: the machine did not confirm the run is gone.`,
      `@${handle} could not continue after this approval: the run ended.`,
      `@${handle} run was interrupted before a response was produced.`,
      `@${handle} run failed before a response was produced: @${handle} belongs to another machine; no local session was started.`,
      `@${handle} could not start: the server did not give @${handle} this turn: stale.`,
      `@${handle} cannot start on this computer: Claude Code is not signed in. Fix it in Settings → Local CLI setup, or start the chat on another provider.`,
      `@${handle}: app tools may be unavailable; failed to update the Antigravity MCP config (EACCES).`,
      `@${handle}: previous CLI session was unavailable, so a new session was started from saved chat context.`,
      `@${handle} runs on a cloud machine, which this device reaches only through your server; it is not linked to it yet`,
      `@${handle} stopped before pending approval was resolved.`,
      `Participant mentions in @${handle}'s message were not triggered because inferred-request processing failed.`,
      `Could not compact @${handle} context: the machine ended the compaction without saying how it went.`,
      `@${handle} is busy. Restart it when it is done.`,
      `Could not restart @${handle}: its process did not close (EPERM).`,
      `@${handle} is already moving.`,
      // Status lines (progress).
      `Compacting @${handle}.`,
      `Compacted @${handle}.`,
      `Restarting @${handle}. Waiting for machine Office Mac`,
      `Restarted @${handle} and stopped its 2 background tasks. Its next reply picks up the current connectors and settings.`,
      `@${handle} is responding.`,
      `@${handle} finished.`,
      `Returning to @${handle}.`,
      `Resuming @${handle} after permission approval.`,
      // Cards (approval questions, options, summaries, outcomes).
      `Do you want to allow @${handle} to use Bash?`,
      `No, tell @${handle} what to do differently`,
      `Yes, allow @${handle} to use WebFetch in this chat`,
      `@${handle} needs approval before Codex can continue`,
      `@${handle} wants to add a member to this chat`,
      `@${handle} wants to remove @gone from this chat`,
      `This happens once @${handle}'s turn has ended and no member is running.`,
      `Applies only to @${handle}. Other members still ask.`,
      `@${handle} needs you to sign in to claude.ai Gmail`,
      `Signing in to Slack finishes in a browser on the computer @${handle} runs on.`,
      `Compact @${handle} context`,
      `Grant @${handle} file edits`,
      `Queued — waiting for @${handle} to finish`,
      `Alerts aren't set up, so @${handle} could reach you only here.`,
      `v2 · note by @${handle}`,
      `by @${handle}`,
      `Urgent alert from @${handle}`
    ])
  ];
}

test("app-made texts in a sessions-view chat name no handle: the main session by nothing, a member by its task", () => {
  for (const text of appTexts("main", "drew")) {
    const shown = sessionsViewText(text, NAMES);
    assert.doesNotMatch(shown, HANDLE, `${text}\n→ ${shown}`);
    assert.doesNotMatch(shown, /\bmain\b/i, `no "main" label: ${shown}`);
    assert.doesNotMatch(shown, /[\uE000-\uE002]/, "no marks left");
    if (text.includes("@drew")) assert.match(shown, /“Fix the logout”/, `the member by its task: ${shown}`);
  }
});

test("the classic view keeps every app-made text exactly as written", () => {
  for (const text of appTexts("main", "drew")) {
    assert.equal(sessionsViewText(text, undefined), text);
  }
});

test("the fork notices read without a subject", () => {
  assert.equal(
    sessionsViewText("@main's copy of @main's session may include what @main did after you tapped Fork: its session file could not be read.", NAMES),
    "The copy may include what was done after you tapped Fork: its session file could not be read."
  );
  assert.equal(
    sessionsViewText("@main could not start from a copy of @main's session in the chat \"Remember the word APPLE\", so its next turn starts a clean session.", NAMES),
    "Could not start from a copy of the session in the chat \"Remember the word APPLE\", so the next turn starts a clean session."
  );
  assert.equal(
    sessionsViewText("@main could not start from a copy of @x's session in the chat \"T\": that session is not on the cloud machine @main runs on, so it starts a clean session.", NAMES),
    "Could not start from a copy of the session in the chat \"T\": that session is not on the cloud machine it runs on, so this chat starts a clean session."
  );
  assert.equal(
    sessionsViewText("@drew could not start from a copy of @main's session, so its next turn starts a clean session.", NAMES),
    "“Fix the logout” could not start from a copy of this chat's session, so its next turn starts a clean session."
  );
  // Cut to the notices' length, the start still reads right.
  assert.equal(
    sessionsViewText("@main could not start from a copy of @x's session in the chat \"A very long title...", NAMES),
    "Could not start from a copy of the session in the chat \"A very long title..."
  );
});

test("sentences about the main session lose their subject; actions done to it lose the name", () => {
  const cases: Array<[string, string]> = [
    ["@main stopped before it returned a response.", "Stopped before it returned a response."],
    ["@main stopped by user.", "Stopped by user."],
    ["@main: app tools may be unavailable.", "App tools may be unavailable."],
    ["Stop not confirmed for @main: the machine did not confirm the run is gone.", "Stop not confirmed: the machine did not confirm the run is gone."],
    ["Do you want to allow @main to use Bash?", "Do you want to allow it to use Bash?"],
    ["Restarted @main and stopped its 2 background tasks.", "Restarted and stopped its 2 background tasks."],
    ["Could not compact @main context: no session.", "Could not compact the context: no session."],
    ["Took @main's session over.", "Took the session over."],
    ["@main's session could not be moved here.", "The session could not be moved here."],
    ["Urgent alert from @main", "Urgent alert"],
    ["Waiting on it. @main is responding.", "Waiting on it. It is responding."],
    ["@main was cancelled before it returned a response.", "It was cancelled before it returned a response."],
    ["@main is busy. Restart it when it is done.", "It is busy. Restart it when it is done."],
    ["Returning to @main.", "Returning."],
    ["Returning choice to @main.", "Returning the choice."],
    ["by @main", ""],
    ["v2 · note by @main", "v2 · note"]
  ];
  for (const [text, shown] of cases) assert.equal(sessionsViewText(text, NAMES), shown);
});

test("members are named by their task in quotes; a handle of nobody stays as written", () => {
  assert.equal(sessionsViewText("@drew stopped by user.", NAMES), "“Fix the logout” stopped by user.");
  assert.equal(sessionsViewText("Took @drew's session over.", NAMES), "Took “Fix the logout”’s session over.");
  assert.equal(sessionsViewText("No member named @nobody.", NAMES), "No member named @nobody.");
  assert.equal(sessionsViewText("mail me at a@main.com or see @types/node", NAMES), "mail me at a@main.com or see @types/node");
});

test("a label names the main session by nothing and a member by its task", () => {
  assert.equal(sessionsViewLabel("@main", NAMES), "");
  assert.equal(sessionsViewLabel("drew", NAMES), "Fix the logout");
  assert.equal(sessionsViewLabel("@stranger", NAMES), "stranger");
});

test("a chat's names: only in the sessions view, members by their latest task, former members too", () => {
  const main = { id: "m", handle: "main", kind: "claude-code", roleConfigId: "main-session" } as ChatParticipant;
  const drew = { id: "d", handle: "drew", kind: "codex-cli" } as ChatParticipant;
  const task: ChatMessage = {
    id: "t", role: "participant", participantId: "m", content: "", createdAt: "2026-11-20T10:00:00.000Z",
    metadata: { participantRequest: { requesterParticipantId: "m", items: [
      { id: "i1", targetParticipantId: "d", targetHandle: "drew", prompt: "Fix the logout.", status: "running", createdAt: "2026-11-20T10:00:00.000Z" },
      { id: "i2", targetParticipantId: "g", targetHandle: "gone", prompt: "Check the docs.", title: "Docs check", status: "answered", createdAt: "2026-11-20T10:00:00.000Z" }
    ] } }
  } as unknown as ChatMessage;
  const chat = { metadata: { participants: [main, drew], mainSessionParticipantId: "m", chatView: "sessions" as const }, messages: [task] };
  const names = sessionsViewNamesOf(chat);
  assert.ok(names);
  assert.equal(names.mainHandle, "main");
  assert.equal(names.titleOf("drew"), "Fix the logout");
  assert.equal(names.titleOf("@GONE"), "Docs check");
  assert.equal(sessionsViewNamesOf({ ...chat, metadata: { ...chat.metadata, chatView: "classic" } }), undefined);
  assert.equal(sessionsViewNamesOf({ ...chat, metadata: { participants: [main, drew] } } as never), undefined, "a chat without a main session is classic");
});

test("a failed or stopped reply: only the app's own paragraphs lose their handles; what the member wrote stays its own", () => {
  const streamed = "Plan: I'll ask @drew to run the tests and tell @main.";
  assert.equal(sessionsViewReplyText("@main stopped before it returned a response.", "main", NAMES), "Stopped before it returned a response.");
  assert.equal(
    sessionsViewReplyText(`${streamed}\n\nStop not confirmed for @main: the machine did not confirm the run is gone.`, "@main", NAMES),
    `${streamed}\n\nStop not confirmed: the machine did not confirm the run is gone.`
  );
  assert.equal(
    sessionsViewReplyText(`@drew cannot start on this computer: Codex is not signed in.\n\n${streamed}`, "drew", NAMES),
    `“Fix the logout” cannot start on this computer: Codex is not signed in.\n\n${streamed}`
  );
  assert.equal(sessionsViewReplyText(streamed, "main", NAMES), streamed, "a member's words alone are never rewritten");
  assert.equal(sessionsViewReplyText("@main stopped by user.", "main", undefined), "@main stopped by user.", "classic: as written");
});

test("an approval's summary: who asks and whom it names lose their handles; a tool's request and quoted words stay exactly as written", () => {
  assert.equal(sessionsViewSummaryText("Grant @drew file edits", NAMES), "Grant “Fix the logout” file edits");
  assert.equal(sessionsViewSummaryText("Remove @gone from this chat", NAMES), "Remove “Check the docs” from this chat");
  assert.equal(sessionsViewSummaryText("Use Bash: git log @main..HEAD && echo @drew", NAMES), "Use Bash: git log @main..HEAD && echo @drew");
  assert.equal(sessionsViewSummaryText("Codex wants to run: git log @main..HEAD", NAMES), "Codex wants to run: git log @main..HEAD");
  assert.equal(sessionsViewSummaryText("Codex Auto Review denied: npm publish --tag @drew", NAMES), "Codex Auto Review denied: npm publish --tag @drew");
  assert.equal(sessionsViewSummaryText("Grant @drew shell allow prefix \"npm publish --tag @main\"", NAMES), "Grant “Fix the logout” shell allow prefix \"npm publish --tag @main\"");
  assert.equal(sessionsViewText("Run `echo @drew` for @drew", NAMES), "Run `echo @drew` for “Fix the logout”", "code stays as written");
});

test("the main session in a list of names is left out of it; a title naming someone and stray marks never bring a handle or a mark back", () => {
  assert.equal(sessionsViewText("@main, @drew", NAMES), "“Fix the logout”");
  assert.equal(sessionsViewText("Waiting for @drew and @main to finish.", NAMES), "Waiting for “Fix the logout” to finish.");
  const titled = sessionsViewNames("main", [["gera", "Ask @drew to check the docs"]]);
  assert.equal(sessionsViewText("@gera stopped by user.", titled), "“Ask drew to check the docs” stopped by user.");
  assert.equal(sessionsViewText("\uE000 stray \uE001mark\uE002: @drew stopped by user.", NAMES), " stray mark: “Fix the logout” stopped by user.");
  assert.equal(sessionsViewLabel(undefined, NAMES), "");
  assert.equal(sessionsViewLabel(42 as unknown as string, NAMES), "");
});

test("a member's own words in one plain line are read by the view's mention rule: a member by its task, the main session as a plain word", () => {
  assert.equal(sessionsMentionText("First, ask @main which colour; then tell @drew and @nobody.", NAMES), "First, ask main which colour; then tell Fix the logout and @nobody.");
  assert.equal(sessionsMentionText("mail a@drew.dev about @types/node", NAMES), "mail a@drew.dev about @types/node");
  assert.equal(sessionsMentionText("ask @main", undefined), "ask @main", "classic: as written");
});
