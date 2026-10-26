import assert from "node:assert/strict";
import test from "node:test";
import type { ChatAppToolApproval, Conversation, ReviewProgress } from "../../shared/types";
import { HubPhonePublisher } from "./hubPhonePublisher";

function chatWith(approval: ChatAppToolApproval): Conversation {
  const at = "2026-10-25T09:00:00.000Z";
  return {
    id: "chat-1", title: "Work", kind: "chat", createdAt: at, updatedAt: at, findings: [], messages: [],
    metadata: { participants: [{ id: "p-mac", handle: "mac", roleConfigId: "software-engineer", kind: "claude-code" }], pendingAppToolApprovals: [approval] }
  } as unknown as Conversation;
}

const approval: ChatAppToolApproval = {
  id: "approval-1", conversationId: "chat-1", requesterParticipantId: "p-mac", requesterHandle: "mac", requesterRoleConfigId: "software-engineer",
  toolName: "Bash", capability: "artifacts.write" as ChatAppToolApproval["capability"], status: "pending", request: {} as ChatAppToolApproval["request"],
  summary: "Run a command", createdAt: "2026-10-25T09:00:00.000Z", updatedAt: "2026-10-25T09:00:00.000Z"
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function publisher(state: { client?: object; phones: boolean; appended: unknown[]; posted: unknown[]; wake: unknown[] }) {
  return new HubPhonePublisher({
    storage: { deviceEventBlobs: () => ({ prepare: async (value: unknown) => value }) } as never,
    eventLog: { appendLocalEvent: async (event: unknown) => { state.appended.push(event); return { event } as never; } } as never,
    client: () => state.client as never,
    hasPhones: async () => state.phones,
    buildCatalog: async () => ({ roles: {}, prompts: [], skills: [] }),
    wakeKeys: async () => [{ machineId: "m-1", instanceId: "i-1", region: "us-east-1", credentials: { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" } }],
    log: () => undefined
  });
}

test("a card raised before the server confirmed this desktop, or before a phone paired, is published once either is so", async () => {
  const state = { client: undefined as object | undefined, phones: false, appended: [] as unknown[], posted: [] as unknown[], wake: [] as unknown[] };
  const cards = publisher(state);
  cards.noteConversation(chatWith(approval));
  await tick();
  assert.equal(state.appended.length, 0, "no server link yet");
  state.client = { setMachineWake: async (machines: unknown) => { state.wake.push(machines); return { ok: true, machines: 0 }; } };
  cards.flushApprovals();
  await tick();
  assert.equal(state.appended.length, 0, "no phone yet: nothing is published for nobody");
  state.phones = true;
  cards.flushApprovals();
  await tick();
  assert.equal(state.appended.length, 1, "published once the phone paired");
  cards.noteConversation(chatWith(approval));
  cards.flushApprovals();
  await tick();
  assert.equal(state.appended.length, 1, "the same word on the same card is not published again");
  cards.noteConversation(chatWith({ ...approval, status: "approved", updatedAt: "2026-10-25T09:01:00.000Z" }));
  await tick();
  assert.equal(state.appended.length, 2, "its answer is");
});

test("the server holds no start keys while no phone is paired, and a member's progress is posted, never logged", async () => {
  const posted: unknown[] = [];
  const state = { client: { setMachineWake: async (machines: unknown[]) => { state.wake.push(machines); return { ok: true, machines: machines.length }; },
    postProgress: async (frames: unknown[]) => { posted.push(...frames); return { ok: true }; } } as object, phones: false, appended: [] as unknown[], posted, wake: [] as unknown[] };
  const hub = publisher(state);
  hub.publishWakeKeys();
  await tick();
  assert.deepEqual(state.wake, [[]], "an empty set: the server forgets any key it had");
  state.phones = true;
  hub.reset();
  hub.publishWakeKeys();
  await tick();
  assert.equal((state.wake[1] as unknown[]).length, 1);
  const progress = { runId: "run-1", phase: "debate", message: "", createdAt: "2026-10-25T09:00:00.000Z",
    agentProgress: { participantId: "p-mac", participantLabel: "@mac", state: "running", messageId: "m-1", partialContent: "Hello" } } as ReviewProgress;
  hub.noteProgress(progress, "chat-1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(posted.length, 1, "posted to the server");
  assert.equal(state.appended.length, 0, "nothing written to this desktop's event log");
  hub.noteProgress({ ...progress, phase: "done", agentProgress: { ...progress.agentProgress!, state: "finished", partialContent: "Hello there" } }, "chat-1");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(posted.length, 2, "the last word goes at once");
});

test("a machine member's progress is left to its machine, even for a chat not saved here since the start", async () => {
  const posted: unknown[] = [];
  const hub = new HubPhonePublisher({
    storage: { deviceEventBlobs: () => ({ prepare: async (value: unknown) => value }) } as never,
    eventLog: { appendLocalEvent: async () => ({}) as never } as never,
    client: () => ({ postProgress: async (frames: unknown[]) => { posted.push(...frames); return { ok: true }; } }) as never,
    hasPhones: async () => true,
    machineMembersOf: async () => new Set(["p-box"]),
    buildCatalog: async () => ({ roles: {}, prompts: [], skills: [] }),
    wakeKeys: async () => [],
    log: () => undefined
  });
  const progress = (participantId: string, runId: string) => ({ runId, phase: "debate", message: "", createdAt: "2026-10-25T09:00:00.000Z",
    agentProgress: { participantId, participantLabel: "@x", state: "running", messageId: `m-${runId}`, partialContent: "Hello" } }) as ReviewProgress;
  hub.noteProgress(progress("p-box", "run-box"), "chat-2");
  await tick();
  for (let round = 0; round < 3; round += 1) {
    hub.noteProgress(progress("p-box", "run-box"), "chat-2");
    hub.noteProgress(progress("p-mac", "run-mac"), "chat-2");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.deepEqual([...new Set(posted.map((frame) => (frame as { runId: string }).runId))], ["run-mac"]);
});
