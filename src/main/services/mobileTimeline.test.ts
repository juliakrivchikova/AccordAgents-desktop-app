import assert from "node:assert/strict";
import test from "node:test";
import { timelineEventsFromSnapshot } from "./mobileTimeline";
import { mobileWhoLabel } from "./mobileChatCatalog";
import type { Conversation } from "../../shared/types";

// What the User's server serves the phone as a chat's page (mobileChatCatalog
// builds it with these), carried over from the relay's control tests.

test("an empty pending participant is visible before output and after reconnect", () => {
  const conversation: Conversation = {
    id: "waiting-chat", kind: "chat", title: "Waiting", createdAt: "2026-09-12T20:00:00Z",
    updatedAt: "2026-09-12T20:00:00Z", findings: [], metadata: {},
    messages: [{
      id: "waiting-message", role: "participant", participantLabel: "@drew", content: "",
      status: "pending", createdAt: "2026-09-12T20:00:00Z",
      metadata: { runId: "waiting-run", chatThreadRootId: "question" }
    }]
  };
  assert.deepEqual(timelineEventsFromSnapshot(conversation), [{
    id: "waiting-message", messageId: "waiting-message", threadRootId: "question",
    role: "participant", participantLabel: "@drew", content: "@drew is running...",
    status: "pending", createdAt: "2026-09-12T20:00:00Z", runId: "waiting-run"
  }]);
  conversation.messages[0].status = "error";
  conversation.messages[0].content = "Interrupted before completion.";
  const terminal = timelineEventsFromSnapshot(conversation)[0];
  assert.equal(terminal.id, "waiting-message");
  assert.equal(terminal.status, "error");
  assert.equal(terminal.content, "Interrupted before completion.");
});

test("the phone timeline carries image attachments as metadata, and a caption-less image is not dropped", () => {
  const conversation = {
    id: "conversation-attachments",
    kind: "chat" as const,
    title: "Attachments",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:02.000Z",
    messages: [
      {
        id: "message-with-caption",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "here is the screen",
        createdAt: "2026-09-01T00:00:01.000Z",
        status: "done" as const,
        metadata: {
          imageAttachments: [{
            id: "attachment-1",
            filename: "shot.png",
            mimeType: "image/png" as const,
            sizeBytes: 597423,
            width: 1206,
            height: 2622,
            storageKey: "attachments/attachment-1.png",
            createdAt: "2026-09-01T00:00:01.000Z"
          }]
        }
      },
      {
        id: "message-image-only",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "",
        createdAt: "2026-09-01T00:00:02.000Z",
        status: "done" as const,
        metadata: {
          imageAttachments: [{
            id: "attachment-2",
            filename: "second.png",
            mimeType: "image/png" as const,
            sizeBytes: 1024,
            width: 10,
            height: 20,
            storageKey: "attachments/attachment-2.png",
            createdAt: "2026-09-01T00:00:02.000Z"
          }]
        }
      },
      {
        id: "message-empty",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "   ",
        createdAt: "2026-09-01T00:00:03.000Z",
        status: "done" as const
      }
    ],
    findings: [],
    metadata: {}
  };

  const events = timelineEventsFromSnapshot(conversation as never);
  assert.deepEqual(events.map((event) => event.id), ["message-with-caption", "message-image-only"]);
  assert.deepEqual(events[0].attachments, [{
    id: "attachment-1",
    filename: "shot.png",
    mimeType: "image/png",
    sizeBytes: 597423,
    width: 1206,
    height: 2622
  }]);
  // The bytes and the desktop-only storage path must not travel to the phone:
  // this projection re-sends the last forty rows on every batch.
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /storageKey/);
  assert.doesNotMatch(serialized, /dataBase64/);
  assert.equal(events[1].content, "");
  assert.equal(events[1].attachments?.[0].id, "attachment-2");
});

test("the phone timeline hides what the desktop hides: internal system triggers, but not artifact notes", () => {
  const conversation = {
    id: "conversation-system",
    kind: "chat" as const,
    title: "System rows",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:05.000Z",
    messages: [
      {
        id: "user-ask",
        role: "user" as const,
        content: "@claude ask codex",
        createdAt: "2026-09-01T00:00:01.000Z",
        status: "done" as const
      },
      {
        id: "auto-resume",
        role: "system" as const,
        content: "Auto-resumed @claude after member request.\nTarget replies/errors are in the transcript above.",
        createdAt: "2026-09-01T00:00:02.000Z",
        status: "done" as const,
        metadata: { sourceMessageId: "user-ask" }
      },
      {
        id: "hidden-carrier",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@claude",
        content: "context the desktop never shows",
        createdAt: "2026-09-01T00:00:03.000Z",
        status: "done" as const,
        metadata: { hiddenFromTimeline: true }
      },
      {
        id: "artifact-note",
        role: "system" as const,
        content: "@gera revised [Plan] · v3",
        createdAt: "2026-09-01T00:00:04.000Z",
        status: "done" as const,
        metadata: { appMessageSource: "app_artifact_note" }
      },
      {
        id: "answer",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@claude",
        content: "Done.",
        createdAt: "2026-09-01T00:00:05.000Z",
        status: "done" as const
      }
    ],
    findings: [],
    metadata: {}
  };

  // The hidden member row travels flagged (it may end a run — next test); the
  // internal system row does not travel at all.
  assert.deepEqual(timelineEventsFromSnapshot(conversation as never).map((event) => [event.id, event.hidden === true]),
    [["user-ask", false], ["hidden-carrier", true], ["artifact-note", false], ["answer", false]]);
  const serialized = JSON.stringify(timelineEventsFromSnapshot(conversation as never));
  assert.doesNotMatch(serialized, /Auto-resumed/);
});

