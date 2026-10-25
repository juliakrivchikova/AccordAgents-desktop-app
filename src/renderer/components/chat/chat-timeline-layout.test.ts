import assert from "node:assert/strict";
import test from "node:test";
import type { VirtualItem } from "@tanstack/react-virtual";

import type { ChatAppToolApproval, ChatMessage } from "../../../shared/types";
import { buildChatTimelineRows } from "./chat-conversation-progress";
import { anchorShiftAfterRowsChange, layoutChange } from "./chat-timeline-scroll";

function layout(rows: Array<[string, number]>): VirtualItem[] {
  let start = 0;
  return rows.map(([key, size], index) => {
    const item = { key, index, start, size, end: start + size, lane: 0 };
    start += size;
    return item;
  });
}

const view = (offset: number, size = 300): { offset: number; size: number } => ({ offset, size });

test("an older page loaded above the viewport moves the view down by exactly its height", () => {
  const before = layout([["load-older", 56], ["m10", 200], ["m11", 300], ["m12", 100]]);
  const after = layout([["load-older", 56], ["m7", 120], ["m8", 80], ["m9", 400], ["m10", 200], ["m11", 300], ["m12", 100]]);
  // m11 starts at the top of the viewport.
  assert.equal(anchorShiftAfterRowsChange(before, after, view(256)), 600);
});

test("the load-older row going away pulls the view up by its height", () => {
  const before = layout([["load-older", 56], ["m0", 200], ["m1", 300]]);
  const after = layout([["m0", 200], ["m1", 300]]);
  assert.equal(anchorShiftAfterRowsChange(before, after, view(300)), -56);
});

test("a row above the viewport measured taller moves the view by the difference, a row below does not", () => {
  const before = layout([["m0", 170], ["m1", 170], ["m2", 170], ["m3", 170]]);
  const tallerAbove = layout([["m0", 2071], ["m1", 170], ["m2", 170], ["m3", 170]]);
  const tallerBelow = layout([["m0", 170], ["m1", 170], ["m2", 170], ["m3", 900]]);
  assert.equal(anchorShiftAfterRowsChange(before, tallerAbove, view(200)), 1901);
  assert.equal(anchorShiftAfterRowsChange(before, tallerBelow, view(200)), 0);
});

test("a row peeking in at the top grows upward when measured, and downward when the User opened it", () => {
  // m1 (170-340) peeks in at the top of a viewport starting at 300; m2 starts in view.
  const before = layout([["m0", 170], ["m1", 170], ["m2", 170], ["m3", 170]]);
  const after = layout([["m0", 170], ["m1", 900], ["m2", 170], ["m3", 170]]);
  assert.equal(anchorShiftAfterRowsChange(before, after, view(300)), 730, "measured: m2 and below stay put");
  assert.equal(anchorShiftAfterRowsChange(before, after, view(300), true), 0, "opened by the User: m1 opens downward");
});

test("a row taller than the viewport is its own anchor", () => {
  const before = layout([["m0", 170], ["m1", 2000], ["m2", 170]]);
  const after = layout([["m0", 300], ["m1", 2000], ["m2", 170]]);
  assert.equal(anchorShiftAfterRowsChange(before, after, view(500)), 130);
});

test("the load-older row is never the anchor, even at the very top", () => {
  const before = layout([["load-older", 56], ["m10", 200]]);
  const after = layout([["load-older", 56], ["m9", 150], ["m10", 200]]);
  assert.equal(anchorShiftAfterRowsChange(before, after, view(0)), 150);
});

test("layouts are compared by value", () => {
  assert.equal(layoutChange(layout([["a", 10], ["b", 20]]), layout([["a", 10], ["b", 20]])), "none");
  assert.equal(layoutChange(layout([["a", 10], ["b", 20]]), layout([["a", 10], ["b", 25]])), "resized");
  assert.equal(layoutChange(layout([["a", 10], ["b", 20]]), layout([["z", 5], ["a", 10], ["b", 20]])), "rows");
});

function message(id: string, createdAt: string): ChatMessage {
  return { id, role: "participant", content: id, createdAt } as ChatMessage;
}

function approval(id: string, createdAt: string): ChatAppToolApproval {
  return { id, createdAt, status: "approved", toolName: "codex_auto_review_approval" } as ChatAppToolApproval;
}

test("resolved approvals older than the loaded messages wait for their page", () => {
  const messages = [message("m1", "2026-09-15T10:00:00.000Z"), message("m2", "2026-09-15T11:00:00.000Z")];
  const approvals = [approval("old", "2026-09-10T00:00:00.000Z"), approval("inside", "2026-09-15T10:30:00.000Z")];
  const windowed = buildChatTimelineRows({
    hasOlderMessages: true,
    olderMessagesLoading: false,
    isRunning: false,
    loadedMessages: messages,
    topLevelMessages: messages,
    resolvedApprovals: approvals,
    thinkingRows: []
  });
  assert.deepEqual(windowed.map((row) => row.id), ["load-older", "m1", "inside", "m2"]);

  const complete = buildChatTimelineRows({
    hasOlderMessages: false,
    olderMessagesLoading: false,
    isRunning: false,
    loadedMessages: messages,
    topLevelMessages: messages,
    resolvedApprovals: approvals,
    thinkingRows: []
  });
  assert.deepEqual(complete.map((row) => row.id), ["old", "m1", "inside", "m2"]);
});
