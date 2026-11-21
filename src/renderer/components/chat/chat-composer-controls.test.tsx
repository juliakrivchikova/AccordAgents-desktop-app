// The sessions view's composer controls (the User, 2026-11-21): Codex's Plan
// mode kept when a preset is chosen, Full Access and Plan mode held back on
// a machine whose program is older, a member's … menu, and the main session's
// actions in the chat title's menu.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultChatAgentPermissions } from "../../../shared/agentPermissions";
import { chatAccessOptions, selectedChatAccessOption, codexPlanModeOn } from "../../../shared/chatAccessModes";
import type { ChatAgentMode, ChatParticipant } from "../../../shared/types";
import { ChatMemberComposerControls, type ChatModelAccessPatch } from "./chat-model-access-picker";
import { accessHeldReason, applyChatAccessOptionKeepingPlan } from "./chat-access-controls";
import { ChatMemberActionsMenu } from "./chat-member-model-access";
import { resetMemberModelCatalogs } from "./chat-member-model-name";
import { ChatTitleMenuContent, type ChatViewHeaderState } from "./chat-view-switch";

const noop = (): void => undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const byTestId = (id: string) => (node: ReactTestInstance): boolean => typeof node.type === "string" && node.props["data-testid"] === id;

const CODEX: ChatParticipant = {
  id: "p-codex", handle: "codex", roleConfigId: "r", kind: "codex-cli", agentMode: "default",
  permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true }
};

async function renderControls(value: ChatParticipant, onChange: (patch: ChatModelAccessPatch) => unknown, bridge: Record<string, unknown> = {}) {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  resetMemberModelCatalogs();
  host.consensus = {
    listProviderModels: async () => ({ kind: "codex-cli", authoritative: true, fetchedAt: "t", models: [{ id: "gpt-6-luna", label: "GPT-6-Luna", recommended: true, source: "cli" }] }),
    listMachines: async () => ({ machines: [], status: [] }),
    ...bridge
  };
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<TooltipProvider><ChatMemberComposerControls value={value} onChange={onChange} runsOn={{}} /></TooltipProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root: renderer!.root, done: () => { act(() => renderer!.unmount()); host.consensus = previous; } };
}

test("choosing a Codex preset keeps its Plan mode as it was, a member saved in Plan from before too", () => {
  const legacy = { kind: "codex-cli" as const, agentMode: "plan" as ChatAgentMode, permissions: { ...defaultChatAgentPermissions(), cliApprovals: true as const } };
  for (const option of chatAccessOptions("codex-cli")) {
    const patch = applyChatAccessOptionKeepingPlan(legacy, option);
    assert.equal(codexPlanModeOn("codex-cli", patch.agentMode, patch.permissions), true, `${option.label}: Plan mode stays on`);
    assert.equal(selectedChatAccessOption("codex-cli", patch.agentMode, patch.permissions)?.id, option.id, `${option.label}: the preset chosen`);
  }
  const off = applyChatAccessOptionKeepingPlan(CODEX, chatAccessOptions("codex-cli")[2]!);
  assert.equal(codexPlanModeOn("codex-cli", off.agentMode, off.permissions), false, "off stays off");
  const claude = applyChatAccessOptionKeepingPlan({ kind: "claude-code", agentMode: "default", permissions: CODEX.permissions }, chatAccessOptions("claude-code")[3]!);
  assert.equal(claude.permissions?.codexPlanMode, undefined, "Claude Code has no Plan toggle");
});

test("on a machine whose program is older, Full Access and Plan mode are disabled with the reason; on an up-to-date one they are offered", async () => {
  const onBox = { ...CODEX, homeMachineId: "m-box" };
  const machines = (supported: boolean) => ({
    listMachines: async () => ({ machines: [{ id: "m-box", name: "Box" }], status: [{ machineId: "m-box", name: "Box", connected: true, lastHello: supported ? { cliModesSupported: true } : {} }] })
  });
  const old = await renderControls(onBox, noop, machines(false));
  try {
    const plan = old.root.find(byTestId("chat-model-plan"));
    assert.equal(plan.props.disabled, true, "Plan mode cannot be turned on there");
    assert.match(plan.props.title, /Box runs an older program: Settings → Machines → Upgrade runtime\./);
    await act(async () => { old.root.find(byTestId("chat-model-mode")).props.onClick(); });
    const full = old.root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "full-access")!;
    assert.equal(full.props.disabled, true);
    assert.match(textOf(full), /Upgrade runtime/, "the reason in its place");
    assert.equal(old.root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "auto-review")!.props.disabled, false, "the other presets stay");
  } finally {
    old.done();
  }
  const fresh = await renderControls(onBox, noop, machines(true));
  try {
    assert.equal(fresh.root.find(byTestId("chat-model-plan")).props.disabled, false);
    await act(async () => { fresh.root.find(byTestId("chat-model-mode")).props.onClick(); });
    assert.equal(fresh.root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "full-access")!.props.disabled, false);
  } finally {
    fresh.done();
  }
});

