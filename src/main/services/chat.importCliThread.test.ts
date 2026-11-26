import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { phoneActivityEvents } from "./mobileTimeline";
import { isChatMessageHiddenFromTimeline } from "../../shared/chatTimelineVisibility";
import type { ChatMessage } from "../../shared/types";
import { participantsOf, sessionsOf, testService, waitFor } from "./chat/test/forkFixtures";
import type { ImportedThread } from "./chat/conversations/chatImports";

// A thread imported from the User's own CLI (docs/design/cli-import/plan.md)
// becomes a chat whose main session resumes that CLI session: its first turn
// is told it is the main session (the CLI kept its own system prompt), is
// not given the imported history again, and may not start a clean session.

function thread(folder: string): ImportedThread {
  return {
    kind: "claude-code",
    sessionId: "cli-thread-1",
    folder,
    title: "Fix the preview",
    entries: [
      { role: "user", text: "Why is the preview slow?", at: "2026-11-20T10:00:00.000Z" },
      { role: "assistant", text: "Every rule is recomputed per row.", at: "2026-11-20T10:01:00.000Z", cut: "uuid-a" },
      { role: "user", text: "Keep the old path under 200 files.", at: "2026-11-20T10:02:00.000Z", imageCount: 1 },
      { role: "assistant", text: "Done.", at: "2026-11-20T10:03:00.000Z", cut: "uuid-b" }
    ]
  };
}

test("an imported thread is a chat whose main session resumes its CLI session, told once it is the main session, without its history sent again", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "accordagents-cli-import-"));
  try {
    const { service, storage, runs } = testService({
      conversations: [],
      run: async (participant, _prompt, runOptions) => {
        runOptions.onSessionId?.("cli-thread-1");
        return { participant, ok: true, content: "On it.", durationMs: 1, sessionId: "cli-thread-1" };
      }
    });
    const created = await service.importCliThread(thread(folder));
    const saved = storage.store.get(created.id)!;
    const main = participantsOf(saved)[0]!;
    assert.equal(saved.title, "Fix the preview");
    assert.equal(saved.repoPath, folder);
    assert.deepEqual({ kind: main.kind, sessionId: main.importOrigin?.sessionId }, { kind: "claude-code", sessionId: "cli-thread-1" });

    const notice = saved.messages.find((message) => message.metadata?.importNotice)!;
    assert.equal(isChatMessageHiddenFromTimeline(notice), false, "the import line is shown");
    const history = saved.messages.filter((message) => message.role !== "system");
    assert.ok(Date.parse(notice.createdAt) < Date.parse(history[0]!.createdAt), "the line opens the timeline on every device");
    assert.deepEqual(history.map((message) => [message.role, message.content]), [
      ["user", "Why is the preview slow?"],
      ["participant", "Every rule is recomputed per row."],
      ["user", "Keep the old path under 200 files.\n\nImage"],
      ["participant", "Done."]
    ]);
    const asks = history.filter((message: ChatMessage) => message.role === "user").map((message) => (message.metadata as { deliveryTargets?: unknown } | undefined)?.deliveryTargets);
    assert.deepEqual(asks, [undefined, undefined], "a historical message asks no turn of anyone");
    assert.deepEqual(history.at(-1)!.metadata?.sessionCut, { sessionId: "cli-thread-1", at: "uuid-b" }, "Fork cuts at the reply she saw");
    assert.equal(saved.updatedAt, "2026-11-20T10:03:00.000Z", "listed where its last turn was, not at the import");
    assert.deepEqual(phoneActivityEvents(saved, Date.parse("2026-11-21T00:00:00.000Z")), [], "its history is not activity on the phone");

    await service.sendMessage({ conversationId: created.id, runId: "run-1", content: "Now add a test.", targetParticipantIds: [main.id] });
    await waitFor(() => runs.length === 1);
    const first = runs[0]!;
    assert.equal(first.options.sessionId, "cli-thread-1", "the CLI's own session, resumed");
    assert.equal(first.options.resumeOnly, true, "never a clean session while the history is only in it");
    assert.match(first.prompt, /AccordAgents session instructions/);
    assert.match(first.prompt, /This session is the User's own Claude Code thread, now imported into an AccordAgents chat/);
    assert.doesNotMatch(first.prompt, /Why is the preview slow\?/, "the session holds its history already");
    await waitFor(() => sessionsOf(storage.store.get(created.id)).some((session) => session.sessionId === "cli-thread-1" && session.importIntroPending === undefined));
    await waitFor(() => storage.store.get(created.id)!.messages.some((message) => message.content === "On it." && message.status === "done"));
    assert.deepEqual(phoneActivityEvents(storage.store.get(created.id)!).map((event) => event.content), ["On it."], "a reply here is activity on the phone");

    await service.sendMessage({ conversationId: created.id, runId: "run-2", content: "And the docs.", targetParticipantIds: [main.id] });
    await waitFor(() => runs.length === 2);
    assert.equal(runs[1]!.options.resumeOnly, undefined);
    assert.equal(runs[1]!.prompt, "And the docs.", "told once: her words alone from then on");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a thread whose folder is gone is not imported without a folder that exists", async () => {
  const { service } = testService({ conversations: [] });
  await assert.rejects(service.importCliThread(thread(path.join(tmpdir(), "accordagents-gone-folder-does-not-exist"))), /Choose a folder/);
});
