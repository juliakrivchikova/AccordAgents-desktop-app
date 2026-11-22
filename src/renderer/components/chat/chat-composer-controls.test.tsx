// The sessions view's composer controls (the User, 2026-11-21): Codex's Plan
// mode kept when a preset is chosen, Full Access and Plan mode held back on
// a machine whose program is older, a member's … menu, and the main session's
// actions in the chat title's menu.
import assert from "node:assert/strict";
import test from "node:test";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import { defaultChatAgentPermissions } from "../../../shared/agentPermissions";
import { chatAccessModeSet, chatAccessOptions, selectedChatAccessOption, codexPlanModeOn } from "../../../shared/chatAccessModes";
import type { ChatAgentMode, ChatParticipant } from "../../../shared/types";
import { ChatMemberComposerControls, type ChatModelAccessPatch } from "./chat-model-access-picker";
import { ClipboardList, Eye, Lock, PenLine, ShieldCheck, ShieldOff, SlidersHorizontal } from "lucide-react";
import { accessHeldReason, accessIcon, applyChatAccessOptionKeepingPlan, ChatAccessMenu, ComposerControlIcon } from "./chat-access-controls";
import { newChatMainSessionParticipantConfig } from "./chat-main-session-draft";
import { COMPOSER_DENSITY, useComposerDensity } from "./use-composer-density";
import { ChatMemberActionsMenu, ChatMemberComposerSettings, type ChatMemberRuntimePatch } from "./chat-member-model-access";
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

test("a Cloud run member is held back by the machine on its AWS instance; its own Full Access or Plan mode there says why its turns are refused", async () => {
  const machines = {
    listMachines: async () => ({ machines: [{ id: "m-old", name: "Old box", awsInstanceId: "i-0123456789abcdef0" }],
      status: [{ machineId: "m-old", name: "Old box", connected: false, lastHello: {} }] })
  };
  const cloud = await renderControls({ ...CODEX, cloudRun: { instanceId: "i-0123456789abcdef0" } }, noop, machines);
  try {
    const plan = cloud.root.find(byTestId("chat-model-plan"));
    assert.equal(plan.props.disabled, true, "Plan mode cannot be turned on for a member that will run there");
    assert.match(plan.props.title, /Old box runs an older program: Settings → Machines → Upgrade runtime\./);
    await act(async () => { cloud.root.find(byTestId("chat-model-mode")).props.onClick(); });
    const full = cloud.root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "full-access")!;
    assert.equal(full.props.disabled, true, "nor Full Access");
  } finally {
    cloud.done();
  }
  // A Cloud run machine still to be set up gets this computer's program.
  const fresh = await renderControls({ ...CODEX, cloudRun: {} }, noop, machines);
  try {
    assert.equal(fresh.root.find(byTestId("chat-model-plan")).props.disabled, false);
  } finally {
    fresh.done();
  }
  // Already in Full Access, with Plan mode on, on the older machine: both
  // can be left, and both say why its turns are refused there.
  const own = { ...CODEX, homeMachineId: "m-old", agentMode: "full-access" as ChatAgentMode, permissions: { ...CODEX.permissions, codexPlanMode: true as const } };
  const stored = await renderControls(own, noop, machines);
  try {
    const plan = stored.root.find(byTestId("chat-model-plan"));
    assert.equal(plan.props.disabled, false, "Plan mode can be turned off");
    assert.match(plan.props.title, /Old box runs an older program/);
    await act(async () => { stored.root.find(byTestId("chat-model-mode")).props.onClick(); });
    assert.match(textOf(stored.root.find(byTestId("chat-access-machine-outdated"))), /Old box runs an older program: Settings → Machines → Upgrade runtime\./);
    assert.equal(stored.root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "auto-review")!.props.disabled, false, "another mode can be chosen");
  } finally {
    stored.done();
  }
});