test("a hidden member message still travels to the phone, flagged, so the run it ends can settle", () => {
  const conversation = {
    id: "conversation-hidden-terminal",
    kind: "chat" as const,
    title: "Hidden terminal",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:04.000Z",
    messages: [
      {
        id: "user-ask",
        role: "user" as const,
        content: "@drew ask taylor",
        createdAt: "2026-09-01T00:00:01.000Z",
        status: "done" as const
      },
      {
        id: "waiting",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "Awaiting user approval.",
        createdAt: "2026-09-01T00:00:02.000Z",
        status: "done" as const,
        metadata: { runId: "run-1" }
      },
      {
        id: "carrier",
        role: "participant" as const,
        participantId: "participant-1",
        participantLabel: "@drew",
        content: "@drew asked @taylor: review this",
        createdAt: "2026-09-01T00:00:03.000Z",
        status: "done" as const,
        metadata: {
          hiddenFromTimeline: true,
          participantRequest: { source: "inferred", triggerMessageId: "user-ask", items: [] }
        }
      },
      {
        id: "auto-resume",
        role: "system" as const,
        content: "Auto-resumed @drew after member request.",
        createdAt: "2026-09-01T00:00:04.000Z",
        status: "done" as const
      }
    ],
    findings: [],
    metadata: {}
  };
  const events = timelineEventsFromSnapshot(conversation as never);
  assert.deepEqual(events.map((event) => [event.id, event.hidden === true]), [
    ["user-ask", false],
    ["waiting", true],
    ["carrier", true]
  ]);
  assert.equal(events[1].runId, "run-1", "the terminal keeps the run it ends");
});

test("Activity on the phone gets each chat's running turns and members' replies of the last week, short and without pictures", async () => {
  const { phoneActivityEvents, PHONE_ACTIVITY_CONTENT_CHARS } = await import("./mobileTimeline");
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  const at = (daysAgo: number) => new Date(now - daysAgo * 24 * 60 * 60_000).toISOString();
  const conversation = {
    id: "chat-activity", kind: "chat", title: "A", createdAt: at(30), updatedAt: at(0), findings: [], metadata: {},
    messages: [
      { id: "old-done", role: "participant", participantId: "p1", participantLabel: "@drew", content: "last month", createdAt: at(9), status: "done" },
      { id: "u1", role: "user", content: "@drew go", createdAt: at(2) },
      { id: "drew-1", role: "participant", participantId: "p1", participantLabel: "@drew", content: "first", createdAt: at(2), status: "done", metadata: { runId: "r1" } },
      { id: "drew-2", role: "participant", participantId: "p1", participantLabel: "@drew", content: "x".repeat(2000), createdAt: at(1), status: "done", metadata: { runId: "r2" },
        attachments: [{ id: "a", filename: "p.png", mimeType: "image/png", size: 10 }] },
      { id: "taylor-run", role: "participant", participantId: "p2", participantLabel: "@taylor", content: "", createdAt: at(0), status: "pending", metadata: { runId: "r3" } },
      { id: "hidden", role: "participant", participantId: "p2", participantLabel: "@taylor", content: "waiting", createdAt: at(0), status: "done", metadata: { runId: "r4", hiddenFromTimeline: true } },
      { id: "failed", role: "participant", participantId: "p3", participantLabel: "@admin", content: "boom", createdAt: at(0), status: "error", metadata: { runId: "r5" } },
      { id: "drew-asks", role: "participant", participantId: "p1", participantLabel: "@drew", content: "Which one?", createdAt: at(0), status: "done",
        metadata: { runId: "r6", pendingChoice: { id: "c1", status: "pending", options: [] } } }
    ]
  } as unknown as Conversation;
  const events = phoneActivityEvents(conversation, now);
  assert.deepEqual(events.map((event) => [event.id, event.status]), [["drew-2", "done"], ["taylor-run", "pending"], ["drew-asks", "done"]],
    "the newest finished reply of each member this week, the reply its open question belongs to, and each run going on; nothing older, hidden or user-written");
  assert.equal(events[0].content.length, PHONE_ACTIVITY_CONTENT_CHARS);
  assert.equal("attachments" in events[0], false);
  assert.equal(events[1].runId, "r3");
  assert.deepEqual(phoneActivityEvents({ ...conversation, messages: conversation.messages.slice(0, 2) } as Conversation, now), [], "a quiet chat has none");
});

