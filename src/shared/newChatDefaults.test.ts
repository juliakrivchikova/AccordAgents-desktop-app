import assert from "node:assert/strict";
import test from "node:test";

import {
  accordFromAnySessionOn,
  applyNewChatDefaultsUpdate,
  newChatCompactionPermission,
  newChatDefaultsForProvider,
  newChatMainSessionStart,
  normalizeNewChatDefaults,
  withNewChatRights
} from "./newChatDefaults";
import { defaultChatAgentPermissions } from "./agentPermissions";
import { newChatLeadStart, newChatMainSessionFor } from "./newChat";
import type { ChatParticipant } from "./types";

test("what Settings stores is read as the CLI's own when missing or invalid, with compaction without asking unless turned off", () => {
  assert.deepEqual(normalizeNewChatDefaults(undefined), { compactWithoutAsking: true });
  assert.deepEqual(normalizeNewChatDefaults("junk"), { compactWithoutAsking: true });
  assert.deepEqual(normalizeNewChatDefaults({ compactWithoutAsking: false }), { compactWithoutAsking: false });
  assert.deepEqual(normalizeNewChatDefaults({ compactWithoutAsking: "no" }), { compactWithoutAsking: true });
  // Model, effort and mode need the CLI they were chosen for.
  assert.deepEqual(normalizeNewChatDefaults({ model: "opus", reasoningEffort: "high", access: "auto" }), { compactWithoutAsking: true });
  assert.deepEqual(normalizeNewChatDefaults({ kind: "claude-code", model: " opus ", reasoningEffort: "HIGH", access: "default" }),
    { kind: "claude-code", model: "opus", reasoningEffort: "high", access: "manual", compactWithoutAsking: true }, "Claude Code's Default is called Manual now");
  assert.deepEqual(normalizeNewChatDefaults({ kind: "codex-cli", access: "acceptEdits", reasoningEffort: "loud" }), { compactWithoutAsking: true },
    "a mode Codex does not have, an effort nobody has");
  assert.deepEqual(normalizeNewChatDefaults({ kind: "codex-cli", access: "read-only" }), { kind: "codex-cli", access: "read-only", compactWithoutAsking: true },
    "Codex's Read Only is one of its presets, though its picker lists it only while it is the mode");
  assert.deepEqual(normalizeNewChatDefaults({ kind: "nope", model: "x", homeMachineId: "x".repeat(300) }), { compactWithoutAsking: true });
});

test("a change keeps what it does not touch; model, effort and mode for another CLI start from that CLI's own", () => {
  const claude = applyNewChatDefaultsUpdate(undefined, { kind: "claude-code", model: "opus", reasoningEffort: "high" });
  assert.deepEqual(claude, { kind: "claude-code", model: "opus", reasoningEffort: "high", compactWithoutAsking: true });
  assert.deepEqual(applyNewChatDefaultsUpdate(claude, { homeMachineId: "m-1", compactWithoutAsking: false }),
    { ...claude, homeMachineId: "m-1", compactWithoutAsking: false });
  assert.deepEqual(applyNewChatDefaultsUpdate(claude, { kind: "claude-code", model: null }), { kind: "claude-code", reasoningEffort: "high", compactWithoutAsking: true });
  assert.deepEqual(applyNewChatDefaultsUpdate({ ...claude, homeMachineId: "m-1" }, { kind: "codex-cli", access: "auto-review" }),
    { kind: "codex-cli", access: "auto-review", homeMachineId: "m-1", compactWithoutAsking: true });
  // A kind alone never relabels another CLI's choices.
  assert.deepEqual(applyNewChatDefaultsUpdate(claude, { kind: "codex-cli", compactWithoutAsking: false }), { ...claude, compactWithoutAsking: false });
  assert.deepEqual(newChatDefaultsForProvider({ ...claude, homeMachineId: "m-1", compactWithoutAsking: false }), { homeMachineId: "m-1", compactWithoutAsking: false });
});

test("scheduled tasks without asking: off unless turned on, kept through other changes, and only as Settings says", () => {
  assert.equal(normalizeNewChatDefaults({ scheduleWithoutAsking: "yes" }).scheduleWithoutAsking, undefined);
  const on = applyNewChatDefaultsUpdate(undefined, { scheduleWithoutAsking: true });
  assert.deepEqual(on, { compactWithoutAsking: true, scheduleWithoutAsking: true });
  assert.equal(applyNewChatDefaultsUpdate(on, { kind: "claude-code", model: "opus" }).scheduleWithoutAsking, true);
  assert.equal(newChatDefaultsForProvider(on).scheduleWithoutAsking, true, "another provider keeps it");
  assert.equal(applyNewChatDefaultsUpdate(on, { scheduleWithoutAsking: false }).scheduleWithoutAsking, undefined);
  const start = newChatMainSessionStart(on, { kind: "claude-code", hostId: "zai" });
  assert.equal(start.scheduleWithoutAsking, true);
  assert.equal(withNewChatRights(defaultChatAgentPermissions(), start).scheduleWithoutAsking, true);
  assert.equal(withNewChatRights({ ...defaultChatAgentPermissions(), scheduleWithoutAsking: true }, newChatMainSessionStart(undefined, { kind: "claude-code" })).scheduleWithoutAsking,
    undefined, "a row that brings it does not give it");
});

