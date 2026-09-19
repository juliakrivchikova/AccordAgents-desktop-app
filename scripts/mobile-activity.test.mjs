// What the phone's Activity tab lists, worked out from rows the relay
// delivered. Pure: the same module the shell loads, run under node.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildActivity, attentionCount, WINDOW_DAYS, PREVIEW_SOURCE_LIMIT } = require("../src/mobile/mobile-activity.js");

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const chats = [
  { id: "c-polish", title: "PWA polish round" },
  { id: "c-cloud", title: "Cloud machine setup" }
];

const done = (id, conversationId, label, minutesAgo, extra = {}) => ({
  id: `${conversationId}:${id}`, sourceId: id, messageId: id, conversationId, role: "participant",
  participantLabel: label, content: `message ${id}`, status: "done", createdAt: at(minutesAgo), ...extra
});
const running = (id, conversationId, label, minutesAgo, extra = {}) => ({
  id: `${conversationId}:${id}`, conversationId, role: "participant", participantLabel: label,
  content: "Working", status: "pending", runId: `run-${id}`, createdAt: at(minutesAgo), ...extra
});

test("finished updates collapse to one row per chat and member, newest first, with a count", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      done("m1", "c-polish", "@drew", 30),
      done("m2", "c-polish", "@drew", 7),
      done("m3", "c-polish", "@drew", 12),
      done("m4", "c-cloud", "@morgan", 18),
      done("m5", "c-polish", "@taylor", 60)
    ],
    unreadConversationIds: ["c-polish", "c-cloud"],
    viewedAt: {}
  });
  assert.deepEqual(activity.finished.map((row) => [row.chatTitle, row.handle, row.count, row.preview]), [
    ["PWA polish round", "@drew", 3, "message m2"],
    ["Cloud machine setup", "@morgan", 1, "message m4"],
    ["PWA polish round", "@taylor", 1, "message m5"]
  ]);
  assert.equal(activity.finished[0].messageId, "m2");
});

test("handles that differ only in case are one member", () => {
  const activity = buildActivity({ now: NOW, chats, entries: [done("a", "c-polish", "@Drew", 3), done("b", "c-polish", "@drew", 2)] });
  assert.deepEqual(activity.finished.map((row) => row.count), [2]);
});

test("updates are counted per run, as the desktop counts them", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      done("note", "c-polish", "@drew", 8, { runId: "run-a" }),
      done("answer", "c-polish", "@drew", 7, { runId: "run-a" }),
      done("later", "c-polish", "@drew", 2, { runId: "run-b" })
    ]
  });
  assert.equal(activity.finished[0].count, 2);
  assert.equal(activity.finished[0].messageId, "later");
});

test("the same message stored twice is one update, not two", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [done("m1", "c-polish", "@drew", 5), { ...done("m1", "c-polish", "@drew", 5), id: "c-polish:page:m1" }]
  });
  assert.equal(activity.finished.length, 1);
  assert.equal(activity.finished[0].count, 1);
});

test("an update is seen once the chat was opened after it reached this phone, whatever the desktop's clock says", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      // The desktop's clock runs ahead: stamped in the future, received 20 minutes ago.
      done("m1", "c-polish", "@drew", -90, { receivedAt: at(20) }),
      // Stamped long ago by the desktop, but only just reached the phone.
      done("m2", "c-cloud", "@morgan", 50, { receivedAt: at(1) })
    ],
    unreadConversationIds: ["c-cloud"],
    viewedAt: { "c-polish": at(10), "c-cloud": at(10) }
  });
  const byChat = Object.fromEntries(activity.finished.map((row) => [row.conversationId, row.read]));
  assert.deepEqual(byChat, { "c-polish": true, "c-cloud": false });
});

test("a group is unseen while any of its updates arrived after the last look", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      done("new", "c-polish", "@drew", 30, { receivedAt: at(2) }),
      done("newest", "c-polish", "@drew", 5, { receivedAt: at(20) })
    ],
    viewedAt: { "c-polish": at(10) }
  });
  assert.equal(activity.finished[0].read, false);
});

test("with no look recorded yet, the chat's unread dot decides", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [done("m1", "c-polish", "@drew", 30), done("m2", "c-cloud", "@morgan", 5)],
    unreadConversationIds: ["c-cloud"],
    viewedAt: {}
  });
  const byChat = Object.fromEntries(activity.finished.map((row) => [row.conversationId, row.read]));
  assert.deepEqual(byChat, { "c-polish": true, "c-cloud": false });
});