test("while its turn runs, its permission mode changes where its CLI takes one then (Claude Code); Codex's modes and Plan mode and Antigravity's mode wait", async () => {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  resetMemberModelCatalogs();
  host.consensus = { listProviderModels: async () => undefined, listMachines: async () => ({ machines: [], status: [] }) };
  const claude: ChatParticipant = { ...CODEX, id: "claude-1", handle: "claude", kind: "claude-code", agentMode: "default",
    permissions: { ...CODEX.permissions!, cliApprovals: true, codexPlanMode: undefined, workspaceWrite: false } };
  const agy: ChatParticipant = { ...claude, id: "agy-1", handle: "agy", kind: "gemini-cli" };
  try {
    for (const [member, changes] of [[claude, true], [CODEX, false], [agy, false]] as const) {
      const patches: unknown[] = [];
      let renderer: ReturnType<typeof create> | undefined;
      await act(async () => {
        renderer = create(<TooltipProvider><ChatMemberComposerControls value={member} onChange={(patch) => { patches.push(patch); }} disabled /></TooltipProvider>);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => { renderer!.root.find(byTestId("chat-model-mode")).props.onClick(); });
      const rows = renderer!.root.findAll(byTestId("chat-access-option"));
      assert.equal(rows.every((row) => row.props.disabled), !changes, `${member.kind}: ${changes ? "its modes can be chosen" : "its modes wait"}`);
      assert.equal(renderer!.root.findAll(byTestId("chat-access-busy")).length, changes ? 0 : 1);
      if (member.kind === "codex-cli") {
        assert.equal(renderer!.root.find(byTestId("chat-model-plan")).props.disabled, true, "Codex's Plan mode waits (Shift+Tab does nothing while Codex works)");
      }
      if (changes) {
        const wanted = "acceptEdits";
        const target = rows.find((row) => row.props["data-value"] === wanted && typeof row.props.onClick === "function")!;
        await act(async () => { target.props.onClick(); });
        assert.equal(patches.length, 1, `${member.kind}: the choice is saved at once`);
      }
      act(() => renderer!.unmount());
    }
  } finally {
    host.consensus = previous;
  }
});

test("while its turn runs, a Claude Code member on a machine changes its mode only where the machine's program sets it in the live process; an older program waits", async () => {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  const claude: ChatParticipant = { ...CODEX, id: "claude-box", handle: "claude", kind: "claude-code", agentMode: "default", homeMachineId: "m-box",
    permissions: { ...CODEX.permissions!, cliApprovals: true, codexPlanMode: undefined, workspaceWrite: false } };
  try {
    for (const live of [false, true]) {
      resetMemberModelCatalogs();
      host.consensus = {
        listProviderModels: async () => undefined,
        listMachines: async () => ({ machines: [{ id: "m-box", name: "Box" }], status: [{ machineId: "m-box", name: "Box", connected: true,
          lastHello: live ? { cliModesSupported: true, liveModeChangeSupported: true } : { cliModesSupported: true } }] })
      };
      let renderer: ReturnType<typeof create> | undefined;
      await act(async () => {
        renderer = create(<TooltipProvider><ChatMemberComposerControls value={claude} onChange={noop} disabled /></TooltipProvider>);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => { renderer!.root.find(byTestId("chat-model-mode")).props.onClick(); });
      const rows = renderer!.root.findAll(byTestId("chat-access-option"));
      assert.equal(rows.every((row) => row.props.disabled), !live, live ? "its program sets it now" : "an older program: the mode waits for the turn");
      assert.equal(renderer!.root.findAll(byTestId("chat-access-busy")).length, live ? 0 : 1);
      act(() => renderer!.unmount());
    }
  } finally {
    host.consensus = previous;
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
      renderer = create(<TooltipProvider><ChatMemberComposerControls value={{ ...CODEX, kind: "gemini-cli" }} onChange={noop} disabled /></TooltipProvider>);
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
  assert.doesNotMatch(textOf(group), /main session/i, "no label names the main session: the sessions view names it by nothing");
  assert.deepEqual(group.findAll(byTestId("chat-member-action")).map((item) => textOf(item.find((node) => node.props.className === "composer-menu-item-label"))), ["Restart", "Fork to new chat"]);
  assert.deepEqual(calls[0], ["p-main", 2], "its background work is named to Restart");
  act(() => group.findAll(byTestId("chat-member-action"))[1]!.props.onClick());
  assert.equal(picked, 1, "the menu closes");
  act(() => renderer!.unmount());
  act(() => { renderer = create(<ChatTitleMenuContent state={{ ...state, mainSession: undefined }} onPicked={noop} mainSessionBackgroundTasks={0} />); });
  assert.equal(renderer!.root.findAll(byTestId("chat-title-menu-main-session")).length, 0, "a chat without one: the view switch only");
  act(() => renderer!.unmount());
});

test("a member the main session made is held only above the main session's mode, said as the chat's mode: Plan, below Manual, stays open", () => {
  const main = { ...CODEX, id: "p-main", kind: "claude-code" as const, agentMode: "default" as ChatAgentMode, permissions: { ...defaultChatAgentPermissions(), workspaceWrite: false, cliApprovals: true as const } };
  const member = { ...CODEX, id: "p-made", kind: "claude-code" as const, delegatedByParticipantId: "p-main", agentMode: "auto" as ChatAgentMode, permissions: { ...defaultChatAgentPermissions(), workspaceWrite: true, cliApprovals: true as const } };
  const held = (id: string) => accessHeldReason(member, chatAccessOptions("claude-code").find((option) => option.id === id)!, main);
  assert.equal(held("manual"), undefined);
  assert.equal(held("plan"), undefined, "Plan edits nothing: not above Manual");
  assert.equal(held("acceptEdits"), "Not above the chat's mode (Manual).");
  assert.match(held("auto") ?? "", /Not above/);
});

test("the model chip names the model that runs: her config's, not the one the CLI's list marks default; the effort her config sets", async () => {
  // As the main process lists it: config.toml's gpt-5.6-luna marked, GPT-6-Luna not.
  const efforts = [{ id: "low" as const, label: "Low" }, { id: "medium" as const, label: "Medium" }];
  const catalog = {
    kind: "codex-cli", authoritative: true, fetchedAt: "t",
    models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna (gpt-6-luna)", recommended: false, source: "cli", supportedReasoningEfforts: efforts },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna (gpt-5.6-luna)", recommended: true, source: "cli", supportedReasoningEfforts: efforts }
    ],
    startDefaults: { access: "auto-review", model: "gpt-5.6-luna", modelLabel: "GPT-5.6-Luna", reasoningEffort: "low" }
  };
  const view = await renderControls(CODEX, noop, { listProviderModels: async () => catalog });
  try {
    assert.equal(textOf(view.root.find(byTestId("chat-model-model"))), "GPT-5.6-Luna");
    assert.equal(textOf(view.root.find(byTestId("chat-model-effort"))), "Low", "the effort her config sets, not a bare Default");
    await act(async () => { view.root.find(byTestId("chat-model-effort")).props.onClick(); });
    const defaultRow = view.root.findAll(byTestId("chat-effort-option")).find((row) => row.props["data-value"] === "")!;
    assert.equal(defaultRow.props["aria-checked"], true, "nothing chosen: Default, which runs at Low");
    assert.match(textOf(defaultRow), /^DefaultLow$/);
  } finally {
    view.done();
  }
  // A model chosen: its own name, and Default effort is the CLI's.
  const chosen = await renderControls({ ...CODEX, model: "gpt-6-luna" }, noop, { listProviderModels: async () => catalog });
  try {
    assert.equal(textOf(chosen.root.find(byTestId("chat-model-model"))), "GPT-6-Luna");
    assert.equal(textOf(chosen.root.find(byTestId("chat-model-effort"))), "Default");
  } finally {
    chosen.done();
  }
});

test("a member on a machine: its chip names the model that machine's own config runs", async () => {
  const onBox = { ...CODEX, homeMachineId: "m-box" };
  const view = await renderControls(onBox, noop, {
    listMachines: async () => ({ machines: [{ id: "m-box", name: "Box" }], status: [{ machineId: "m-box", name: "Box", connected: true,
      lastHello: { cliModesSupported: true, cliStartDefaults: { "codex-cli": { access: "read-only", model: "gpt-5.5", modelLabel: "GPT-5.5" } } } }] })
  });
  try {
    assert.equal(textOf(view.root.find(byTestId("chat-model-model"))), "GPT-5.5");
  } finally {
    view.done();
  }
});

test("choosing Codex's Full Access asks first in Codex's words; only Yes switches, Cancel goes back to the list", async () => {
  const patches: ChatModelAccessPatch[] = [];
  const view = await renderControls(CODEX, (patch) => { patches.push(patch); });
  try {
    await act(async () => { view.root.find(byTestId("chat-model-mode")).props.onClick(); });
    const full = () => view.root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "full-access")!;
    await act(async () => { full().props.onClick(); });
    assert.deepEqual(patches, [], "nothing switched yet");
    const confirm = view.root.find(byTestId("chat-full-access-confirm"));
    assert.match(textOf(confirm), /^Enable full access\?When Codex runs with full access, it can edit any file on your computer/);
    assert.equal(view.root.findAll(byTestId("chat-access-option")).length, 0, "in place of the list");
    await act(async () => { view.root.find(byTestId("chat-full-access-confirm-cancel")).props.onClick(); });
    assert.deepEqual(patches, [], "Cancel switches nothing");
    assert.ok(full(), "back to the list");
    await act(async () => { full().props.onClick(); });
    await act(async () => { view.root.find(byTestId("chat-full-access-confirm-yes")).props.onClick(); });
    assert.equal(patches.length, 1);
    assert.equal(selectedChatAccessOption("codex-cli", patches[0]!.agentMode, patches[0]!.permissions)?.label, "Full Access");
    // Another mode switches at once, as Codex's picker does.
    await act(async () => { view.root.find(byTestId("chat-model-mode")).props.onClick(); });
    await act(async () => { view.root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "auto-review")!.props.onClick(); });
    assert.equal(patches.length, 2);
  } finally {
    view.done();
  }
});

