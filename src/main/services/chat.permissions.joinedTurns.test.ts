import assert from "node:assert/strict";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { chatParts } from "./chat/test/chatParts";
import { chatParticipant, selfCompactingChat, waitFor } from "./chat/test/compactionFixtures";
import type { ChatParticipant } from "../../shared/types";

// Messages and requests that piled up for a busy member go into its next
// turn together, as a CLI takes the messages queued while it works (the
// User, 2026-11-27; Claude Code 2.1.332 starts every queued message in one
// step). Each requester still gets its answer.

const ASKS = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) };

/** A worker busy with a long first turn, and three members that each ask it
 *  one thing while it works. */
function busyWorkerWithAskers(kind: ChatParticipant["kind"] = "codex-cli") {
  const askers = ["a", "b", "c"].map((name) => chatParticipant({ id: `asker-${name}`, handle: `asker${name}`, ...ASKS }));
  const results: Record<string, any> = {};
  let releaseLong!: () => void;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker", kind },
    others: askers,
    turn: async ({ participantId, prompt, actor, service, call, signal }) => {
      const asker = askers.find((item) => item.id === participantId);
      if (asker) {
        if (call === 1) {
          results[asker.handle] = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: `Question from ${asker.handle}` }] });
          return "Asked.";
        }
        return "Noted.";
      }
      if (call === 1) {
        await new Promise<void>((resolve) => {
          releaseLong = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "Long work done.";
      }
      if (results.holdSecond) {
        await new Promise<void>((resolve) => {
          results.releaseSecond = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return `Answered: ${[...prompt.matchAll(/Question from (\w+)/g)].map((match) => match[1]).join(", ")}`;
    }
  });
  return { chat, results, releaseLong: () => releaseLong() };
}

function workerPrompts(chat: ReturnType<typeof selfCompactingChat>): string[] {
  return chat.prompts.filter((item) => item.participantId === "worker").map((item) => item.prompt);
}

function requestItems(chat: ReturnType<typeof selfCompactingChat>): any[] {
  return chat.storage.current.messages
    .map((message: any) => message.metadata?.participantRequest)
    .filter(Boolean)
    .flatMap((batch: any) => batch.items.filter((item: any) => item.targetParticipantId === "worker"));
}

/** The waiting runs of the worker, in the order they were asked. */
function waitingWorkerRuns(chat: ReturnType<typeof selfCompactingChat>, except: string): string[] {
  return [...chatParts(chat.service).activeRuns.chatRunMeta.entries()]
    .filter(([runId, meta]) => meta.participantId === "worker" && runId !== except)
    .map(([runId]) => runId);
}

async function queueThreeRequests(chat: ReturnType<typeof selfCompactingChat>, results: Record<string, any>): Promise<void> {
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "long-run", content: "@worker do the long work" });
  await waitFor(() => workerPrompts(chat).length === 1, 5_000);
  for (const name of ["a", "b", "c"]) {
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: `ask-${name}`, content: `@asker${name} ask worker` });
    await waitFor(() => results[`asker${name}`]?.status === "running", 5_000);
    await waitFor(() => requestItems(chat).length === ["a", "b", "c"].indexOf(name) + 1, 5_000);
  }
  // Each waits behind the long turn.
  await waitFor(() => chatParts(chat.service).turnQueue.memberActivity(chat.conversation.id, "worker").waiting === 3, 5_000);
}