test("a long run the phone watched finish is listed by when it finished", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      done("long", "c-polish", "@drew", 40, { settledAt: at(1), receivedAt: at(1) }),
      done("short", "c-cloud", "@morgan", 5)
    ]
  });
  assert.deepEqual(activity.finished.map((row) => [row.conversationId, row.at]), [["c-polish", at(1)], ["c-cloud", at(5)]]);
});

test("updates older than the window and system rows are left out", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      done("old", "c-polish", "@drew", (WINDOW_DAYS + 1) * 24 * 60),
      { ...done("sys", "c-polish", "", 3), role: "system" }
    ]
  });
  assert.equal(activity.finished.length, 0);
});

test("only chats the desktop lists are shown; with no list, nothing is", () => {
  const entries = [done("m1", "c-archived", "@drew", 3), done("m2", "c-polish", "@drew", 3), running("r", "c-archived", "@drew", 2)];
  const cardsByConversation = {
    "c-archived": [{ id: "old-choice", kind: "choice", conversationId: "c-archived", summary: "Still?", status: "pending", createdAt: at(1) }]
  };
  const listed = buildActivity({ now: NOW, chats, entries, cardsByConversation });
  assert.deepEqual(listed.finished.map((row) => row.conversationId), ["c-polish"]);
  assert.deepEqual(listed.pending, []);
  assert.deepEqual(listed.running, []);
  const none = buildActivity({ now: NOW, chats: [], entries, cardsByConversation });
  assert.deepEqual([none.running.length, none.pending.length, none.finished.length], [0, 0, 0]);
  const hidden = buildActivity({ now: NOW, chats, entries, hiddenConversationIds: ["c-polish"] });
  assert.deepEqual(hidden.finished, []);
});

test("a run in progress is listed once per run and member, with the member's row over the early one", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      { id: "c-polish:run-1:participant", conversationId: "c-polish", role: "participant", content: "Running...", status: "pending", runId: "run-1", createdAt: at(3) },
      { id: "c-polish:run-1:@taylor", conversationId: "c-polish", role: "participant", participantLabel: "@taylor", content: "Reviewing the diff now.", status: "pending", runId: "run-1", createdAt: at(2) },
      { id: "c-cloud:run-2:@morgan", conversationId: "c-cloud", role: "participant", participantLabel: "@morgan", content: "@morgan is running...", status: "pending", runId: "run-2", createdAt: at(1) }
    ]
  });
  assert.deepEqual(activity.running.map((row) => [row.chatTitle, row.handle, row.preview, row.runId, row.cancellable]), [
    ["Cloud machine setup", "@morgan", "", "run-2", false],
    ["PWA polish round", "@taylor", "Reviewing the diff now.", "run-1", true]
  ]);
});

test("a run that names nobody yet is listed, and cannot be stopped", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [{ id: "c-polish:r", conversationId: "c-polish", role: "participant", content: "Running...", status: "pending", runId: "r", createdAt: at(1) }]
  });
  assert.deepEqual(activity.running.map((row) => [row.handle, row.preview, row.cancellable]), [["", "", false]]);
});

test("an early row under another key goes once the chat has a member's run", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      { id: "c-polish:e1", conversationId: "c-polish", role: "participant", content: "Running...", status: "pending", mobileEventId: "e1", createdAt: at(3) },
      running("1", "c-polish", "@taylor", 2)
    ]
  });
  assert.deepEqual(activity.running.map((row) => row.handle), ["@taylor"]);
});

test("the chat's own placeholder rule is the one used", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [running("1", "c-polish", "@taylor", 2, { content: "Warming up" })],
    isPlaceholder: (content) => content === "Warming up"
  });
  assert.deepEqual(activity.running.map((row) => [row.preview, row.cancellable]), [["", false]]);
});

test("a run this phone saw end is not listed as running, and its messages are not finished while it runs", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [
      running("1", "c-polish", "@taylor", 2),
      done("partial", "c-polish", "@taylor", 1, { runId: "run-1" }),
      running("9", "c-cloud", "@morgan", 2)
    ],
    isRunSettled: (runId) => runId === "run-9"
  });
  assert.deepEqual(activity.running.map((row) => row.runId), ["run-1"]);
  assert.deepEqual(activity.finished, []);
});

