import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentHealth, ChatProviderKind, NewChatDefaults, NewChatDefaultsUpdate, ProviderModelCatalog, ProviderSettings } from "../../../shared/types";
import { applyNewChatDefaultsUpdate, newChatDefaultsForProvider } from "../../../shared/newChatDefaults";
import { resetMemberModelCatalogs } from "../chat/chat-member-model-name";
import { COMPACT_WITHOUT_ASKING_DESCRIPTION, NewChatDefaultsRows } from "./new-chat-defaults-rows";

assert.ok(
  (globalThis as unknown as { ACCORD_RENDERER_JSDOM?: boolean }).ACCORD_RENDERER_JSDOM,
  "this test needs a DOM installed before its imports — run it via `npm run test:renderer-components`"
);

// Radix Select measures its list in an animation frame.
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (callback: () => void) => setTimeout(callback, 0);
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame ??= (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle);

const PROVIDERS: ProviderSettings[] = [
  { kind: "codex-cli", label: "Codex CLI", enabled: true },
  { kind: "claude-code", label: "Claude Code", enabled: true },
  { kind: "gemini-cli", label: "Antigravity", enabled: true }
];
const AGENTS: AgentHealth[] = PROVIDERS.map((provider) => ({
  kind: provider.kind as ChatProviderKind, label: provider.label, installed: true, detection: "detected", runnable: "ready", authentication: "ready"
}));
const CATALOGS: Record<string, ProviderModelCatalog> = {
  "claude-code": {
    kind: "claude-code", authoritative: true, fetchedAt: "2026-11-22T00:00:00.000Z",
    models: [
      { id: "opus", label: "Opus 5.5", recommended: true, source: "cli",
        supportedReasoningEfforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }, { id: "max", label: "Max" }] },
      { id: "haiku", label: "Haiku 5.5", source: "cli", supportedReasoningEfforts: [{ id: "low", label: "Low" }] }
    ]
  },
  "codex-cli": {
    kind: "codex-cli", authoritative: true, fetchedAt: "2026-11-22T00:00:00.000Z",
    models: [{ id: "gpt-5.5", label: "GPT-5.5 (gpt-5.5)", recommended: true, source: "cli" }],
    startDefaults: { access: "auto-review" }
  }
};

