import assert from "node:assert/strict";
import test from "node:test";
import { AppMcpService } from "./appMcp";
import { appMcpParts } from "./appMcp/test/appMcpParts";
import { chatParts } from "./chat/test/chatParts";
import { participantTurnMode } from "./chat/members/roleRuntime";
import type { ChatMessage, ChatParticipant } from "../../shared/types";
import { chatConversation, chatParticipant, NOW, testService, waitFor } from "./chat/test/permissionFixtures";

test("a Claude member takes the next message while its previous reply is still running, without resending that reply's context", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const prompts: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt: string, _repoPath: unknown, _diffMode: unknown, _kind: unknown, _signal: unknown, runOptions: any) => {
      runOptions?.warm?.onMessageWritten?.();
      runOptions?.warm?.onReplyStarted?.();
      prompts.push(prompt);
      if (prompts.length === 1) {
        await firstBlocked;
        return { participant: runParticipant, ok: true, content: "First done.", durationMs: 1 };
      }
      markSecondStarted();
      return { participant: runParticipant, ok: true, content: "Second done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({ conversationId: conversation.id, runId: "send-first", content: `@${participant.handle} first task alpha` });
  await waitFor(() => prompts.length === 1);
  await service.sendMessage({ conversationId: conversation.id, runId: "send-second", content: `@${participant.handle} second question beta` });
  await secondStarted;
  assert.equal(prompts.length, 2, "the second message reached the member while the first reply was still running");
  assert.match(prompts[1], /second question beta/);
  assert.doesNotMatch(prompts[1], /first task alpha/, "context the running turn already delivered is not sent again");
  // Its CLI took it at once (onReplyStarted): once that is in the chat,
  // nothing waits behind the running reply.
  await waitFor(() => storage.current.messages.filter((message: ChatMessage) => message.metadata?.queuedBehind || message.metadata?.turnQueued).length === 0);
  releaseFirst();
  await waitFor(() => storage.current.messages.filter((message: ChatMessage) =>
    message.role === "participant" && message.status === "done").length === 2);
});

test("a Claude reply that ends when the next message joins its step is stored as finished while that message's reply still runs", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  let calls = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let releaseSecond!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      runOptions?.warm?.onMessageWritten?.();
      calls += 1;
      if (calls === 1) {
        runOptions.onOutput?.({ kind: "tool", text: "Using Bash\n", activityKind: "command", activityStatus: "started" });
        await firstBlocked;
        return { participant: runParticipant, ok: true, content: "", durationMs: 1 };
      }
      await secondBlocked;
      return { participant: runParticipant, ok: true, content: "TWO", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "fold-first", content: `@${participant.handle} count files` });
  await waitFor(() => calls === 1);
  await service.sendMessage({ conversationId: conversation.id, runId: "fold-second", content: `@${participant.handle} reply TWO` });
  await waitFor(() => calls === 2);
  releaseFirst();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.role === "participant" && message.status === "done" && message.content === ""));
  const first = storage.current.messages.find((message: ChatMessage) =>
    message.role === "participant" && message.status === "done" && message.content === "");
  assert.equal(typeof first.metadata?.workedMs, "number", "the finished reply keeps its worked time");
  assert.ok(first.metadata?.activityEvents?.some((event: { label: string }) => event.label === "Using Bash"));
  releaseSecond();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "TWO" && message.status === "done"));
  await waitFor(() => !storage.current.metadata.running);
  const after = storage.current.messages.find((message: ChatMessage) => message.id === first.id);
  assert.equal(after?.status, "done");
  assert.equal(typeof after?.metadata?.workedMs, "number", "the other turn's stale copy does not strip the finished reply");
});