test("a row still in progress from before a chat list that says nothing runs there is not listed", () => {
  const activity = buildActivity({
    now: NOW,
    chats: [
      { id: "c-polish", title: "PWA polish round", running: false },
      { id: "c-cloud", title: "Cloud machine setup", running: true },
      { id: "c-new", title: "New chat", running: false },
      { id: "c-machine", title: "Machine chat", running: false }
    ],
    chatListAt: at(10),
    entries: [
      // Reached the phone 60 minutes ago; the list 50 minutes later says nothing runs.
      running("p", "c-polish", "@taylor", 60, { receivedAt: at(60) }),
      running("c", "c-cloud", "@taylor", 60, { receivedAt: at(60) }),
      // Reached the phone after the list was taken: the list cannot speak for it,
      // even though the desktop stamped it long ago.
      running("n", "c-new", "@taylor", 90, { receivedAt: at(2) }),
      // This phone started it on a machine itself and knows it is going.
      running("m", "c-machine", "@taylor", 60, { receivedAt: at(60) })
    ],
    isRunKnownLive: (runId) => runId === "run-m"
  });
  assert.deepEqual(activity.running.map((row) => row.conversationId).sort(), ["c-cloud", "c-machine", "c-new"]);
});

test("a stop already asked for is shown as stopping", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [running("1", "c-polish", "@taylor", 2)],
    isStopRequested: (runId) => runId === "run-1"
  });
  assert.equal(activity.running[0].stopping, true);
});

test("pending lists every open card across chats; a permission keeps every word, a choice its question", () => {
  const longCommand = "Codex wants to run: " + "echo ok; ".repeat(60) + "\nrm -rf build";
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [],
    cardsByConversation: {
      "c-polish": [
        { id: "choice-1", kind: "choice", conversationId: "c-polish", title: "Deploy target", summary: "Where should this deploy go?", requesterLabel: "@taylor", options: [], status: "pending", createdAt: at(0) },
        { id: "done-1", kind: "choice", conversationId: "c-polish", title: "Old", summary: "Answered already", status: "answered", createdAt: at(5) }
      ],
      "c-cloud": [
        { id: "perm-1", kind: "permission", conversationId: "c-cloud", title: "Run", summary: longCommand, requesterLabel: "@drew", machineName: "Cloud · eu-west-1", options: [{ id: "allow" }, { id: "deny" }], status: "pending", createdAt: at(1) }
      ]
    }
  });
  assert.deepEqual(activity.pending.map((row) => [row.kind, row.chatTitle, row.handle]), [
    ["choice", "PWA polish round", "@taylor"],
    ["permission", "Cloud machine setup", "@drew"]
  ]);
  assert.equal(activity.pending[0].preview, "Where should this deploy go?");
  assert.equal(activity.pending[1].preview, longCommand, "nothing of what is being allowed is cut or reflowed");
  assert.equal(activity.pending[1].machineName, "Cloud · eu-west-1");
});

test("the message a waiting choice belongs to is pending, not also a finished update", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [done("q1", "c-polish", "@taylor", 1), done("m0", "c-polish", "@taylor", 9)],
    cardsByConversation: {
      "c-polish": [{ id: "choice-1", kind: "choice", conversationId: "c-polish", summary: "Where?", requesterLabel: "@taylor", status: "pending", createdAt: at(1), sourceMessageId: "q1" }]
    }
  });
  assert.equal(activity.pending.length, 1);
  assert.deepEqual(activity.finished.map((row) => [row.messageId, row.count]), [["m0", 1]]);
});

test("finished is capped at fifty rows, newest kept, and previews are whole-word-agnostic slices", () => {
  const entries = [];
  const bigChats = [];
  for (let index = 0; index < 60; index += 1) {
    bigChats.push({ id: `c-${index}`, title: `Chat ${index}` });
    entries.push(done(`m${index}`, `c-${index}`, "@drew", index + 1, { content: "  word\n\n".repeat(400) }));
  }
  const activity = buildActivity({ now: NOW, chats: bigChats, entries });
  assert.equal(activity.finished.length, 50);
  assert.equal(activity.finished[0].conversationId, "c-0");
  assert.ok(activity.finished[0].preview.length <= 220);
  assert.doesNotMatch(activity.finished[0].preview, /\s{2}/);
  assert.ok(PREVIEW_SOURCE_LIMIT >= 220);
});

test("the tab's number is what waits for the User plus unseen finished updates", () => {
  const activity = buildActivity({
    now: NOW,
    chats,
    entries: [done("m1", "c-polish", "@drew", 3), done("m2", "c-cloud", "@morgan", 3)],
    unreadConversationIds: ["c-polish"],
    cardsByConversation: {
      "c-cloud": [{ id: "perm-1", kind: "permission", conversationId: "c-cloud", summary: "x", status: "pending", createdAt: at(1) }]
    }
  });
  assert.equal(attentionCount(activity), 2);
  assert.equal(attentionCount(undefined), 0);
});