test("a busy chat sends the phone its newest activity, never more than the cap", async () => {
  const { phoneActivityEvents, PHONE_ACTIVITY_PER_CHAT } = await import("./mobileTimeline");
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `m${index}`, role: "participant", participantId: `p${index}`, participantLabel: `@m${index}`, content: `reply ${index}`,
    createdAt: new Date(now - (12 - index) * 60_000).toISOString(), status: "done"
  }));
  const events = phoneActivityEvents({ id: "busy", kind: "chat", title: "B", createdAt: "", updatedAt: "", findings: [], metadata: {}, messages } as unknown as Conversation, now);
  assert.equal(events.length, PHONE_ACTIVITY_PER_CHAT);
  assert.equal(events[events.length - 1].id, "m11", "the newest is kept");
  assert.equal(events[0].id, `m${12 - PHONE_ACTIVITY_PER_CHAT}`);
});

test("a member's posts during its turn are marked, and a turn that ends empty still ends on the phone", () => {
  const member = { participantId: "taylor", participantLabel: "@taylor" };
  const conversation: Conversation = {
    id: "posting-chat", kind: "chat", title: "Posting", createdAt: "2026-10-31T20:00:00Z",
    updatedAt: "2026-10-31T20:05:00Z", findings: [], metadata: {},
    messages: [
      { id: "turn", role: "participant", ...member, content: "", status: "done", createdAt: "2026-10-31T20:00:00Z", metadata: { runId: "run-1" } },
      { id: "post", role: "participant", ...member, content: "Halfway there.", status: "done", createdAt: "2026-10-31T20:01:00Z",
        metadata: { runId: "run-1", appMessageSource: "app_chat_send_message" } },
      { id: "next-turn", role: "participant", ...member, content: "", status: "pending", createdAt: "2026-10-31T20:02:00Z", metadata: { runId: "run-2" } },
      { id: "answer", role: "participant", ...member, content: "Done.", status: "done", createdAt: "2026-10-31T20:03:00Z", metadata: { runId: "run-3" } }
    ]
  };
  const events = Object.fromEntries(timelineEventsFromSnapshot(conversation).map((event) => [event.id, event]));
  // The empty end of a turn travels hidden, so the phone settles the turn.
  assert.equal(events.turn?.hidden, true);
  assert.equal(events.turn?.status, "done");
  assert.equal(events.turn?.midTurn, undefined);
  // A post during the turn says so: it ends no run.
  assert.equal(events.post?.midTurn, true);
  assert.equal(events.post?.hidden, undefined);
  // A turn still running and a real answer are as they were.
  assert.equal(events["next-turn"]?.hidden, undefined);
  assert.equal(events["next-turn"]?.status, "pending");
  assert.equal(events.answer?.midTurn, undefined);
  assert.equal(events.answer?.hidden, undefined);
});

test("a part of a turn her next message joined travels with its steps even with no words in the sessions view; elsewhere, or with nothing in it, it travels hidden", () => {
  const member = { participantId: "taylor", participantLabel: "@taylor" };
  const steps = [{ id: "a1", sequence: 1, kind: "command" as const, label: "Running npm test", createdAt: "2026-11-22T10:00:01Z" }];
  const conversation: Conversation = {
    id: "joined-chat", kind: "chat", title: "Joined", createdAt: "2026-11-22T10:00:00Z", updatedAt: "2026-11-22T10:00:03Z", findings: [], metadata: { mainSessionParticipantId: "taylor", chatView: "sessions", participants: [{ id: "taylor", handle: "taylor", kind: "claude-code", roleConfigId: "main-session" }] },
    messages: [
      { id: "steps-only", role: "participant", ...member, content: "", status: "done", createdAt: "2026-11-22T10:00:00Z",
        metadata: { runId: "run-1", turnContinues: true, activityEvents: steps } },
      { id: "nothing", role: "participant", ...member, content: "", status: "done", createdAt: "2026-11-22T10:00:02Z",
        metadata: { runId: "run-2", turnContinues: true } }
    ]
  };
  const events = Object.fromEntries(timelineEventsFromSnapshot(conversation).map((event) => [event.id, event]));
  assert.equal(events["steps-only"]?.hidden, undefined, "its steps are what it says");
  assert.equal(events["steps-only"]?.turnContinues, true);
  assert.ok(events["steps-only"]?.activity?.length);
  assert.equal(events.nothing?.hidden, true);
  const classic = Object.fromEntries(timelineEventsFromSnapshot({ ...conversation, metadata: { ...conversation.metadata, chatView: "classic" } }).map((event) => [event.id, event]));
  assert.equal(classic["steps-only"]?.hidden, true, "a classic chat's phone draws no steps: the part ends its run unseen");
});