test("Accords from any member: off unless turned on, kept through other changes and another provider, read as Settings says now", () => {
  assert.equal(normalizeNewChatDefaults({ accordFromAnySession: "yes" }).accordFromAnySession, undefined);
  assert.equal(accordFromAnySessionOn(undefined), false, "off by default");
  const on = applyNewChatDefaultsUpdate(undefined, { accordFromAnySession: true });
  assert.deepEqual(on, { compactWithoutAsking: true, accordFromAnySession: true });
  assert.equal(accordFromAnySessionOn(on), true);
  assert.equal(applyNewChatDefaultsUpdate(on, { kind: "claude-code", model: "opus" }).accordFromAnySession, true);
  assert.equal(applyNewChatDefaultsUpdate(on, { scheduleWithoutAsking: true }).accordFromAnySession, true);
  assert.equal(newChatDefaultsForProvider(on).accordFromAnySession, true, "another provider keeps it");
  assert.equal(accordFromAnySessionOn(applyNewChatDefaultsUpdate(on, { accordFromAnySession: false })), false);
  assert.equal(applyNewChatDefaultsUpdate(on, { accordFromAnySession: false }).accordFromAnySession, undefined);
});

test("a new chat's main session starts with the choices for its own CLI, on a machine still set up, with its compaction right", () => {
  const defaults = { kind: "claude-code", model: "opus", reasoningEffort: "high", access: "plan", homeMachineId: "m-1", compactWithoutAsking: false };
  assert.deepEqual(newChatMainSessionStart(defaults, { kind: "claude-code" }, ["m-1"]),
    { model: "opus", reasoningEffort: "high", access: "plan", homeMachineId: "m-1", requestCompaction: "ask" });
  assert.deepEqual(newChatMainSessionStart(defaults, { kind: "codex-cli" }, ["m-1"]), { homeMachineId: "m-1", requestCompaction: "ask" }, "another CLI: its own");
  assert.deepEqual(newChatMainSessionStart(defaults, { kind: "claude-code", hostId: "zai" }, ["m-1"]), { requestCompaction: "ask" },
    "an added provider: its own, on this computer (its key is this computer's)");
  assert.deepEqual(newChatMainSessionStart(defaults, { kind: "claude-code" }, []).homeMachineId, undefined, "a machine no longer set up: this computer");
  assert.equal(newChatMainSessionStart(defaults, { kind: "claude-code" }).homeMachineId, "m-1", "machines not known: as stored");
  assert.equal(newChatMainSessionStart(undefined, { kind: "claude-code" }).requestCompaction, "allow");
  assert.equal(newChatCompactionPermission({ compactWithoutAsking: true }), "allow");
  assert.equal(newChatCompactionPermission(undefined), "allow");
});

test("the phone starts its New chat controls from the main session the computer offers, on that provider only", () => {
  const lead = {
    id: "main-session", handle: "main", roleConfigId: "main-session", kind: "codex-cli", model: "gpt-5.5", reasoningEffort: "high", homeMachineId: "m-1",
    agentMode: "auto", permissions: { repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "allow", requestCompaction: "allow", shell: { enabled: false, rules: [] }, cliApprovals: true }
  } as ChatParticipant;
  assert.deepEqual(newChatLeadStart(lead, { kind: "codex-cli" }), { model: "gpt-5.5", reasoningEffort: "high", access: "auto-review", homeMachineId: "m-1" });
  assert.deepEqual(newChatLeadStart(lead, { kind: "claude-code" }), { homeMachineId: "m-1" }, "another provider: where it runs only");
  assert.deepEqual(newChatLeadStart(lead, { kind: "codex-cli", hostId: "zai" }), {}, "an added provider runs on the computer only");
  // The mode her config starts the CLI in (no mode of its own yet): none.
  const plain = { ...lead, model: undefined, reasoningEffort: undefined, homeMachineId: undefined, agentMode: "default",
    permissions: { ...lead.permissions!, cliApprovals: undefined } } as ChatParticipant;
  assert.deepEqual(newChatLeadStart(plain, { kind: "codex-cli" }), {});
  assert.deepEqual(newChatLeadStart(undefined, { kind: "codex-cli" }), {});
});

test("the phone's new chat keeps the computer's own model and effort when the offer's list lacks them (not read yet after a restart)", () => {
  const offered = {
    id: "main-session", handle: "main", roleConfigId: "main-session", kind: "claude-code", model: "sonnet", reasoningEffort: "high", agentMode: "default",
    permissions: { repoRead: true, workspaceWrite: false, webAccess: false, requestParticipants: "allow", requestCompaction: "allow", shell: { enabled: false, rules: [] } }
  } as ChatParticipant;
  const empty = [{ kind: "claude-code" as const, label: "Claude Code", defaultModelLabel: "Claude Code", models: [], efforts: [] }];
  const made = newChatMainSessionFor(offered, empty, { kind: "claude-code", model: "sonnet", reasoningEffort: "high" });
  assert.deepEqual([made.model, made.reasoningEffort, made.permissions?.requestCompaction], ["sonnet", "high", "allow"]);
  const other = newChatMainSessionFor(offered, empty, { kind: "claude-code", model: "opus", reasoningEffort: "max" });
  assert.deepEqual([other.model, other.reasoningEffort], [undefined, undefined], "a model the computer neither lists nor runs is not sent");
});