for (const kind of ["codex-cli", "gemini-cli", "claude-code"] as const) {
  test(`${kind}: three requests waiting for a busy member go into its next turn together, in order, and every requester gets the reply`, async () => {
    const { chat, results, releaseLong } = busyWorkerWithAskers(kind);
    await queueThreeRequests(chat, results);
    releaseLong();
    await waitFor(() => chat.storage.current.metadata.running === false && requestItems(chat).every((item) => item.status !== "running"), 8_000);

    const prompts = workerPrompts(chat);
    assert.equal(prompts.length, 2, "one turn for all three, not one each");
    const joined = prompts[1]!;
    const at = (name: string): number => joined.indexOf(`Question from asker${name}`);
    assert.ok(at("a") >= 0 && at("b") > at("a") && at("c") > at("b"), "each request in the order it came");
    assert.equal(joined.match(/<<<REQUEST [0-9a-f]{8} from @asker[abc]>>>/g)?.length, 3, "each still in its own REQUEST block");

    const items = requestItems(chat);
    assert.deepEqual(items.map((item) => item.status), ["answered", "answered", "answered"]);
    const replyId = items[0].replyMessageId;
    assert.ok(replyId);
    assert.ok(items.every((item) => item.replyMessageId === replyId), "the one reply answers each request");
    const reply = chat.storage.current.messages.find((message: any) => message.id === replyId);
    assert.equal(reply.content, "Answered: askera, askerb, askerc");
    assert.equal(reply.metadata.joinedTriggerMessageIds.length, 2);
    // The reply comes after the last message it answers.
    const lastRequestIndex = Math.max(...chat.storage.current.messages.flatMap((message: any, index: number) =>
      message.metadata?.participantRequest?.items.some((item: any) => item.targetParticipantId === "worker") ? [index] : []));
    assert.ok(chat.storage.current.messages.findIndex((message: any) => message.id === replyId) > lastRequestIndex);

    // Every requester is resumed with it, once.
    for (const name of ["a", "b", "c"]) {
      await waitFor(() => chat.prompts.filter((item) => item.participantId === `asker-${name}`).length === 2, 5_000);
    }
    await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
    assert.equal(workerPrompts(chat).length, 2, "nothing answered twice");
    assert.equal(chat.storage.current.messages.filter((message: any) => message.role === "participant" && message.participantId === "worker" && message.status === "pending").length, 0);
    assert.equal(chat.debugEvents.filter(({ event }) => event === "chat.turn.joined-waiting").length, 1);
  });
}

test("a resume reads a joined reply that is in another request's thread", async () => {
  const { chat, results, releaseLong } = busyWorkerWithAskers();
  await queueThreeRequests(chat, results);
  releaseLong();
  for (const name of ["a", "b", "c"]) {
    await waitFor(() => chat.prompts.filter((item) => item.participantId === `asker-${name}`).length === 2, 8_000);
  }
  // Each resume's prompt carries the joined answer.
  for (const name of ["a", "b", "c"]) {
    const resume = chat.prompts.filter((item) => item.participantId === `asker-${name}`)[1]!.prompt;
    assert.match(resume, /Answered: askera, askerb, askerc/, `@asker${name} reads the answer`);
  }
});

test("a request stopped while it waits is removed alone; the others still go into the next turn together", async () => {
  const { chat, results, releaseLong } = busyWorkerWithAskers();
  await queueThreeRequests(chat, results);
  const [, second] = waitingWorkerRuns(chat, "long-run").filter((runId) => runId !== chatParts(chat.service).turnQueue.runningTurnRunIds(chat.conversation.id, "worker")[0]);
  assert.ok(second);
  chat.service.cancelRun(second!);
  await waitFor(() => requestItems(chat)[1].status === "interrupted", 5_000);
  releaseLong();
  await waitFor(() => chat.storage.current.metadata.running === false && requestItems(chat).every((item) => item.status !== "running"), 8_000);
  const prompts = workerPrompts(chat);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /Question from askera/);
  assert.doesNotMatch(prompts[1]!, /Question from askerb/, "the stopped request is not delivered");
  assert.match(prompts[1]!, /Question from askerc/);
  assert.deepEqual(requestItems(chat).map((item) => item.status), ["answered", "interrupted", "answered"]);
});