test("a reply's posts during its turn travel inside it to the phone, and a reply whose words all went out as posts still shows", async () => {
  const { phoneActivityEvents } = await import("./mobileTimeline");
  const member = { participantId: "taylor", participantLabel: "@taylor" };
  const posts = [
    { id: "post-1", content: "Found the cause.", createdAt: "2026-11-20T10:00:01Z", afterContentLength: 4, afterActivitySequence: 2 },
    { id: "post-2", content: "Here it is.", createdAt: "2026-11-20T10:00:02Z", attachmentIds: ["pic"] }
  ];
  const conversation: Conversation = {
    id: "posts-chat", kind: "chat", title: "Posts", createdAt: "2026-11-20T10:00:00Z", updatedAt: "2026-11-20T10:00:03Z", findings: [], metadata: {},
    messages: [
      { id: "running", role: "participant", ...member, content: "", status: "pending", createdAt: "2026-11-20T10:00:00Z",
        metadata: { runId: "run-1", interimPosts: posts } },
      { id: "posts-only", role: "participant", ...member, content: "", status: "done", createdAt: "2026-11-20T10:00:00Z",
        metadata: { runId: "run-2", interimPosts: [posts[0]] } }
    ]
  };
  const events = Object.fromEntries(timelineEventsFromSnapshot(conversation).map((event) => [event.id, event]));
  assert.deepEqual(events.running?.interimPosts, [
    { id: "post-1", content: "Found the cause.", createdAt: "2026-11-20T10:00:01Z" },
    { id: "post-2", content: "Here it is.", createdAt: "2026-11-20T10:00:02Z", attachmentIds: ["pic"] }
  ], "the words and their pictures, nothing about the stream");
  assert.equal(events.running?.status, "pending");
  assert.equal(events.running?.content, "@taylor is running...");
  assert.equal(events["posts-only"]?.hidden, undefined, "not an empty turn: its posts are its words");
  assert.equal(events["posts-only"]?.interimPosts?.length, 1);
  const activity = phoneActivityEvents(conversation, Date.parse("2026-11-20T10:05:00Z"));
  assert.ok(activity.length > 0);
  assert.ok(activity.every((event) => !("interimPosts" in event)), "Activity carries no posts: the chat's page does");
});

test("a turn in progress travels to the phone's Activity however many newer replies there are", async () => {
  const { phoneActivityEvents, PHONE_ACTIVITY_PER_CHAT } = await import("./mobileTimeline");
  const now = Date.parse("2026-11-01T08:00:00.000Z");
  const turn = { id: "long-turn", role: "participant", participantId: "taylor", participantLabel: "@taylor", content: "",
    createdAt: new Date(now - 60 * 60_000).toISOString(), status: "pending", metadata: { runId: "run-long" } };
  const replies = Array.from({ length: 12 }, (_, index) => ({
    id: `r${index}`, role: "participant", participantId: `p${index}`, participantLabel: `@m${index}`, content: `reply ${index}`,
    createdAt: new Date(now - (12 - index) * 60_000).toISOString(), status: "done"
  }));
  const events = phoneActivityEvents({ id: "busy", kind: "chat", title: "B", createdAt: "", updatedAt: "", findings: [], metadata: {},
    messages: [turn, ...replies] } as unknown as Conversation, now);
  assert.equal(events.length, PHONE_ACTIVITY_PER_CHAT);
  assert.equal(events[0].id, "long-turn", "the turn in progress is kept, oldest first");
  assert.equal(events[events.length - 1].id, "r11", "the newest reply is kept");
});

test("the phone's chat list counts a turn in progress that started before the chat's newest messages", async () => {
  const { buildMobileChatList } = await import("./mobileChatCatalog");
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 7, minute)).toISOString();
  const turn = { id: "long-turn", role: "participant", participantId: "taylor", participantLabel: "@taylor", content: "",
    createdAt: at(0), status: "pending", metadata: { runId: "run-long" } };
  const newest = Array.from({ length: 10 }, (_, index) => ({
    id: `post-${index}`, role: "participant", participantId: "taylor", participantLabel: "@taylor", content: `post ${index}`,
    createdAt: at(index + 1), status: "done", metadata: { runId: "run-long", appMessageSource: "app_chat_send_message" }
  }));
  const conversation = {
    id: "chat-long", kind: "chat", title: "Long", createdAt: at(0), updatedAt: at(11), findings: [],
    metadata: { participants: [{ id: "taylor", handle: "taylor", kind: "claude-code", roleConfigId: "engineer" }] },
    messages: newest
  } as unknown as Conversation;
  const store = {
    listConversations: async () => [{ id: "chat-long", kind: "chat", title: "Long", createdAt: at(0), updatedAt: at(11) }],
    openConversation: async () => ({ conversation, messagePage: { hasMoreBefore: true } })
  } as unknown as Parameters<typeof buildMobileChatList>[0];
  const options = { roleLabels: new Map<string, string>(), machineNames: new Map<string, string>(), runningFromMessages: true };

  const blind = await buildMobileChatList(store, options);
  assert.equal(blind[0].running, false, "the newest messages alone are all posts");

  const seen = await buildMobileChatList(store, { ...options, pendingMessagesFor: async () => [turn as never] });
  assert.equal(seen[0].running, true);
  assert.equal(seen[0].activity?.[0]?.id, "long-turn");
  assert.equal(seen[0].activity?.[0]?.status, "pending");
  assert.equal(seen[0].snippet, "post 9", "the last line is still the newest message");
});