test("a Claude member's app tools keep acting for the running reply until the CLI hands it the next message", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const appMcp = new AppMcpService();
  appMcpParts(appMcp).mcpServer.url = "http://127.0.0.1:1/mcp";
  const runs: any[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let releaseSecond!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    appMcp,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      runOptions?.warm?.onMessageWritten?.();
      runs.push(runOptions);
      if (runs.length === 1) {
        await firstBlocked;
        return { participant: runParticipant, ok: true, content: "First done.", durationMs: 1 };
      }
      await secondBlocked;
      return { participant: runParticipant, ok: true, content: "Second done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const actorRunId = (token: string): string | undefined => appMcpParts(appMcp).accessTokens.tokens.get(token)?.runId;

  await service.sendMessage({ conversationId: conversation.id, runId: "grant-first", content: `@${participant.handle} first` });
  await waitFor(() => runs.length === 1);
  const token = runs[0].appMcp.token;
  assert.equal(actorRunId(token), runs[0].warm.origin.runId);
  await service.sendMessage({ conversationId: conversation.id, runId: "grant-second", content: `@${participant.handle} second` });
  await waitFor(() => runs.length === 2);
  assert.equal(runs[1].appMcp.token, token, "both messages go to the same CLI process and token");
  assert.equal(actorRunId(token), runs[0].warm.origin.runId, "the running reply keeps its tools until the next message reaches a step");
  assert.equal(typeof runs[1].warm.onReplyStarted, "function");
  runs[1].warm.onReplyStarted();
  assert.equal(actorRunId(token), runs[1].warm.origin.runId);

  releaseFirst();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "First done." && message.status === "done"));
  assert.equal(actorRunId(token), runs[1].warm.origin.runId, "the first reply ending does not take the tools back");
  releaseSecond();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "Second done." && message.status === "done"));
});

test("a message sent while a Claude member works is queued until its CLI takes it, then counts from the running step's start", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const runs: any[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let releaseSecond!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      runOptions?.warm?.onMessageWritten?.();
      runs.push(runOptions);
      if (runs.length === 1) {
        await firstBlocked;
        return { participant: runParticipant, ok: true, content: "", durationMs: 1 };
      }
      await secondBlocked;
      return { participant: runParticipant, ok: true, content: "Second done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "step-first", content: `@${participant.handle} first` });
  await waitFor(() => runs.length === 1);
  const first = storage.current.messages.find((message: ChatMessage) => message.role === "participant" && message.status === "pending")!;
  assert.equal(first.metadata?.turnQueued, undefined, "the first message starts at once");
  await service.sendMessage({ conversationId: conversation.id, runId: "step-second", content: `@${participant.handle} тест` });
  await waitFor(() => runs.length === 2);
  const secondId = runs[1].warm.origin.messageId;
  const queued = storage.current.messages.find((message: ChatMessage) => message.id === secondId)!;
  assert.equal(queued.metadata?.turnQueued, true, "the CLI holds the second message: its reply is queued, with no Working of its own");
  assert.ok(queued.metadata?.queuedBehind);

  // The CLI hands it to the running step at the step's next tool result.
  runs[1].warm.onReplyStarted({ joinedReply: runs[0].warm.origin });
  await waitFor(() => storage.current.messages.find((message: ChatMessage) => message.id === secondId)?.metadata?.turnStartedAt !== undefined);
  const started = storage.current.messages.find((message: ChatMessage) => message.id === secondId)!;
  assert.equal(started.metadata?.turnQueued, undefined);
  assert.equal(started.metadata?.queuedBehind, undefined);
  assert.equal(started.metadata?.turnStartedAt, first.metadata?.turnStartedAt ?? first.createdAt, "one turn, one clock: it counts from the running step's start");

  releaseFirst();
  releaseSecond();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.id === secondId && message.status === "done"));
  const done = storage.current.messages.find((message: ChatMessage) => message.id === secondId)!;
  assert.equal(done.metadata?.turnStartedAt, first.metadata?.turnStartedAt ?? first.createdAt);
  assert.ok((done.metadata?.workedMs ?? -1) >= Date.parse(done.createdAt) - Date.parse(first.createdAt), "its worked time covers the whole turn");
  assert.equal(storage.current.messages.find((message: ChatMessage) => message.id === first.id)?.status, "done");
});

test("a Claude reply the next message joined is stored as part of a turn that goes on: no worked time of its own; the last part's covers the turn", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const runs: any[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let releaseSecond!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      runOptions?.warm?.onMessageWritten?.();
      runs.push(runOptions);
      if (runs.length === 1) {
        await firstBlocked;
        return { participant: runParticipant, ok: true, content: "Checking first.", durationMs: 1, turnContinues: true };
      }
      await secondBlocked;
      return { participant: runParticipant, ok: true, content: "All done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "part-first", content: `@${participant.handle} first` });
  await waitFor(() => runs.length === 1);
  await service.sendMessage({ conversationId: conversation.id, runId: "part-second", content: `@${participant.handle} тест` });
  await waitFor(() => runs.length === 2);
  runs[1].warm.onReplyStarted({ joinedReply: runs[0].warm.origin, joinedStepStartedAt: Date.now() });
  releaseFirst();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "Checking first." && message.status === "done"));
  const part = storage.current.messages.find((message: ChatMessage) => message.content === "Checking first.")!;
  assert.equal(part.metadata?.turnContinues, true);
  assert.equal(part.metadata?.workedMs, undefined, "no Worked for of its own");
  releaseSecond();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "All done." && message.status === "done"));
  const last = storage.current.messages.find((message: ChatMessage) => message.content === "All done.")!;
  assert.equal(last.metadata?.turnContinues, undefined);
  assert.equal(last.metadata?.turnStartedAt, part.createdAt, "the turn's one Worked for counts from the turn's start");
  assert.equal(typeof last.metadata?.workedMs, "number");
});