test("a Stop of the turn the requests went into ends every one of them, and nothing runs again for them", async () => {
  const { chat, results, releaseLong } = busyWorkerWithAskers();
  results.holdSecond = true;
  await queueThreeRequests(chat, results);
  releaseLong();
  await waitFor(() => workerPrompts(chat).length === 2 && typeof results.releaseSecond === "function", 5_000);
  const running = chatParts(chat.service).turnQueue.runningTurnRunIds(chat.conversation.id, "worker");
  assert.equal(running.length, 1, "one turn runs for the three");
  chat.service.cancelRun(running[0]!);
  await waitFor(() => chat.storage.current.metadata.running === false && requestItems(chat).every((item) => item.status !== "running"), 8_000);
  assert.deepEqual(requestItems(chat).map((item) => item.status), ["interrupted", "interrupted", "interrupted"]);
  assert.equal(workerPrompts(chat).length, 2);
});

test("a request that went into the running turn and is then stopped alone leaves it: the turn goes on for the others", async () => {
  const { chat, results, releaseLong } = busyWorkerWithAskers();
  results.holdSecond = true;
  await queueThreeRequests(chat, results);
  const waiting = waitingWorkerRuns(chat, "long-run");
  releaseLong();
  await waitFor(() => workerPrompts(chat).length === 2 && typeof results.releaseSecond === "function", 5_000);
  const lead = chatParts(chat.service).turnQueue.runningTurnRunIds(chat.conversation.id, "worker")[0];
  const follower = waiting.find((runId) => runId !== lead && chatParts(chat.service).activeRuns.chatRunMeta.has(runId));
  assert.ok(follower);
  chat.service.cancelRun(follower!);
  await waitFor(() => requestItems(chat).some((item) => item.status === "interrupted"), 5_000);
  results.releaseSecond();
  await waitFor(() => chat.storage.current.metadata.running === false && requestItems(chat).every((item) => item.status !== "running"), 8_000);
  const statuses = requestItems(chat).map((item) => item.status);
  assert.equal(statuses.filter((status) => status === "answered").length, 2);
  assert.equal(statuses.filter((status) => status === "interrupted").length, 1);
  assert.equal(workerPrompts(chat).length, 2);
});

test("the User's own messages to a busy member arrive together in its next turn, exactly as she typed them, answered after the last", async () => {
  let releaseLong!: () => void;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker", kind: "codex-cli" },
    turn: async ({ call, signal }) => {
      if (call === 1) {
        await new Promise<void>((resolve) => {
          releaseLong = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "First done.";
      }
      return "Both done.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "first", content: "@worker first task" });
  await waitFor(() => workerPrompts(chat).length === 1, 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "second", content: "@worker second task" });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "third", content: "@worker third task" });
  await waitFor(() => chatParts(chat.service).turnQueue.memberActivity(chat.conversation.id, "worker").waiting === 2, 5_000);
  releaseLong();
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);

  const prompts = workerPrompts(chat);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /@worker second task\n\n@worker third task/, "as typed, one after the other");
  assert.doesNotMatch(prompts[1]!, /<<<APP [0-9a-f]{8}>>>[^<]*(second|third) task/, "no app note on her words");
  const messages = chat.storage.current.messages;
  const replies = messages.filter((message: any) => message.role === "participant" && message.participantId === "worker");
  assert.deepEqual(replies.map((message: any) => message.content), ["First done.", "Both done."], "one reply for the two, no empty bubbles left");
  const thirdIndex = messages.findIndex((message: any) => message.role === "user" && message.content === "@worker third task");
  assert.ok(messages.findIndex((message: any) => message.content === "Both done.") > thirdIndex, "the reply comes after her last message");
});