test("a second quick choice is made on top of the first one not saved yet: Full Access lowered, then Plan clicked, never returns to Full Access", async () => {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  resetMemberModelCatalogs();
  host.consensus = { listProviderModels: async () => undefined, listMachines: async () => ({ machines: [], status: [] }) };
  const full = { ...CODEX, agentMode: "full-access" as ChatAgentMode, permissions: { ...CODEX.permissions, workspaceWrite: true, cliApprovals: true as const } };
  assert.equal(selectedChatAccessOption("codex-cli", full.agentMode, full.permissions)?.label, "Full Access");
  const saves: Array<{ patch: ChatMemberRuntimePatch; resolve: (ok: boolean) => void }> = [];
  const onUpdate = (_id: string, patch: ChatMemberRuntimePatch) => new Promise<boolean>((resolve) => { saves.push({ patch, resolve }); });
  const element = (member: ChatParticipant) => (
    <TooltipProvider><ChatMemberComposerSettings participant={member} working={false} runLocationLocked={false} runLocationMoves={false} onUpdate={onUpdate} /></TooltipProvider>
  );
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(element(full));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const root = renderer!.root;
    await act(async () => { root.find(byTestId("chat-member-controls-mode")).props.onClick(); });
    await act(async () => { root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "workspace-write")!.props.onClick(); });
    assert.equal(saves.length, 1);
    assert.equal(selectedChatAccessOption("codex-cli", saves[0]!.patch.agentMode, saves[0]!.patch.permissions)?.label, "Ask for approval");
    // Shown at once, before it is saved.
    assert.match(root.find(byTestId("chat-member-controls-mode")).props.title, /Ask for approval/);
    // Plan clicked while the first choice is still being saved.
    await act(async () => { root.find(byTestId("chat-member-controls-plan")).props.onClick(); });
    assert.equal(saves.length, 2);
    const second = saves[1]!.patch;
    assert.equal(selectedChatAccessOption("codex-cli", second.agentMode, second.permissions)?.label, "Ask for approval", "made on top of the first choice, not Full Access");
    assert.equal(codexPlanModeOn("codex-cli", second.agentMode, second.permissions), true);
    // Both saved: the member as stored is shown again.
    const stored = { ...full, agentMode: second.agentMode!, permissions: second.permissions! };
    await act(async () => {
      saves[0]!.resolve(true);
      renderer!.update(element(stored));
      saves[1]!.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(root.find(byTestId("chat-member-controls-mode")).props.title, /Ask for approval/);
    assert.equal(root.find(byTestId("chat-member-controls-plan")).props["aria-pressed"], true);
    // A save that fails shows the member as stored.
    await act(async () => { root.find(byTestId("chat-member-controls-mode")).props.onClick(); });
    await act(async () => { root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "auto-review")!.props.onClick(); });
    assert.match(root.find(byTestId("chat-member-controls-mode")).props.title, /Approve for me/);
    await act(async () => {
      saves[2]!.resolve(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(root.find(byTestId("chat-member-controls-mode")).props.title, /Ask for approval/, "the failed choice is not left on screen");
  } finally {
    if (renderer) act(() => renderer!.unmount());
    host.consensus = previous;
  }
});

test("a new main session in the sessions view starts in the mode her config starts its CLI in, else the CLI's built-in one", () => {
  const made = newChatMainSessionParticipantConfig("codex-cli", true, undefined, true, "auto-review");
  assert.equal(selectedChatAccessOption("codex-cli", made.agentMode, made.permissions)?.label, "Approve for me");
  const claude = newChatMainSessionParticipantConfig("claude-code", true, undefined, true, "acceptEdits");
  assert.equal(selectedChatAccessOption("claude-code", claude.agentMode, claude.permissions)?.label, "Accept edits");
  const unknown = newChatMainSessionParticipantConfig("claude-code", true, undefined, true, undefined);
  assert.equal(selectedChatAccessOption("claude-code", unknown.agentMode, unknown.permissions)?.label, "Manual");
});

test("in a narrow composer a mode turns into its own icon whose name stays for screen readers", () => {
  const icons: Record<string, unknown> = { Manual: Lock, "Accept edits": PenLine, Plan: ClipboardList, Auto: ShieldCheck,
    "Ask for approval": PenLine, "Approve for me": ShieldCheck, "Full Access": ShieldOff,
    Default: Lock, "Accept-edits mode": PenLine, "Auto mode": ShieldCheck, "Plan mode": ClipboardList };
  for (const option of [...chatAccessOptions("claude-code"), ...chatAccessOptions("codex-cli"), ...chatAccessOptions("gemini-cli")]) {
    assert.equal(accessIcon(option), icons[option.label], `${option.label}'s icon`);
  }
  assert.equal(accessIcon(chatAccessModeSet("codex-cli").options.find((option) => option.id === "read-only")), Eye, "Read Only");
  assert.equal(accessIcon(undefined), SlidersHorizontal, "Custom");
  let renderer: ReturnType<typeof create> | undefined;
  act(() => { renderer = create(<ComposerControlIcon icon={accessIcon(chatAccessOptions("claude-code")[0])} label="Manual" />); });
  assert.equal(textOf(renderer!.root), "Manual", "the name for screen readers");
  act(() => renderer!.unmount());
});

test("while its turn runs, Codex's question cannot switch to Full Access", async () => {
  const host = window as unknown as { consensus?: unknown };
  const previous = host.consensus;
  resetMemberModelCatalogs();
  host.consensus = { listProviderModels: async () => undefined, listMachines: async () => ({ machines: [], status: [] }) };
  const patches: ChatModelAccessPatch[] = [];
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(<TooltipProvider><ChatAccessMenu value={CODEX} onSelect={(option) => patches.push(applyChatAccessOptionKeepingPlan(CODEX, option))} /></TooltipProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { renderer!.root.findAll(byTestId("chat-access-option")).find((row) => row.props["data-value"] === "full-access")!.props.onClick(); });
    // The turn starts while the question is open.
    await act(async () => {
      renderer!.update(<TooltipProvider><ChatAccessMenu value={CODEX} disabled onSelect={(option) => patches.push(applyChatAccessOptionKeepingPlan(CODEX, option))} /></TooltipProvider>);
    });
    const yes = renderer!.root.find(byTestId("chat-full-access-confirm-yes"));
    assert.equal(yes.props.disabled, true);
    await act(async () => { yes.props.onClick(); });
    assert.deepEqual(patches, [], "nothing switched");
    assert.match(textOf(renderer!.root.find(byTestId("chat-full-access-confirm-busy"))), /Its turn is running/);
  } finally {
    if (renderer) act(() => renderer!.unmount());
    host.consensus = previous;
  }
});

test("narrow controls step down one level at a time until they fit, and measure again when their row narrows, widens or what they say changes", async () => {
  // How wide the controls are at each level, and how wide their row lets them be.
  const contentAt = [300, 270, 240, 210, 180, 160, 140];
  let available = 400;
  const watching = new Set<{ callback: (entries: Array<{ contentRect: { width: number } }>) => void; targets: Element[] }>();
  // The row's observer (the toolbar) and the controls' own.
  const observed = (entries: Array<{ contentRect: { width: number } }>): void => {
    for (const item of watching) if (item.targets.some((target) => target.classList.contains("chat-composer-toolbar"))) item.callback(entries);
  };
  const ownObserved = (): void => {
    for (const item of watching) if (item.targets.some((target) => !target.classList.contains("chat-composer-toolbar"))) item.callback([]);
  };
  const globals = globalThis as unknown as { ResizeObserver?: unknown };
  const previousObserver = globals.ResizeObserver;
  globals.ResizeObserver = class {
    private readonly item: { callback: (entries: Array<{ contentRect: { width: number } }>) => void; targets: Element[] };
    constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { this.item = { callback, targets: [] }; watching.add(this.item); }
    observe(target: Element): void { this.item.targets.push(target); }
    disconnect(): void { watching.delete(this.item); }
  };
  const proto = HTMLDivElement.prototype as unknown as Record<string, unknown>;
  const scroll = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  const client = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) { return this.dataset.density ? contentAt[Number(this.dataset.density)] : 0; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.dataset.density ? Math.min(available, contentAt[Number(this.dataset.density)]!) : 0; } });
  function Probe(props: { content: string }): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    const density = useComposerDensity(ref, props.content);
    return <div className="chat-composer-toolbar"><div ref={ref} data-density={String(density)} /></div>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const density = (): number => Number(host.querySelector("[data-density]")?.getAttribute("data-density"));
  const resize = async (width: number): Promise<void> => {
    available = width;
    await act(async () => { observed([{ contentRect: { width } }]); });
  };
  try {
    await act(async () => { root.render(<Probe content="a" />); });
    assert.equal(density(), 0, "it fits: every control by its name");
    await resize(400);
    await resize(250);
    assert.equal(density(), 2, "narrowed from the fullest form: two steps to fit");
    await resize(400);
    assert.equal(density(), 0, "widened: back to every control by its name");
    await resize(100);
    assert.equal(density(), COMPOSER_DENSITY.modelShortened, "never past the last level");
    await resize(250);
    await act(async () => { root.render(<Probe content="b" />); });
    assert.equal(density(), 2, "new content measured again from the fullest form");
  } finally {
    act(() => root.unmount());
    host.remove();
    globals.ResizeObserver = previousObserver;
    if (scroll) Object.defineProperty(proto, "scrollWidth", scroll); else delete proto.scrollWidth;
    if (client) Object.defineProperty(proto, "clientWidth", client); else delete proto.clientWidth;
  }
});