function find(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  assert.ok(element, `${testId} is on screen`);
  return element;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

/** Opens a settings select and picks the option with this text, as the
 *  keyboard does (Radix opens on Enter and selects on Enter). */
async function choose(testId: string, label: string): Promise<void> {
  const trigger = find(testId);
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
  const option = Array.from(document.querySelectorAll<HTMLElement>("[role=option]")).find((item) => item.textContent?.trim() === label);
  assert.ok(option, `"${label}" is offered (${Array.from(document.querySelectorAll("[role=option]")).map((item) => item.textContent?.trim()).join(", ")})`);
  await act(async () => { option.focus(); option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await settle();
}

function optionsOf(testId: string): Promise<string[]> {
  return (async () => {
    const trigger = find(testId);
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await settle();
    const labels = Array.from(document.querySelectorAll<HTMLElement>("[role=option]")).map((item) => item.textContent?.trim() ?? "");
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    return labels;
  })();
}

async function mount(initial: { kind?: ChatProviderKind; defaults?: NewChatDefaults; machines?: Array<{ id: string; name: string }> }) {
  resetMemberModelCatalogs();
  const updates: NewChatDefaultsUpdate[] = [];
  const providerChanges: ChatProviderKind[] = [];
  let kind = initial.kind;
  let defaults: NewChatDefaults = initial.defaults ?? { compactWithoutAsking: true };
  (globalThis as unknown as { window: { consensus: unknown } }).window.consensus = {
    listProviderModels: async (provider: string) => CATALOGS[provider],
    listMachines: async () => ({ machines: initial.machines ?? [], status: [] })
  };
  // A test that failed midway leaves its rows: never read them here.
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  const render = (): void => {
    root.render(
      <TooltipProvider>
        <NewChatDefaultsRows
          providers={PROVIDERS}
          agents={AGENTS}
          assistantProviderKind={kind}
          newChatDefaults={defaults}
          setAssistantProviderKind={async (next) => { providerChanges.push(next); kind = next; defaults = newChatDefaultsForProvider(defaults); render(); }}
          setNewChatDefaults={async (update) => { updates.push(update); defaults = applyNewChatDefaultsUpdate(defaults, update); render(); }}
        />
      </TooltipProvider>
    );
  };
  await act(async () => { render(); });
  await settle();
  return {
    updates,
    providerChanges,
    text: () => host.textContent ?? "",
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); }
  };
}

test("the New chats rows: provider, its CLI's model, effort and modes, where it runs and compaction, in the mockup's words and no main session", async () => {
  const view = await mount({ kind: "claude-code" });
  const text = view.text();
  for (const words of ["Provider", "The CLI a new chat runs on.", "Model", "From Claude Code's own model list.", "Effort", "Mode",
    "Claude Code's modes: Manual, Accept edits, Plan, Auto.", "Runs on", "Compact without asking", COMPACT_WITHOUT_ASKING_DESCRIPTION]) {
    assert.ok(text.includes(words), `shows "${words}"`);
  }
  assert.doesNotMatch(text, /main session|Default view|@main/i);
  assert.equal(find("assistant-provider-select").textContent?.trim(), "Claude Code");
  assert.equal(find("new-chat-model-select").textContent?.trim(), "Opus 5.5", "the model the CLI runs by default, by name");
  assert.equal(find("new-chat-effort-select").textContent?.trim(), "Default");
  assert.equal(find("new-chat-mode-select").textContent?.trim(), "Manual", "Claude Code's built-in mode");
  assert.equal(find("new-chat-runs-on-select").textContent?.trim(), "This computer");
  assert.equal((find("new-chat-compact-toggle") as HTMLInputElement).checked, true, "on by default");
  assert.deepEqual(await optionsOf("new-chat-mode-select"), ["Manual", "Accept edits", "Plan", "Auto"], "exactly Claude Code's own modes");
  assert.deepEqual(await optionsOf("new-chat-model-select"), ["Opus 5.5", "Haiku 5.5"]);
  await view.unmount();
});

test("each change is saved for the CLI it was made for; a model without the chosen effort takes the CLI's own effort", async () => {
  const view = await mount({ kind: "claude-code", machines: [{ id: "m-1", name: "Studio" }] });
  await choose("new-chat-effort-select", "Max");
  await choose("new-chat-mode-select", "Plan");
  await choose("new-chat-model-select", "Haiku 5.5");
  await choose("new-chat-runs-on-select", "Studio");
  await act(async () => { find("new-chat-compact-toggle").click(); });
  await settle();
  assert.deepEqual(view.updates, [
    { kind: "claude-code", reasoningEffort: "max" },
    { kind: "claude-code", access: "plan" },
    { kind: "claude-code", model: "haiku", reasoningEffort: null },
    { homeMachineId: "m-1" },
    { compactWithoutAsking: false }
  ]);
  assert.equal(find("new-chat-model-select").textContent?.trim(), "Haiku 5.5");
  assert.equal(find("new-chat-effort-select").textContent?.trim(), "Default");
  assert.equal(find("new-chat-mode-select").textContent?.trim(), "Plan");
  assert.equal(find("new-chat-runs-on-select").textContent?.trim(), "Studio");
  assert.equal((find("new-chat-compact-toggle") as HTMLInputElement).checked, false);

  // Another provider: its own model, effort and mode, its own words.
  await choose("assistant-provider-select", "Codex");
  assert.deepEqual(view.providerChanges, ["codex-cli"]);
  assert.equal(find("new-chat-model-select").textContent?.trim(), "GPT-5.5");
  assert.equal(find("new-chat-mode-select").textContent?.trim(), "Ask for approval",
    "Codex's built-in mode: it runs on Studio, whose own config said nothing (this computer's starts in Approve for me)");
  assert.match(view.text(), /From Codex's own model list\./);
  assert.match(view.text(), /Codex's modes: Ask for approval, Approve for me, Full Access\./);
  assert.equal(find("new-chat-runs-on-select").textContent?.trim(), "Studio", "where it runs stays");
  await view.unmount();
});

test("Codex's Full Access is asked about first, in Codex's own words; only Yes sets it", async () => {
  const view = await mount({ kind: "codex-cli" });
  await choose("new-chat-mode-select", "Full Access");
  const dialog = find("new-chat-full-access-confirm");
  assert.match(dialog.textContent ?? "", /Enable full access\?/);
  await act(async () => { find("new-chat-full-access-cancel").click(); });
  await settle();
  assert.deepEqual(view.updates, [], "Cancel sets nothing");
  assert.equal(find("new-chat-mode-select").textContent?.trim(), "Approve for me");

  await choose("new-chat-mode-select", "Full Access");
  await act(async () => { find("new-chat-full-access-yes").click(); });
  await settle();
  assert.deepEqual(view.updates, [{ kind: "codex-cli", access: "full-access" }]);
  assert.equal(find("new-chat-mode-select").textContent?.trim(), "Full Access");
  await view.unmount();
});

test("a machine no longer set up reads as this computer; with no machine, Runs on has nothing to choose", async () => {
  const view = await mount({ kind: "claude-code", defaults: { homeMachineId: "m-gone", compactWithoutAsking: true } });
  assert.equal(find("new-chat-runs-on-select").textContent?.trim(), "This computer");
  assert.equal((find("new-chat-runs-on-select") as HTMLButtonElement).disabled, true);
  await view.unmount();
});