test("a closed Accord's line travels to the phone with its Accord, and is never the chat list's last line", async () => {
  const { buildMobileChatList } = await import("./mobileChatCatalog");
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 18, minute)).toISOString();
  const reply = { id: "reply", role: "participant", participantId: "taylor", participantLabel: "@taylor", content: "Signed.", createdAt: at(1), status: "done" };
  const line = { id: "line", role: "system", content: "Accord folded: Ship or wait", createdAt: at(2), status: "done",
    metadata: { appMessageSource: "app_accord_closed", accordClosed: { launchMessageId: "launch-1", title: "Ship or wait" } } };
  const forged = { ...line, id: "forged", metadata: { appMessageSource: "app_accord_closed", accordClosed: { launchMessageId: 42 } } };
  const conversation = {
    id: "chat-accord", kind: "chat", title: "Accord", createdAt: at(0), updatedAt: at(1), findings: [],
    metadata: { participants: [{ id: "taylor", handle: "taylor", kind: "claude-code", roleConfigId: "engineer" }], accordClosedLaunchIds: ["launch-1", 7] },
    messages: [reply, line, forged]
  } as unknown as Conversation;
  const events = timelineEventsFromSnapshot(conversation);
  assert.deepEqual(events.find((event) => event.id === "line")?.accordClosed, { launchMessageId: "launch-1", title: "Ship or wait" });
  assert.equal(events.find((event) => event.id === "forged"), undefined, "a line that names no Accord is a plain system message: not shown");
  const store = {
    listConversations: async () => [{ id: "chat-accord", kind: "chat", title: "Accord", createdAt: at(0), updatedAt: at(1) }],
    openConversation: async () => ({ conversation, messagePage: { hasMoreBefore: false } })
  } as unknown as Parameters<typeof buildMobileChatList>[0];
  const list = await buildMobileChatList(store, { roleLabels: new Map<string, string>(), machineNames: new Map<string, string>(), runningFromMessages: true });
  assert.equal(list[0].snippet, "Signed.", "her view of the chat is not its news");
  assert.equal(list[0].who, "taylor:");
  assert.deepEqual(list[0].accordClosed, ["launch-1"], "the server's record of folded Accords, for the phone's pinned card");
});

test("a turn-finished note travels to the phone with the reply it leads to, and the chat list names its member", () => {
  const note = {
    id: "turn-finished-reply", role: "system" as const, content: "Done: the button fits.", status: "done" as const,
    createdAt: "2026-11-04T20:44:00Z",
    metadata: { appMessageSource: "app_turn_finished_note", turnFinishedNote: { messageId: "reply", participantId: "p-taylor", participantLabel: "@taylor" } }
  };
  const conversation: Conversation = {
    id: "note-chat", kind: "chat", title: "Notes", createdAt: "2026-11-04T20:40:00Z", updatedAt: "2026-11-04T20:44:00Z", findings: [], metadata: {},
    messages: [
      { id: "reply", role: "participant", participantId: "p-taylor", participantLabel: "@taylor", content: "Done: the button fits.", status: "done", createdAt: "2026-11-04T20:40:00Z" },
      { id: "hidden-system", role: "system", content: "Auto-resumed @taylor.", status: "done", createdAt: "2026-11-04T20:43:00Z" },
      note
    ]
  };
  const events = timelineEventsFromSnapshot(conversation);
  assert.deepEqual(events.map((event) => event.id), ["reply", "turn-finished-reply"], "a note is the one system message besides artifact notes that travels");
  assert.deepEqual(events[1].finishedNote, { messageId: "reply", participantId: "p-taylor", participantLabel: "@taylor" });
  assert.equal(mobileWhoLabel(note), "taylor:");
  assert.equal(mobileWhoLabel({ ...note, metadata: { ...note.metadata, turnFinishedNote: { ...note.metadata.turnFinishedNote, participantLabel: "" } } }), "system:");
});

test("an artifact note filed under an Accord travels to the phone with its launch, so the phone folds it into the Accord's card", () => {
  const conversation: Conversation = {
    id: "accord-chat", kind: "chat", title: "Accord", createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:02:00Z", findings: [], metadata: {},
    messages: [
      {
        id: "filed", role: "system", status: "done", createdAt: "2026-11-08T10:01:00Z",
        content: "@fable created draft collection [Plan](#artifact:art-1) · Drafts 0/2",
        metadata: { appMessageSource: "app_artifact_note", artifactEventId: "event-1", accordLaunchMessageId: "launch-1" }
      },
      {
        id: "older", role: "system", status: "done", createdAt: "2026-11-08T10:02:00Z",
        content: "@fable created artifact [Notes](#artifact:art-2) · v1",
        metadata: { appMessageSource: "app_artifact_note", artifactEventId: "event-2" }
      }
    ]
  };
  const events = timelineEventsFromSnapshot(conversation);
  assert.deepEqual(events.map((event) => [event.id, event.accordLaunchMessageId]), [["filed", "launch-1"], ["older", undefined]]);
});

test("the phone lists the newest hundred chats and every pinned one however old, never an archived or out-of-scope one", async () => {
  const { MOBILE_CHAT_LIST_LIMIT, mobileListedChats } = await import("./mobileChatCatalog");
  const summary = (index: number, extra: Record<string, unknown> = {}) => ({
    id: `chat-${index}`, title: `Chat ${index}`, kind: "chat" as const, createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: new Date(Date.parse("2026-11-15T00:00:00.000Z") - index * 60_000).toISOString(), ...extra
  });
  const summaries = [
    ...Array.from({ length: MOBILE_CHAT_LIST_LIMIT + 5 }, (_, index) => summary(index)),
    summary(500, { pinned: true, pinnedAt: "2026-11-15T00:00:00.000Z" }),
    summary(501, { pinned: true, archived: true }),
    summary(502, { pinned: true })
  ];
  const listed = mobileListedChats(summaries, (item) => item.id !== "chat-502").map((item) => item.id);
  assert.equal(listed.length, MOBILE_CHAT_LIST_LIMIT + 1);
  assert.equal(listed.at(-1), "chat-500", "the old pinned chat after the newest hundred");
  assert.ok(!listed.includes("chat-501") && !listed.includes("chat-502") && !listed.includes(`chat-${MOBILE_CHAT_LIST_LIMIT}`));
});