test("Stop on a Claude reply its CLI still holds removes it, and the running reply goes on", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const runs: any[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, signal: AbortSignal | undefined, runOptions: any) => {
      runOptions?.warm?.onMessageWritten?.();
      runs.push(runOptions);
      if (runs.length === 1) {
        await firstBlocked;
        return { participant: runParticipant, ok: true, content: "First done.", durationMs: 1 };
      }
      // The CLI takes it out of its queue when stopped (cancel_async_message).
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { participant: runParticipant, ok: false, content: "", error: "Chat run cancelled.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "hold-first", content: `@${participant.handle} first` });
  await waitFor(() => runs.length === 1);
  await service.sendMessage({ conversationId: conversation.id, runId: "hold-second", content: `@${participant.handle} second` });
  await waitFor(() => runs.length === 2);
  const secondId = runs[1].warm.origin.messageId;
  assert.equal(storage.current.messages.find((message: ChatMessage) => message.id === secondId)?.metadata?.turnQueued, true);
  await service.cancelRun(runs[1].warm.origin.runId);
  await waitFor(() => {
    const second = storage.current.messages.find((message: ChatMessage) => message.id === secondId);
    return !second || (second.status !== "pending" && !second.metadata?.turnQueued && !second.metadata?.queuedBehind);
  });
  releaseFirst();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "First done." && message.status === "done"));
  assert.equal(storage.current.messages.some((message: ChatMessage) => message.metadata?.turnQueued || message.metadata?.queuedBehind), false, "nothing is left queued");
});

test("a queued Claude message the CLI starts on its own step (the one before ended) counts from then", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  const runs: any[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let releaseSecond!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      runOptions?.warm?.onMessageWritten?.();
      runs.push(runOptions);
      if (runs.length === 1) {
        await firstBlocked;
        return { participant: runParticipant, ok: true, content: "First done.", durationMs: 1 };
      }
      await secondBlocked;
      return { participant: runParticipant, ok: true, content: "Second done.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "own-first", content: `@${participant.handle} first` });
  await waitFor(() => runs.length === 1);
  await service.sendMessage({ conversationId: conversation.id, runId: "own-second", content: `@${participant.handle} second` });
  await waitFor(() => runs.length === 2);
  const secondId = runs[1].warm.origin.messageId;
  releaseFirst();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "First done." && message.status === "done"));
  const before = Date.now();
  runs[1].warm.onReplyStarted();
  await waitFor(() => storage.current.messages.find((message: ChatMessage) => message.id === secondId)?.metadata?.turnQueued === undefined);
  const started = storage.current.messages.find((message: ChatMessage) => message.id === secondId)!;
  assert.ok(Date.parse(started.metadata?.turnStartedAt ?? "") >= before - 5, "its own turn starts when the CLI starts it");
  releaseSecond();
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.id === secondId && message.status === "done"));
});

test("only the User's own messages reach a busy Claude member at once; a member request, a resume or a goal waits", () => {
  const { service } = testService();
  const claude = chatParticipant("claude-code");
  const codex = chatParticipant("codex-cli");
  const user = { id: "u", role: "user", content: "hi", createdAt: NOW, status: "done" } as ChatMessage;
  const system = { id: "s", role: "system", content: "Auto-resumed", createdAt: NOW, status: "done" } as ChatMessage;
  const request = { id: "r", role: "participant", participantId: "other", content: "@claude do it", createdAt: NOW, status: "done" } as ChatMessage;
  const goal = { ...user, metadata: { nativeCommand: { name: "goal" } } } as unknown as ChatMessage;
  const mode = (participant: ChatParticipant, trigger: ChatMessage): string => participantTurnMode(participant, trigger);
  assert.equal(mode(claude, user), "shared");
  assert.equal(mode(claude, system), "exclusive");
  assert.equal(mode(claude, request), "exclusive");
  assert.equal(mode(claude, goal), "exclusive");
  assert.equal(mode(codex, user), "exclusive");
});