test("a Claude Code member's own CLI joins the User's messages: the app does not join them itself", async () => {
  let releaseLong!: () => void;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker", kind: "claude-code" },
    turn: async ({ call, signal, options }) => {
      // In its CLI as soon as it is written, as the live process takes it.
      (options.warm as { onMessageWritten?: () => void } | undefined)?.onMessageWritten?.();
      if (call === 1) {
        await new Promise<void>((resolve) => {
          releaseLong = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return `Reply ${call}.`;
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "first", content: "@worker first task" });
  await waitFor(() => workerPrompts(chat).length === 1, 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "second", content: "@worker second task" });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "third", content: "@worker third task" });
  // Each goes into the CLI as it comes, as typed into the dedicated CLI.
  await waitFor(() => workerPrompts(chat).length === 3, 5_000);
  releaseLong();
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
  assert.equal(chat.debugEvents.filter(({ event }) => event === "chat.turn.joined-waiting").length, 0);
});

test("after a member's own compaction and the turn it goes on in, the requests that waited meanwhile run together in one turn", async () => {
  const askers = ["a", "b"].map((name) => chatParticipant({ id: `asker-${name}`, handle: `asker${name}`, ...ASKS }));
  const results: Record<string, any> = {};
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker", permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestCompaction: "allow" }) },
    others: askers,
    turn: async ({ participantId, prompt, actor, service, call }) => {
      const asker = askers.find((item) => item.id === participantId);
      if (asker) {
        if (call === 1) results[asker.handle] = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: `Question from ${asker.handle}` }] });
        return call === 1 ? "Asked." : "Noted.";
      }
      if (call === 1) {
        await first;
        await service.requestSelfCompactionFromTool(actor, { instructions: "Stage two." });
        return "Stage one is done.";
      }
      return /Question from/.test(prompt) ? `Answered: ${[...prompt.matchAll(/Question from (\w+)/g)].map((match) => match[1]).join(", ")}` : "Went on with stage two.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "user-run", content: "@worker do both stages" });
  await waitFor(() => workerPrompts(chat).length === 1, 5_000);
  for (const name of ["a", "b"]) {
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: `ask-${name}`, content: `@asker${name} ask worker` });
    await waitFor(() => results[`asker${name}`]?.status === "running", 5_000);
  }
  await waitFor(() => chatParts(chat.service).turnQueue.memberActivity(chat.conversation.id, "worker").waiting === 2, 5_000);
  releaseFirst();
  await waitFor(() => chat.storage.current.metadata.running === false && requestItems(chat).every((item) => item.status !== "running"), 8_000);
  assert.deepEqual(chat.order.filter((entry) => entry.endsWith(" worker")), ["turn worker", "compact worker", "turn worker", "turn worker"]);
  const prompts = workerPrompts(chat);
  assert.match(prompts[1]!, /goes on after the compaction it asked for/);
  assert.match(prompts[2]!, /Question from askera[\s\S]*Question from askerb/, "both requests in the one turn after the go-on turn");
  assert.deepEqual(requestItems(chat).map((item) => item.status), ["answered", "answered"]);
});

test("what does not fit in one turn's prompt waits for the turn after it, still in order", async () => {
  let releaseLong!: () => void;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker", kind: "gemini-cli" },
    turn: async ({ call, signal }) => {
      if (call === 1) {
        await new Promise<void>((resolve) => {
          releaseLong = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return `Reply ${call}.`;
    }
  });
  const big = (label: string): string => `@worker ${label} ${"x".repeat(120_000)}`;
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "first", content: "@worker first task" });
  await waitFor(() => workerPrompts(chat).length === 1, 5_000);
  for (const label of ["second", "third", "fourth"]) {
    await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: label, content: label === "fourth" ? "@worker fourth task" : big(label) });
  }
  await waitFor(() => chatParts(chat.service).turnQueue.memberActivity(chat.conversation.id, "worker").waiting === 3, 5_000);
  releaseLong();
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
  const prompts = workerPrompts(chat);
  assert.equal(prompts.length, 3, "the second alone (the third would not fit with it), then the third with the fourth");
  assert.match(prompts[1]!, /@worker second x/);
  assert.doesNotMatch(prompts[1]!, /third/);
  assert.match(prompts[2]!, /@worker third x+\n\n@worker fourth task/);
});