// The sessions view on the phone (docs/main-session.md): the main session's
// requests become task cards and the User's messages are placed by whom they
// were addressed to, so both travel, cut to what the phone shows.

function requestConversation(prompt: string, itemCount: number): Conversation {
  const items = Array.from({ length: itemCount }, (_, index) => ({
    targetParticipantId: `m${index}`, targetHandle: `member${index}`, prompt, reason: "x".repeat(2_000),
    status: index === 0 ? "answered" as const : index === 1 ? "failed" as const : "running" as const,
    createdAt: "2026-11-20T10:00:00Z", updatedAt: "2026-11-20T10:01:00Z",
    ...(index === 0 ? { replyMessageId: "reply-0" } : {}),
    ...(index === 1 ? { error: "The CLI exited.\nStack trace follows" } : {})
  }));
  return {
    id: "chat-main", kind: "chat", title: "Main", createdAt: "2026-11-20T10:00:00Z", updatedAt: "2026-11-20T10:02:00Z", findings: [],
    metadata: { mainSessionParticipantId: "main", participants: [{ id: "main", handle: "main", kind: "claude-code", roleConfigId: "main-session" }] },
    messages: [
      { id: "ask", role: "user", content: "Do it", createdAt: "2026-11-20T09:59:00Z", status: "done", metadata: { deliveryTargets: ["main"], askedParticipantIds: ["main", "m0"] } },
      { id: "to-member", role: "user", content: "Only you", createdAt: "2026-11-20T09:59:30Z", status: "done", metadata: { deliveryTargets: ["m0"] } },
      {
        id: "request", role: "participant", participantId: "main", participantLabel: "@main", content: items.map((item) => `@${item.targetHandle} ${prompt}`).join("\n"),
        createdAt: "2026-11-20T10:00:00Z", status: "done",
        metadata: { participantRequest: {
          id: "batch-1", requesterParticipantId: "main", requesterHandle: "main", source: "tool", resumeRequester: true, status: "running",
          depth: 1, createdAt: "2026-11-20T10:00:00Z", updatedAt: "2026-11-20T10:01:00Z", autoResumeMessageId: "resume", items
        } }
      }
    ]
  } as unknown as Conversation;
}

test("the main session's request travels as a small task batch: a line per task, no reasons", () => {
  const prompt = `## Fix the **login** button\n${"Then explain everything in detail. ".repeat(400)}`;
  const events = timelineEventsFromSnapshot(requestConversation(prompt, 3));
  const request = events.find((event) => event.id === "request")?.participantRequest;
  assert.ok(request, "the request carries its batch");
  assert.deepEqual({ ...request, items: undefined }, {
    id: "batch-1", requesterParticipantId: "main", requesterHandle: "main", resumeRequester: true, autoResumeMessageId: "resume", items: undefined
  });
  assert.deepEqual(request.items.map((item) => item.prompt), ["Fix the login button", "Fix the login button", "Fix the login button"],
    "the task's first line, without markdown");
  assert.equal(request.items[0].replyMessageId, "reply-0");
  assert.equal(request.items[0].status, "answered");
  assert.equal(request.items[1].error, "The CLI exited.", "an error's first line");
  assert.equal(JSON.stringify(request).includes("xxxx"), false, "no reasons");
  assert.equal(events.find((event) => event.id === "ask")?.participantRequest, undefined);
});

test("a task travels with its short title: the main session's, else the desktop's from the whole task", () => {
  const conversation = requestConversation("Назови столицу Италии. Ответь ровно одним словом, без пояснений и пунктуации.", 2);
  const batch = conversation.messages[2]!.metadata!.participantRequest!;
  batch.items[1] = { ...batch.items[1]!, title: "Столица Италии" };
  const request = timelineEventsFromSnapshot(conversation).find((event) => event.id === "request")?.participantRequest;
  assert.deepEqual(request?.items.map((item) => item.title), ["Назови столицу Италии", "Столица Италии"]);
});

test("a task batch stays small however long the tasks and however many members", async () => {
  const { PHONE_TASK_ITEMS_MAX, PHONE_TASK_LINE_CHARS } = await import("./mobileTimeline");
  const prompt = "word ".repeat(20_000);
  const request = timelineEventsFromSnapshot(requestConversation(prompt, 40)).find((event) => event.id === "request")?.participantRequest;
  assert.equal(request?.items.length, PHONE_TASK_ITEMS_MAX, "a batch names at most this many members");
  assert.ok(request!.items.every((item) => item.prompt.length <= PHONE_TASK_LINE_CHARS), "each line is cut");
  // What the card adds to the message on the phone, whatever the tasks: well
  // under a page's worth even for the largest batch.
  assert.ok(JSON.stringify(request).length < PHONE_TASK_ITEMS_MAX * 400, `batch is ${JSON.stringify(request).length} bytes`);
});

