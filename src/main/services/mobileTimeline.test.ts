import assert from "node:assert/strict";
import test from "node:test";
import { timelineEventsFromSnapshot } from "./mobileTimeline";
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