test("overlapping messages to a Claude member reach its CLI in the order they were sent", async () => {
  const { service } = testService();
  const first = chatParts(service).promptContext.openClaudeWriteGate("conversation", "member");
  const second = chatParts(service).promptContext.openClaudeWriteGate("conversation", "member");
  const third = chatParts(service).promptContext.openClaudeWriteGate("conversation", "member");
  const order: string[] = [];
  void second.previous.then(() => order.push("second may write"));
  void third.previous.then(() => order.push("third may write"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, [], "nothing is written before the first message");
  second.markWritten();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, [], "the third waits for the first as well");
  first.markWritten();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["second may write", "third may write"]);
});

test("a reply the Claude CLI starts on its own after background work becomes a new message next to the reply that started the work", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  let warmOptions: any;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      warmOptions = runOptions.warm;
      runOptions.onOutput?.({ kind: "tool", text: "Running in the background: soak\n", activityKind: "status", activityStatus: "started" });
      return { participant: runParticipant, ok: true, content: "Started the soak.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "send-soak", content: `@${participant.handle} run the soak in the background` });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.role === "participant" && message.status === "done" && message.content === "Started the soak."));
  const origin = storage.current.messages.find((message: ChatMessage) => message.content === "Started the soak.");
  assert.equal(warmOptions.origin.runId, origin.metadata.runId);
  assert.equal(warmOptions.origin.messageId, origin.id);
  assert.equal(warmOptions.origin.threadId, origin.metadata.threadId);
  assert.equal(typeof warmOptions.onSelfResumedTurn, "function");

  let finish!: (result: unknown) => void;
  let attachedSignal: AbortSignal | undefined;
  warmOptions.onSelfResumedTurn({
    origin: warmOptions.origin,
    attach: (handlers: any) => {
      attachedSignal = handlers.signal;
      handlers.onOutput?.({ kind: "tool", text: "Background task finished: soak\n", activityKind: "status", activityStatus: "completed" });
      handlers.onOutput?.({ kind: "text", text: "The soak passed.", cumulative: "The soak passed." });
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.role === "participant" && message.status === "pending" && message.id !== origin.id));
  const pending = storage.current.messages.find((message: ChatMessage) =>
    message.role === "participant" && message.status === "pending");
  assert.equal(pending.metadata.parentMessageId, origin.id, "it sits next to the reply that started the work");
  assert.equal(pending.metadata.threadId, origin.metadata.threadId);
  assert.ok(storage.current.metadata.activeRunIds?.includes(pending.metadata.runId), "it is a live run with its own Stop");
  assert.ok(attachedSignal);

  finish({ participant, ok: true, content: "The soak passed.", durationMs: 1 });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.id === pending.id && message.status === "done"));
  const done = storage.current.messages.find((message: ChatMessage) => message.id === pending.id);
  assert.equal(done.content, "The soak passed.");
  assert.ok(done.metadata.activityEvents?.some((event: { label: string }) => /Background task finished: soak/.test(event.label)));
  await waitFor(() => !(storage.current.metadata.activeRunIds ?? []).includes(pending.metadata.runId));
});

test("a reply the Claude CLI started on its own that her next message joins keeps its steps open with no Worked for of its own", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  let warmOptions: any;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      warmOptions = runOptions.warm;
      return { participant: runParticipant, ok: true, content: "Started.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "send-self-join", content: `@${participant.handle} start` });
  await waitFor(() => Boolean(warmOptions) && storage.current.messages.some((message: ChatMessage) => message.content === "Started."));
  let finish!: (result: unknown) => void;
  warmOptions.onSelfResumedTurn({
    origin: warmOptions.origin,
    attach: (handlers: any) => {
      handlers.onOutput?.({ kind: "tool", text: "Running tests", activityKind: "command", activityStatus: "started", activityItemId: "tool-1" });
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.role === "participant" && message.status === "pending"));
  const pending = storage.current.messages.find((message: ChatMessage) =>
    message.role === "participant" && message.status === "pending");
  finish({ participant, ok: true, content: "", durationMs: 1, turnContinues: true });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.id === pending.id && message.status === "done"));
  const done = storage.current.messages.find((message: ChatMessage) => message.id === pending.id);
  assert.equal(done.metadata.turnContinues, true);
  assert.equal(done.metadata.workedMs, undefined, "the clock goes on in the part her message joined");
  assert.ok(done.metadata.activityEvents?.some((event: { label: string }) => event.label === "Running tests"));
});