test("the User's message says whom it was addressed to; members' and system messages do not", () => {
  const events = timelineEventsFromSnapshot(requestConversation("Task", 1));
  assert.deepEqual(events.find((event) => event.id === "ask")?.addressees, ["main", "m0"]);
  assert.deepEqual(events.find((event) => event.id === "to-member")?.addressees, ["m0"]);
  assert.equal(events.find((event) => event.id === "request")?.addressees, undefined);
});

test("Activity carries no task batch and no addressees", async () => {
  const { phoneActivityEvents } = await import("./mobileTimeline");
  const events = phoneActivityEvents(requestConversation("Task", 2), Date.parse("2026-11-20T11:00:00Z"));
  const request = events.find((event) => event.id === "request");
  assert.ok(request, "the request is a member's message Activity lists");
  assert.equal(request.participantRequest, undefined);
});

test("an Accord the main session started travels as one, with how long a turn worked and when each task last changed", () => {
  const conversation = requestConversation("Task", 1);
  conversation.messages.push(
    { id: "launch", role: "participant", participantId: "main", participantLabel: "@main", content: "Accord: Ship it", createdAt: "2026-11-20T10:03:00Z", status: "done",
      metadata: { accordLaunchByMainSession: true, workedMs: 54_321.4 } },
    { id: "member-launch", role: "participant", participantId: "m0", participantLabel: "@member0", content: "Accord: no", createdAt: "2026-11-20T10:04:00Z", status: "pending",
      metadata: { workedMs: 10 } }
  );
  const events = timelineEventsFromSnapshot(conversation);
  const launch = events.find((event) => event.id === "launch");
  assert.equal(launch?.accordLaunchByMainSession, true);
  assert.equal(launch?.workedMs, 54_321);
  assert.equal(events.find((event) => event.id === "member-launch")?.workedMs, undefined, "a turn still going has no worked time yet");
  assert.equal(events.find((event) => event.id === "ask")?.accordLaunchByMainSession, undefined);
  assert.equal(events.find((event) => event.id === "request")?.participantRequest?.items[0]?.updatedAt, "2026-11-20T10:01:00Z");
});

test("a hidden request carrier carries no task batch", () => {
  const conversation = requestConversation("Task", 1);
  const request = conversation.messages[2]!;
  request.metadata = { ...request.metadata, hiddenFromTimeline: true };
  const event = timelineEventsFromSnapshot(conversation).find((item) => item.id === "request");
  assert.equal(event?.hidden, true);
  assert.equal(event?.participantRequest, undefined);
});

test("the phone's chat list says which chats have a main session and the view each opens in", async () => {
  const { buildMobileChatList } = await import("./mobileChatCatalog");
  const main = { id: "main", handle: "main", kind: "claude-code", roleConfigId: "main-session" };
  const chats: Record<string, Conversation> = {
    sessions: { ...requestConversation("Task", 1), id: "sessions" },
    classic: { ...requestConversation("Task", 1), id: "classic", metadata: { mainSessionParticipantId: "main", chatView: "classic", participants: [main] } },
    old: { ...requestConversation("Task", 1), id: "old", metadata: { participants: [{ id: "admin", handle: "admin", kind: "claude-code", roleConfigId: "administrator" }] } },
    gone: { ...requestConversation("Task", 1), id: "gone", metadata: { mainSessionParticipantId: "main", chatView: "sessions", participants: [] } }
  } as unknown as Record<string, Conversation>;
  const store = {
    listConversations: async () => Object.keys(chats).map((id) => ({ id, kind: "chat", title: id, createdAt: "2026-11-20T10:00:00Z", updatedAt: "2026-11-20T10:00:00Z" })),
    openConversation: async (id: string) => ({ conversation: chats[id], messagePage: { hasMoreBefore: false } })
  } as unknown as Parameters<typeof buildMobileChatList>[0];
  const options = { roleLabels: new Map<string, string>(), machineNames: new Map<string, string>() };
  const byId = new Map((await buildMobileChatList(store, options)).map((row) => [row.id, row]));
  assert.deepEqual([byId.get("sessions")?.mainSessionParticipantId, byId.get("sessions")?.chatView, byId.get("sessions")?.canSwitchView], ["main", "sessions", true]);
  assert.equal(byId.get("classic")?.chatView, "classic", "the chat's own view");
  for (const id of ["old", "gone"]) {
    const row = byId.get(id);
    assert.deepEqual([row?.mainSessionParticipantId, row?.chatView, row?.canSwitchView], [undefined, undefined, undefined],
      `${id}: one view only, and nothing travels for it`);
  }
  const fallback = new Map((await buildMobileChatList(store, { ...options, defaultChatView: "classic" })).map((row) => [row.id, row]));
  assert.equal(fallback.get("sessions")?.chatView, "classic", "a chat without a view of its own opens in the default");
});

