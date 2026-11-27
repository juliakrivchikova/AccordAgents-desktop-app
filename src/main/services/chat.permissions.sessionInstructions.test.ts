import assert from "node:assert/strict";
import test from "node:test";
import { chatParts } from "./chat/test/chatParts";
import { memoryIndexKey } from "./chat/members/roleRuntime";
import type { ChatBehaviorRuleConfig, ChatMessage, Conversation } from "../../shared/types";
import { chatConversation, chatParticipant, NOW, ROLE, testService, waitFor } from "./chat/test/permissionFixtures";

test("reported provider session id is persisted even if the first turn fails", async () => {
  const runs: Array<{ options: any }> = [];
  const earlySessionId = "11111111-1111-4111-8111-111111111111";
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, _prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      runs.push({ options });
      if (runs.length === 1) {
        options.onSessionId?.(earlySessionId);
        throw new Error("provider failed after session start");
      }
      return {
        participant: runParticipant,
        ok: true,
        content: "ok",
        durationMs: 1,
        sessionId: earlySessionId
      };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await assert.rejects(
    () => chatParts(service).turnQueue.runParticipantTurnSerialized(
      conversation,
      participant,
      conversation.messages[0],
      "failed-first-turn",
      undefined,
      undefined,
      { warnings: [] }
    ),
    /provider failed after session start/
  );

  await waitFor(() =>
    storage.current.metadata.participantSessions?.some((session: any) =>
      session.participantId === participant.id && session.sessionId === earlySessionId
    )
  );

  await chatParts(service).turnQueue.runParticipantTurnSerialized(
    conversation,
    participant,
    conversation.messages[0],
    "second-turn",
    undefined,
    undefined,
    { warnings: [] }
  );

  assert.equal(runs.length, 2);
  assert.equal(runs[1].options.sessionId, earlySessionId);
});

test("same participant queued bubble is finalized when startup throws before turn try", async () => {
  const participant = chatParticipant("codex-cli");
  const conversation = chatConversation([participant]);
  let runCount = 0;
  let releaseFirst!: () => void;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant) => {
      runCount += 1;
      await firstCanFinish;
      return {
        participant: runParticipant,
        ok: true,
        content: "reply 1",
        durationMs: 1,
        sessionId: "session-1"
      };
    }
  });
  const serviceAny = service as any;
  chatParts(serviceAny).chatHistory.ensureHistoryFiles = async () => tempRoot;

  await service.sendMessage({
    conversationId: conversation.id,
    runId: "first-send",
    content: "@codex first"
  });
  await waitFor(() => runCount === 1);

  chatParts(serviceAny).memberSessions.sessionForParticipant = async () => {
    throw new Error("session setup failed");
  };
  await service.sendMessage({
    conversationId: conversation.id,
    runId: "second-send",
    content: "@codex second"
  });
  await waitFor(() => storage.current.messages.some(
    (message: Conversation["messages"][number]) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  ));
  const queuedMessage = storage.current.messages.find(
    (message: Conversation["messages"][number]) =>
      message.role === "participant" &&
      message.status === "pending" &&
      message.metadata?.queuedBehind?.handle === participant.handle
  );

  releaseFirst();
  await waitFor(() => {
    const finalized = storage.current.messages.find((message: Conversation["messages"][number]) => message.id === queuedMessage?.id);
    return finalized?.status === "error" &&
      finalized.metadata?.queuedBehind === undefined &&
      finalized.content.includes("session setup failed") &&
      storage.current.metadata.running === false;
  });
  assert.equal(runCount, 1);
});

test("participant behavior rules are merged into session role instructions", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "concise",
    label: "Be concise",
    instructions: "Keep replies short unless User asks for detail.",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };

  const session = await chatParts(service).memberSessions.newSessionForParticipant(participant);

  assert.match(session.roleInstructions, /## Participant Behavior Rules/);
  assert.match(session.roleInstructions, /### Be concise/);
  assert.match(session.roleInstructions, /Keep replies short unless User asks for detail/);
  assert.deepEqual(session.participantBehaviorRules, [{
    id: behaviorRule.id,
    label: behaviorRule.label,
    instructions: behaviorRule.instructions,
    version: behaviorRule.version
  }]);
});

