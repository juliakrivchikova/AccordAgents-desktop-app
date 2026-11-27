import assert from "node:assert/strict";
import test from "node:test";
import { defaultChatAgentPermissions, normalizeChatAgentPermissions } from "../../shared/agentPermissions";
import { chatDependencies, chatParts } from "./chat/test/chatParts";
import { chatParticipant, selfCompactingChat, waitFor } from "./chat/test/compactionFixtures";

const ASKS = { permissions: normalizeChatAgentPermissions({ ...defaultChatAgentPermissions(), requestParticipants: "allow" }) };

/** A worker (Codex here: a CLI the app does not steer mid-turn) busy with a
 *  long turn, a request that waits for it, and a correction delivered now. */
function busyWorkerChat() {
  const queued = chatParticipant({ id: "asker-queued", handle: "queued", ...ASKS });
  const urgent = chatParticipant({ id: "asker-urgent", handle: "urgent", ...ASKS });
  let releaseLong!: () => void;
  const results: Record<string, any> = {};
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker" },
    others: [queued, urgent],
    turn: async ({ participantId, prompt, actor, service, call, signal }) => {
      if (participantId === "asker-queued") {
        if (call === 1) results.queued = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Queued question" }] });
        return "Asked.";
      }
      if (participantId === "asker-urgent") {
        if (call === 1) results.urgent = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Urgent correction" }], deliver: "now" });
        return "Asked now.";
      }
      if (call === 1) {
        // The long turn: it ends only when it is cut (or the test lets it).
        await new Promise<void>((resolve) => {
          releaseLong = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "Half of the old variant.";
      }
      return /Urgent correction/.test(prompt) ? "Took the correction." : /Queued question/.test(prompt) ? "Answered the queued question." : "Other.";
    }
  });
  return { chat, results, releaseLong: () => releaseLong?.() };
}

test("deliver now cuts a busy member's running turn and runs the request next, before the request that waited; what the cut turn wrote stays", async () => {
  const { chat, results } = busyWorkerChat();
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "long-run", content: "@worker build the old variant" });
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "worker").length === 1, 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "queued-run", content: "@queued ask worker" });
  await waitFor(() => results.queued?.status === "running", 5_000);
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent tell worker now" });
  await waitFor(() => chat.prompts.filter((item) => item.participantId === "worker").length === 3, 8_000);

  assert.deepEqual(results.urgent.delivery, [{
    target: "@worker",
    way: "interrupted-and-restarted",
    note: "@worker is working, and Codex cannot take a message in the middle of a turn: its running turn is interrupted (what it wrote stays, as after a Stop) and it goes on at once in the same session with this request. Work that was waiting for it runs after."
  }]);
  const workerPrompts = chat.prompts.filter((item) => item.participantId === "worker").map((item) => item.prompt);
  assert.match(workerPrompts[1], /Urgent correction/, "the request delivered now runs right after the cut turn");
  assert.match(workerPrompts[2], /Queued question/, "the request that waited is not lost: it runs after");

  const cut = chat.storage.current.messages.find((message: any) => message.content === "Half of the old variant.");
  assert.equal(cut.status, "done");
  assert.equal(cut.metadata.turnContinues, true, "cut for the message, never stopped by user");
  assert.notEqual(cut.metadata.terminalReason, "user-stopped");
  await waitFor(() => chat.storage.current.metadata.running === false, 8_000);
  const batches = chat.storage.current.messages.map((message: any) => message.metadata?.participantRequest).filter(Boolean);
  const itemOf = (prompt: string): any => batches.flatMap((batch: any) => batch.items).find((item: any) => item.prompt === prompt);
  assert.equal(itemOf("Urgent correction").status, "answered");
  assert.equal(itemOf("Queued question").status, "answered");
  assert.equal(chat.debugEvents.some(({ event, payload }) => event === "chat.deliver-now" && (payload.cutRunIds as string[] | undefined)?.length === 1), true);
});

test("deliver now to a member that is not working just starts it, and says so", async () => {
  const urgent = chatParticipant({ id: "asker-urgent", handle: "urgent", ...ASKS });
  let result: any;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker" },
    others: [urgent],
    turn: async ({ participantId, actor, service, call }) => {
      if (participantId === "asker-urgent" && call === 1) {
        result = await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "Urgent correction" }], deliver: "now" });
      }
      return "Done.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent tell worker now" });
  await waitFor(() => chat.prompts.some((item) => item.participantId === "worker"), 5_000);
  assert.deepEqual(result.delivery, [{ target: "@worker", way: "started", note: "@worker was not working: it starts on the request now." }]);
  await waitFor(() => chat.storage.current.metadata.running === false, 5_000);
});

test("deliver takes queue or now only", async () => {
  const urgent = chatParticipant({ id: "asker-urgent", handle: "urgent", ...ASKS });
  let error: unknown;
  const chat = selfCompactingChat({
    participant: { id: "worker", handle: "worker" },
    others: [urgent],
    turn: async ({ participantId, actor, service, call }) => {
      if (participantId === "asker-urgent" && call === 1) {
        error = (await service.requestParticipantsFromTool(actor, { requests: [{ target: "worker", prompt: "x" }], deliver: "soon" })).error;
      }
      return "Done.";
    }
  });
  await chat.service.sendMessage({ conversationId: chat.conversation.id, runId: "urgent-run", content: "@urgent ask" });
  await waitFor(() => error !== undefined, 5_000);
  assert.equal(error, "deliver is \"queue\" or \"now\".");
});

test("a Claude Code member takes a request delivered now in its live CLI: the CLI's own send-now once the message is written", async () => {
  const { chat } = busyWorkerChat();
  const parts = chatParts(chat.service);
  const asked: unknown[][] = [];
  chatDependencies(chat.service).cliRunner.memberClaudeSendNow = async (...args: unknown[]) => {
    asked.push(args);
    return "delivering";
  };
  await parts.runCancel.deliverNow("chat-compact", "worker", "forced-run", "into-running-turn");
  assert.deepEqual(asked, [["chat-compact", "worker", "forced-run", undefined]]);
  assert.equal(chat.debugEvents.some(({ event, payload }) => event === "chat.deliver-now" && payload.outcome === "delivering"), true);

  const claude = chatParticipant({ id: "claude-worker", handle: "cw", kind: "claude-code" });
  const forced = { id: "m", role: "participant", content: "", createdAt: "", metadata: { participantRequest: { deliver: "now" } } } as never;
  assert.equal(parts.turnQueue.deliveryPriority(claude, forced), "live");
  assert.equal(parts.turnQueue.deliveryPriority(chatParticipant({ kind: "gemini-cli" }), forced), "next");
  assert.equal(parts.turnQueue.deliveryPriority(claude, { ...(forced as object), metadata: { participantRequest: {} } } as never), undefined);
});