test("while its turn runs, a menu says why its choices wait", async () => {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  resetMemberModelCatalogs();
  host.consensus = { listProviderModels: async () => undefined, listMachines: async () => ({ machines: [], status: [] }) };
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(<TooltipProvider><ChatMemberComposerControls value={CODEX} onChange={noop} disabled /></TooltipProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { renderer!.root.find(byTestId("chat-model-mode")).props.onClick(); });
    assert.match(textOf(renderer!.root.find(byTestId("chat-access-busy"))), /Its turn is running/);
    assert.ok(renderer!.root.findAll(byTestId("chat-access-option")).every((row) => row.props.disabled), "nothing changes meanwhile");
  } finally {
    if (renderer) act(() => renderer!.unmount());
    host.consensus = previous;
  }
});

test("a member's … menu: Restart, Fork to new chat and Remove from chat, each doing what it says", async () => {
  const removed: string[] = [];
  const forked: string[] = [];
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ChatMemberActionsMenu participant={{ ...CODEX, kind: "claude-code" }} status="idle" onRestart={noop}
      onRemove={() => removed.push("p-codex")} onForkToNewChat={() => forked.push("p-codex")} />);
  });
  const trigger = renderer!.root.find(byTestId("chat-member-actions"));
  assert.equal(trigger.props["aria-label"], "More");
  act(() => trigger.props.onClick());
  const items = renderer!.root.findAll(byTestId("chat-member-action"));
  assert.deepEqual(items.map((item) => textOf(item.find((node) => node.props.className === "composer-menu-item-label"))), ["Restart", "Fork to new chat", "Remove from chat"]);
  act(() => items[2]!.props.onClick());
  assert.deepEqual(removed, ["p-codex"]);
  assert.equal(renderer!.root.findAll(byTestId("chat-member-action")).length, 0, "the menu closes");
  act(() => renderer!.unmount());
  // Nothing to offer: no … at all.
  act(() => { renderer = create(<ChatMemberActionsMenu participant={{ ...CODEX, kind: "gemini-cli" }} status="idle" />); });
  assert.equal(renderer!.root.findAll(byTestId("chat-member-actions")).length, 0);
  act(() => renderer!.unmount());
  assert.deepEqual(forked, []);
});

test("the chat title's menu lists the main session's Restart and Fork to new chat under the view switch, closing when one is chosen", () => {
  const calls: Array<[string, number]> = [];
  let picked = 0;
  const state: ChatViewHeaderState = {
    view: "sessions", canSwitch: true, onChangeView: noop,
    mainSession: {
      id: "p-main",
      actions: (id, close, tasks) => {
        calls.push([id, tasks]);
        return [{ label: "Restart", onSelect: close }, { label: "Fork to new chat", detail: "Copies it", onSelect: close }];
      }
    }
  };
  let renderer: ReturnType<typeof create> | undefined;
  act(() => { renderer = create(<ChatTitleMenuContent state={state} onPicked={() => { picked += 1; }} mainSessionBackgroundTasks={2} />); });
  const group = renderer!.root.find(byTestId("chat-title-menu-main-session"));
  assert.match(textOf(group), /^Main session/);
  assert.deepEqual(group.findAll(byTestId("chat-member-action")).map((item) => textOf(item.find((node) => node.props.className === "composer-menu-item-label"))), ["Restart", "Fork to new chat"]);
  assert.deepEqual(calls[0], ["p-main", 2], "its background work is named to Restart");
  act(() => group.findAll(byTestId("chat-member-action"))[1]!.props.onClick());
  assert.equal(picked, 1, "the menu closes");
  act(() => renderer!.unmount());
  act(() => { renderer = create(<ChatTitleMenuContent state={{ ...state, mainSession: undefined }} onPicked={noop} mainSessionBackgroundTasks={0} />); });
  assert.equal(renderer!.root.findAll(byTestId("chat-title-menu-main-session")).length, 0, "a chat without one: the view switch only");
  act(() => renderer!.unmount());
});

test("a member the main session made is held only above the main session's mode: Plan, below Manual, stays open", () => {
  const main = { ...CODEX, id: "p-main", kind: "claude-code" as const, agentMode: "default" as ChatAgentMode, permissions: { ...defaultChatAgentPermissions(), workspaceWrite: false, cliApprovals: true as const } };
  const member = { ...CODEX, id: "p-made", kind: "claude-code" as const, delegatedByParticipantId: "p-main", agentMode: "auto" as ChatAgentMode, permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const } };
  const held = (id: string) => accessHeldReason(member, chatAccessOptions("claude-code").find((option) => option.id === id)!, main);
  assert.equal(held("manual"), undefined);
  assert.equal(held("plan"), undefined, "Plan edits nothing: not above Manual");
  assert.match(held("acceptEdits") ?? "", /Not above the main session's mode \(Manual\)/);
  assert.match(held("auto") ?? "", /Not above/);
});