test("a reply's step rows travel to the phone only for a chat in the sessions view; a classic chat's reply carries none", () => {
  const steps = [
    { id: "s1", sequence: 1, kind: "command" as const, label: "Running command", detail: "npm test", createdAt: "2026-11-20T10:03:00Z" },
    { id: "s2", sequence: 2, kind: "tool" as const, label: "Reading file", detail: "src/a.ts", createdAt: "2026-11-20T10:03:10Z" }
  ];
  const withReply = (metadata: Record<string, unknown>): Conversation => {
    const conversation = requestConversation("Task", 1);
    conversation.metadata = { ...conversation.metadata, ...metadata };
    conversation.messages.push({ id: "worked", role: "participant", participantId: "main", participantLabel: "@main", content: "Done.",
      createdAt: "2026-11-20T10:04:00Z", status: "done", metadata: { workedMs: 9_000, activityEvents: steps } });
    return conversation;
  };
  const rowsOf = (conversation: Conversation) => timelineEventsFromSnapshot(conversation).find((event) => event.id === "worked");
  assert.deepEqual(rowsOf(withReply({ chatView: "sessions" }))?.activity, [{ kind: "shell", text: "npm test" }, { kind: "read", text: "src/a.ts" }]);
  const classic = rowsOf(withReply({ chatView: "classic" }));
  assert.equal(classic?.activity, undefined, "the classic view shows no step rows");
  assert.equal(classic?.activityMore, undefined);
  const old = rowsOf(withReply({ mainSessionParticipantId: undefined, participants: [{ id: "admin", handle: "admin", kind: "claude-code", roleConfigId: "administrator" }] }));
  assert.equal(old?.activity, undefined, "a chat without a main session is always classic");
});

test("a running reply waiting behind its member's turn travels as queued; a machine's run with when its own run began", () => {
  const conversation = requestConversation("Task", 1);
  const startedAt = "2026-11-20T10:05:30Z";
  conversation.messages.push(
    { id: "queued", role: "participant", participantId: "main", participantLabel: "@main", content: "", createdAt: "2026-11-20T10:05:00Z", status: "pending",
      metadata: { runId: "run-q", queuedBehind: { handle: "main" } } },
    { id: "remote", role: "participant", participantId: "main", participantLabel: "@main", content: "", createdAt: "2026-11-20T10:04:00Z", status: "pending",
      metadata: { runId: "run-r", remoteRunStatus: { phase: "waiting-for-response", label: "Working", startedAt, updatedAt: startedAt } } },
    { id: "local", role: "participant", participantId: "main", participantLabel: "@main", content: "", createdAt: "2026-11-20T10:06:00Z", status: "pending",
      metadata: { runId: "run-l" } }
  );
  const byId = new Map(timelineEventsFromSnapshot(conversation).map((event) => [event.id, event]));
  assert.deepEqual([byId.get("queued")?.queued, byId.get("queued")?.startedAt], [true, undefined]);
  assert.deepEqual([byId.get("remote")?.queued, byId.get("remote")?.startedAt], [undefined, startedAt]);
  assert.deepEqual([byId.get("local")?.queued, byId.get("local")?.startedAt], [undefined, undefined], "a local turn counts from its reply");
});

test("a reply that waited in the queue works, on the phone too, from when its own turn began", () => {
  const conversation = requestConversation("Task", 1);
  const turnStartedAt = "2026-11-20T10:07:45Z";
  conversation.messages.push({ id: "was-queued", role: "participant", participantId: "main", participantLabel: "@main", content: "", createdAt: "2026-11-20T10:07:00Z", status: "pending",
    metadata: { runId: "run-w", turnStartedAt } });
  const event = timelineEventsFromSnapshot(conversation).find((item) => item.id === "was-queued");
  assert.equal(event?.queued, undefined);
  assert.equal(event?.startedAt, turnStartedAt, "not the time it was queued");
});

test("a task travels to the phone saying whether the main session gave its title, so a follow-up never renames the member there", () => {
  const at = (minute: number): string => `2026-11-22T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const item = (minute: number, extra: Record<string, unknown>) => ({ targetParticipantId: "p-drew", targetHandle: "drew", status: "answered", createdAt: at(minute), updatedAt: at(minute), ...extra });
  const request = (id: string, minute: number, items: unknown[]) => ({
    id, role: "participant", participantId: "p-main", content: `@drew task ${id}`, createdAt: at(minute), status: "done",
    metadata: { participantRequest: { id: `b-${id}`, requesterParticipantId: "p-main", requesterHandle: "main", source: "mcp", resumeRequester: true, status: "completed", depth: 1, createdAt: at(minute), updatedAt: at(minute), items } }
  });
  const conversation = {
    id: "titles-chat", kind: "chat", title: "Titles", createdAt: at(0), updatedAt: at(9), findings: [], metadata: {},
    messages: [
      request("delegate", 1, [item(1, { prompt: "Implement new chats in General.", title: "Новые чаты в General" })]),
      request("follow-up", 9, [item(9, { prompt: 'Two additions to your task "Новые чаты в General": the phone too.' })])
    ]
  } as unknown as Conversation;
  const events = timelineEventsFromSnapshot(conversation) as unknown as Array<{ id: string; participantRequest?: { items: Array<{ title: string; titled: boolean }> } }>;
  const items = (id: string) => events.find((event) => event.id === id)?.participantRequest?.items ?? [];
  assert.deepEqual(items("delegate").map((entry) => [entry.title, entry.titled]), [["Новые чаты в General", true]]);
  assert.deepEqual(items("follow-up").map((entry) => [entry.titled]), [[false]], "a title made from its text is not the main session's");
});