test("Stop on a reply the Claude CLI started on its own interrupts it", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  let warmOptions: any;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      warmOptions = runOptions.warm;
      return { participant: runParticipant, ok: true, content: "Started.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  await service.sendMessage({ conversationId: conversation.id, runId: "send-start", content: `@${participant.handle} start` });
  await waitFor(() => Boolean(warmOptions) && storage.current.messages.some((message: ChatMessage) => message.content === "Started."));
  warmOptions.onSelfResumedTurn({
    origin: warmOptions.origin,
    attach: (handlers: any) => new Promise((_resolve, reject) => {
      handlers.signal?.addEventListener("abort", () => reject(new Error("claude warm process was cancelled")), { once: true });
    })
  });
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.role === "participant" && message.status === "pending"));
  const pending = storage.current.messages.find((message: ChatMessage) =>
    message.role === "participant" && message.status === "pending");
  assert.equal(service.cancelRun(pending.metadata.runId), true);
  await waitFor(() => storage.current.messages.some((message: ChatMessage) =>
    message.id === pending.id && message.metadata?.terminalReason === "user-stopped"));
});

test("a Claude member's live background tasks are reported to the app as they start and end, and are never stored with the chat", async () => {
  const participant = chatParticipant("claude-code");
  const conversation = chatConversation([participant]);
  let warmOptions: any;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, runOptions: any) => {
      warmOptions = runOptions.warm;
      return { participant: runParticipant, ok: true, content: "Started the soak.", durationMs: 1 };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const events: unknown[] = [];
  service.onBackgroundTasksChanged((event) => events.push(event));
  await service.sendMessage({ conversationId: conversation.id, runId: "send-bg", content: `@${participant.handle} start the soak` });
  await waitFor(() => Boolean(warmOptions));
  assert.equal(typeof warmOptions.onBackgroundTasksChanged, "function");

  warmOptions.onBackgroundTasksChanged([{ id: "t1", label: "Run the soak", origin: warmOptions.origin }]);
  warmOptions.onBackgroundTasksChanged([{ id: "t1", label: "Run the soak", origin: warmOptions.origin }]);
  assert.deepEqual(service.backgroundTasksForConversation(conversation.id), { [participant.id]: ["Run the soak"] });
  assert.equal(events.length, 1, "an unchanged list is not reported again");
  await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === "Started the soak."));
  assert.equal(JSON.stringify(storage.current).includes("Run the soak"), false, "live state is not written into the chat");

  warmOptions.onBackgroundTasksChanged([]);
  assert.deepEqual(service.backgroundTasksForConversation(conversation.id), {});
  assert.deepEqual(events.at(-1), { conversationId: conversation.id, participantId: participant.id, labels: [] });
});

test("a machine's members' background tasks show until that machine reports them done or goes away", () => {
  const { service } = testService();
  const events: Array<{ participantId: string; labels: string[] }> = [];
  service.onBackgroundTasksChanged((event) => events.push(event));
  service.applyMachineBackgroundTasks("machine-a", { conversationId: "c1", participantId: "p1", labels: ["build"] });
  service.applyMachineBackgroundTasks("machine-a", { conversationId: "c1", participantId: "p2", labels: ["watch"] });
  service.applyMachineBackgroundTasks("machine-b", { conversationId: "c1", participantId: "p3", labels: ["serve"] });
  assert.deepEqual(service.backgroundTasksForConversation("c1"), { p1: ["build"], p2: ["watch"], p3: ["serve"] });
  service.applyMachineBackgroundTasks("machine-a", { conversationId: "c1", participantId: "p1", labels: [] });
  assert.deepEqual(Object.keys(service.backgroundTasksForConversation("c1")).sort(), ["p2", "p3"]);
  service.replaceMachineBackgroundTasks("machine-a", []);
  assert.deepEqual(service.backgroundTasksForConversation("c1"), { p3: ["serve"] }, "only the machine that went away is cleared");
  assert.deepEqual(events.at(-1), { conversationId: "c1", participantId: "p2", labels: [] });
  // A machine's full list after its hello replaces what it reported before.
  service.applyMachineBackgroundTasks("machine-b", { conversationId: "c1", participantId: "p4", labels: ["stale"] });
  service.replaceMachineBackgroundTasks("machine-b", [{ conversationId: "c1", participantId: "p3", labels: ["serve", "tail"] }]);
  assert.deepEqual(service.backgroundTasksForConversation("c1"), { p3: ["serve", "tail"] });
  assert.deepEqual(service.localBackgroundTasks(), [], "a machine's members are not reported as this host's");
});