test("a composer rendered again with nothing new for its controls (a streamed token) never measures them", async () => {
  // Reading the controls' size forces a layout of the whole page; a running
  // turn renders the composer for every token it streams.
  const contentAt = [300, 270, 240, 210, 180, 160, 140];
  let available = 250;
  let reads = 0;
  const watching = new Set<{ callback: (entries: Array<{ contentRect: { width: number } }>) => void; targets: Element[] }>();
  // The row's observer (the toolbar) and the controls' own.
  const observed = (entries: Array<{ contentRect: { width: number } }>): void => {
    for (const item of watching) if (item.targets.some((target) => target.classList.contains("chat-composer-toolbar"))) item.callback(entries);
  };
  const ownObserved = (): void => {
    for (const item of watching) if (item.targets.some((target) => !target.classList.contains("chat-composer-toolbar"))) item.callback([]);
  };
  const globals = globalThis as unknown as { ResizeObserver?: unknown };
  const previousObserver = globals.ResizeObserver;
  globals.ResizeObserver = class {
    private readonly item: { callback: (entries: Array<{ contentRect: { width: number } }>) => void; targets: Element[] };
    constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) { this.item = { callback, targets: [] }; watching.add(this.item); }
    observe(target: Element): void { this.item.targets.push(target); }
    disconnect(): void { watching.delete(this.item); }
  };
  const proto = HTMLDivElement.prototype as unknown as Record<string, unknown>;
  const scroll = Object.getOwnPropertyDescriptor(proto, "scrollWidth");
  const client = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get(this: HTMLElement) {
    if (!this.dataset.density) return 0;
    reads += 1;
    return contentAt[Number(this.dataset.density)];
  } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.dataset.density ? Math.min(available, contentAt[Number(this.dataset.density)]!) : 0; } });
  function Probe(props: { content: string; token: number }): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    const density = useComposerDensity(ref, props.content);
    return <div className="chat-composer-toolbar"><div ref={ref} data-density={String(density)} data-token={props.token} /></div>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const density = (): number => Number(host.querySelector("[data-density]")?.getAttribute("data-density"));
  try {
    await act(async () => { root.render(<Probe content="a" token={0} />); });
    assert.equal(density(), 2, "fitted to its row once");
    const settled = reads;
    assert.ok(settled > 0, "measured when it first showed");
    for (let token = 1; token <= 50; token += 1) {
      await act(async () => { root.render(<Probe content="a" token={token} />); });
    }
    assert.equal(reads, settled, "fifty renders with the same controls: not one measure");
    assert.equal(density(), 2, "and the same density");
    // What still measures: new words in the controls, and a row of another width.
    await act(async () => { root.render(<Probe content="b" token={51} />); });
    assert.ok(reads > settled, "new content is measured");
    assert.equal(density(), 2, "new content fitted again");
    const beforeResize = reads;
    available = 400;
    await act(async () => { observed([{ contentRect: { width: 400 } }]); });
    await act(async () => { observed([{ contentRect: { width: 420 } }]); });
    assert.ok(reads > beforeResize, "a wider row is measured");
    assert.equal(density(), 0, "and fits every control by its name");
    // Something beside the controls takes width (a running turn's chip): the
    // row as wide as before, their own box narrower, clipping them.
    available = 250;
    await act(async () => { ownObserved(); });
    assert.equal(density(), 2, "clipped by a neighbour: compact until they fit");
    const fitted = reads;
    await act(async () => { ownObserved(); });
    assert.equal(reads, fitted + 1, "their box changing while they fit: one look, no step");
    assert.equal(density(), 2);
  } finally {
    act(() => root.unmount());
    host.remove();
    globals.ResizeObserver = previousObserver;
    if (scroll) Object.defineProperty(proto, "scrollWidth", scroll); else delete proto.scrollWidth;
    if (client) Object.defineProperty(proto, "clientWidth", client); else delete proto.clientWidth;
  }
});