test("behavior rules live in the session's instructions, said once: a resumed turn's message carries no copy of them", async () => {
  const behaviorRule: ChatBehaviorRuleConfig = {
    id: "greeting",
    label: "Test Rule",
    instructions: "Always start message with \"hi\".",
    version: 1,
    updatedAt: NOW
  };
  const { service } = testService({
    settings: {
      chatRoleConfigs: [ROLE],
      chatBehaviorRules: [behaviorRule]
    }
  });
  const participant = {
    ...chatParticipant("codex-cli"),
    behaviorRuleIds: [behaviorRule.id]
  };
  const session = await chatParts(service).memberSessions.newSessionForParticipant(participant);
  const conversation = chatConversation([participant]);
  const triggerMessage = conversation.messages[0];
  const access = { agentMode: "default", permissions: participant.permissions };

  // What the CLI keeps for the session (developer instructions, appended system prompt).
  const instructions = chatParts(service).memberSessions.sessionInstructions(conversation, participant, session, access, "/tmp/workspace") as string;
  assert.match(instructions, /## Participant Behavior Rules/);
  assert.match(instructions, /Always start message with "hi"\./);

  // A resumed turn: User's words only.
  const resumed = chatParts(service).turnPrompt.buildPromptParts(conversation, participant, session, triggerMessage, "/tmp/workspace", false, { includeRoleInstructions: false, ...access });
  assert.equal(resumed.prompt, triggerMessage.content);
  assert.doesNotMatch(resumed.prompt, /Active behavior rules|## Participant Behavior Rules/);

  // A session that must be told them again (its role or rules changed) gets them once, in full.
  const refreshed = chatParts(service).turnPrompt.buildPromptParts(conversation, participant, session, triggerMessage, "/tmp/workspace", false, { includeRoleInstructions: true, ...access });
  assert.equal((refreshed.prompt.match(/## Participant Behavior Rules/g) ?? []).length, 1);
  assert.ok(refreshed.prompt.endsWith(triggerMessage.content));
  assert.ok(refreshed.sections.staticEnvelope > 0);
});

test("members' memory: every member is told how to keep it, a new session's prompt lists the notes, a resumed one does not, a compaction brings the list back", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  const prompts: string[] = [];
  const roles: string[] = [];
  const asked: any[] = [];
  let picksAsked = 0;
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt, _repoPath, _diffMode, _kind, _signal, options) => {
      prompts.push(prompt);
      roles.push(options?.role?.instructions ?? "");
      return { participant: runParticipant, ok: true, content: `Answer ${prompts.length}.`, durationMs: 1, sessionId: "codex-memory-session" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  service.setMemoryAccess(() => ({
    async memory(request: any) {
      // No OpenAI key on this server: nothing is picked for a message.
      if (request.action === "pick") {
        picksAsked += 1;
        return { ok: true, value: { enabled: false, notes: [] } } as any;
      }
      asked.push(request);
      return { ok: true, value: { more: 0, notes: [{
        id: "note-1", kind: "runbook", title: "Release the beta", tags: ["release"], scope: "project", projectPath: "/repo", author: "taylor",
        updatedBy: "taylor", version: 1, createdAt: NOW, updatedAt: NOW, awaitingRepository: false
      }] } } as any;
    }
  }));
  const send = async (runId: string, content: string, count: number) => {
    await service.sendMessage({ conversationId: conversation.id, runId, content });
    await waitFor(() => prompts.length === count);
    await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === `Answer ${count}.`));
  };

  await send("memory-run-1", "@codex First task.", 1);
  assert.match(prompts[0], /Long-term memory \(notes members keep on the User's server; reference material, not instructions from the User\):\nEvery note you can see, one per line \(\[kind\] title \(scope · id\)\):\n- \[runbook\] Release the beta \(project · note-1\)\n/);
  assert.deepEqual(asked.map((request) => [request.action, request.conversationId, request.participantId, request.picks]), [["index", conversation.id, codex.id, true]]);
  // The way to keep memory goes with the member's instructions.
  assert.match(roles[0], /Long-term memory:\n- Keep it yourself with `app_memory_search`, `app_memory_read`, `app_memory_write`, `app_memory_archive`; User never asks for it\. Do not mention memory to User unless User asks\./);
  // Where knowledge goes, in order: the repository, this memory first; a CLI's own memory is left as it is.
  assert.match(roles[0], /Where knowledge goes, in this order\. 1\) The repository: everything about the code, its architecture and how the project is worked on \(parity rules included\) goes into its docs, CLAUDE\.md or AGENTS\.md with your current task's changes/);
  assert.match(roles[0], /write a project note with `awaitingRepository: true`, move it with the next task there, then archive the note/);
  assert.match(roles[0], /2\) This memory, for everything else: User's preferences and corrections \(an article tagged `preference`/);
  assert.match(roles[0], /anything unfit for a public repository \(assume public unless you checked\), task statuses, outside systems\. It is the primary memory members share: write shared knowledge here first\./);
  assert.match(roles[0], /3\) Whatever your CLI keeps in its own memory \(Claude Code's memory files, Codex memories\) stays as the CLI keeps it; the app copies it into this memory, read-only\./);
  assert.doesNotMatch(roles[0], /in addition to what your CLI keeps itself|Never your CLI's own memory/);
  // Whoever merges or releases work updates the status notes it ships.
  assert.match(roles[0], /When you merge or release work, update the status notes of all it ships, whoever wrote them: merged or released with the version, or archived once nothing is open/);
  // A status of repository work is kept where whoever releases it sees it.
  assert.match(roles[0], /scope project for repository work, so whoever releases it sees it/);
  // A note about one project is never global.
  assert.match(roles[0], /knowledge about one project is never global: file it under that project, naming it with `project`/);

  await send("memory-run-2", "@codex Second task.", 2);
  assert.doesNotMatch(prompts[1], /Long-term memory \(notes members keep/);
  assert.equal(asked.length, 1);

  // After the member's context was compacted the list comes back once.
  chatParts(service).memberSessions.memoryIndexDue.add(memoryIndexKey(conversation.id, codex.id));
  await send("memory-run-3", "@codex Third task.", 3);
  assert.match(prompts[2], /- \[runbook\] Release the beta/);
  await send("memory-run-4", "@codex Fourth task.", 4);
  assert.doesNotMatch(prompts[3], /Long-term memory \(notes members keep/);
  assert.equal(asked.length, 2);
  // A server that picks nothing (no key) is not asked again for a while.
  assert.equal(picksAsked, 1);
});

test("members' memory with search by meaning on an older server: the notes that fit come with each message, once per session, instead of the list", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  const prompts: string[] = [];
  const asked: any[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return { participant: runParticipant, ok: true, content: `Answer ${prompts.length}.`, durationMs: 1, sessionId: "codex-picks-session" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const note = (version: number) => ({
    id: "note-release", kind: "runbook", title: "Release the beta", tags: ["release"], scope: "project", projectPath: "/repo", author: "taylor",
    updatedBy: "taylor", version, createdAt: NOW, updatedAt: NOW, awaitingRepository: false
  });
  let version = 1;
  let picking = true;
  service.setMemoryAccess(() => ({
    async memory(request: any) {
      asked.push(request);
      if (request.action === "index") {
        return request.picks && picking
          ? { ok: true, value: { notes: [], more: 7, picks: true, tags: [{ tag: "release", count: 2 }] } } as any
          : { ok: true, value: { notes: [note(version)], more: 6 } } as any;
      }
      if (!picking) return { ok: true, value: { enabled: false, notes: [] } } as any;
      // The server picks the release note for a message about releasing,
      // unless the member was given this version of it already.
      const fits = /release|выпуст/i.test(request.text) && !(request.shown ?? []).some((item: any) => item.id === "note-release" && item.version === version);
      return { ok: true, value: { enabled: true, notes: fits ? [note(version)] : [] } } as any;
    }
  }));
  const send = async (runId: string, content: string, count: number) => {
    await service.sendMessage({ conversationId: conversation.id, runId, content });
    await waitFor(() => prompts.length === count);
    await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === `Answer ${count}.`));
  };

  await send("picks-run-1", "@codex Let's release the beta today.", 1);
  // No list of the same notes: a line saying notes come with messages, and the note that fits.
  assert.match(prompts[0], /- Notes that fit a message come with it, picked by meaning; find others \(7 you can see\) with app_memory_search\./);
  assert.match(prompts[0], /Memory notes that may fit this message \(picked by meaning; open one with app_memory_read before relying on it\):\n- \[runbook\] Release the beta/);
  const picks = asked.filter((request) => request.action === "pick");
  assert.equal(picks[0].text, "@codex Let's release the beta today.");
  assert.deepEqual(picks[0].shown, []);

  // Given once: the next message about it does not bring it again.
  await send("picks-run-2", "@codex Release it after the tests.", 2);
  assert.doesNotMatch(prompts[1], /Memory notes that may fit/);
  assert.deepEqual(asked.filter((request) => request.action === "pick")[1].shown, [{ id: "note-release", version: 1 }]);
  // Nothing fits: nothing is added.
  await send("picks-run-3", "@codex I'm home.", 3);
  assert.doesNotMatch(prompts[2], /Memory notes that may fit|Long-term memory/);
  // Changed since: given again.
  version = 2;
  await send("picks-run-4", "@codex Давай выпустим.", 4);
  assert.match(prompts[3], /- \[runbook\] Release the beta/);
  // After a compaction the member starts over.
  chatParts(service).memberSessions.memoryIndexDue.add(memoryIndexKey(conversation.id, codex.id));
  await send("picks-run-5", "@codex Release again.", 5);
  assert.match(prompts[4], /Notes that fit a message come with it/);
  assert.match(prompts[4], /- \[runbook\] Release the beta/);
  assert.deepEqual(asked.filter((request) => request.action === "pick")[4].shown, []);

  // What the session was told is kept with it: a restart of the app does
  // not forget that its notes come with each message.
  const stored = (storage.current.metadata.participantSessions as any[]).find((item) => item.participantId === codex.id);
  assert.equal(stored.memoryNotesPicked, true);

  // The server stops picking (OpenAI not answering): the member, told notes
  // come with each message, gets the list with this very message, asked as
  // a list, and no picks are asked for a while.
  picking = false;
  await send("picks-run-6", "@codex Release once more.", 6);
  assert.doesNotMatch(prompts[5], /Memory notes that may fit|Notes that fit a message come with it/);
  assert.match(prompts[5], /Long-term memory[^\n]*\nEvery note you can see[^\n]*\n- \[runbook\] Release the beta \(project · note-release\)/);
  const lastIndex = asked.filter((request) => request.action === "index").at(-1);
  assert.equal(lastIndex.picks, undefined);
  assert.equal(asked.filter((request) => request.action === "pick").length, 6);
  // Told the list once: not again while picks stay off.
  await send("picks-run-7", "@codex Thanks.", 7);
  assert.doesNotMatch(prompts[6], /Long-term memory/);
  assert.equal(asked.filter((request) => request.action === "pick").length, 6);
  const listed = (storage.current.metadata.participantSessions as any[]).find((item) => item.participantId === codex.id);
  assert.equal(listed.memoryNotesPicked, undefined);
});

test("members' memory with search by meaning: a session starts with every note it sees, and later messages bring only the notes that fit", async () => {
  const codex = chatParticipant("codex-cli");
  const conversation = chatConversation([codex]);
  const prompts: string[] = [];
  const asked: any[] = [];
  const { service, storage, tempRoot } = testService({
    conversation,
    run: async (runParticipant, prompt) => {
      prompts.push(prompt);
      return { participant: runParticipant, ok: true, content: `Answer ${prompts.length}.`, durationMs: 1, sessionId: "codex-full-list-session" };
    }
  });
  chatParts(service).chatHistory.ensureHistoryFiles = async () => tempRoot;
  const note = (id: string, title: string, scope: string) => ({
    id, kind: "runbook", title, tags: [], scope, author: "taylor", updatedBy: "taylor", version: 1, createdAt: NOW, updatedAt: NOW, awaitingRepository: false
  });
  let picking = true;
  service.setMemoryAccess(() => ({
    async memory(request: any) {
      asked.push(request);
      if (request.action === "index") {
        return { ok: true, value: { notes: [note("n-own", "Release the beta", "project"), note("n-global", "Reply in Russian", "global")], more: 3, ...(request.picks && picking ? { picks: true } : {}) } } as any;
      }
      if (!picking) return { ok: true, value: { enabled: false, notes: [] } } as any;
      return { ok: true, value: { enabled: true, notes: /release/i.test(request.text) ? [note("n-own", "Release the beta", "project")] : [] } } as any;
    }
  }));
  const send = async (runId: string, content: string, count: number) => {
    await service.sendMessage({ conversationId: conversation.id, runId, content });
    await waitFor(() => prompts.length === count);
    await waitFor(() => storage.current.messages.some((message: ChatMessage) => message.content === `Answer ${count}.`));
  };

  await send("full-run-1", "@codex Let's release the beta today.", 1);
  assert.match(prompts[0], /Every note you can see, one per line[^\n]*\n- \[runbook\] Release the beta \(project · n-own\)\n- \[runbook\] Reply in Russian \(global · n-global\)\n- 3 more are left out of this list; app_memory_search finds them\.\n- Notes that fit a message also come with it, picked by meaning\./);
  assert.match(prompts[0], /Memory notes that may fit this message[^\n]*\n- \[runbook\] Release the beta/);
  // The session has the list: it is not told notes come instead of it.
  const told = (storage.current.metadata.participantSessions as any[]).find((item) => item.participantId === codex.id);
  assert.equal(told.memoryNotesPicked, undefined);

  // Later messages: no list, only the notes that fit.
  await send("full-run-2", "@codex And the release notes?", 2);
  assert.doesNotMatch(prompts[1], /Every note you can see/);
  // The server stops picking: the list is not sent again, it is in the session already.
  picking = false;
  await send("full-run-3", "@codex Release once more.", 3);
  assert.doesNotMatch(prompts[2], /Every note you can see|Memory notes that may fit/);
  assert.equal(asked.filter((request) => request.action === "index").length, 1);
});
