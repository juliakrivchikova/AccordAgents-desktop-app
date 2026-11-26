// The Accord in the sessions view (the User, 2026-11-20): one line above the
// composer that opens it in the right panel, the whole card there, and a row
// at the top of the members panel. The classic view keeps its pinned card.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { act as reactAct, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ACCORD_NEEDS_AGENT_LINE, ACCORD_NEEDS_AGENT_SETUP_LINE } from "../../../shared/accordCandidates";
import { parseAccordLaunchCard } from "../../../shared/accordLaunchCard";
import { accordProgressFromNotes, type DockedAccord } from "../../../shared/accordProgress";
import type { AppSettings, ChatParticipant, Conversation } from "../../../shared/types";
import { ArtifactsContext, type ArtifactFocus } from "../artifacts/artifacts-context";
import { resetAccordDockStoreForTests } from "./accord-dock-store";
import { ChatAccordDockSlot } from "./chat-accord-dock";
import { ChatMembersPanel } from "./chat-members-panel";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import { resetMemberModelCatalogs } from "./chat-member-model-name";
import { ChatSessionsLinksContext, type ChatSessionsLinks } from "./chat-sessions-links";
import { ChatSessionsRightPanel, type ChatPanelMessageContext } from "./chat-sessions-right-panel";
import { DREW, MAIN, PARTICIPANTS } from "./chat-sessions-fixtures.test";
import type { ChatRightPanel, ChatRightPanelState } from "./use-chat-right-panel";
import { SubagentProvidersContext, type SubagentProvidersActions } from "./subagent-providers-context";
import type { ChatSessionsView } from "./use-chat-sessions-view";

const NOW = "2026-11-20T10:00:00.000Z";
const noop = (): void => undefined;
// What is on screen: words for screen readers only are left out.
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.props?.className === "sr-only" ? "" : node.children.map(textOf).join("");
const hasClass = (name: string) => (node: ReactTestInstance): boolean =>
  typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(name);
const byTestId = (id: string) => (node: ReactTestInstance): boolean => typeof node.type === "string" && node.props["data-testid"] === id;

function accord(): DockedAccord {
  const ref = "[Ship or wait](#artifact:art-1)";
  const card = parseAccordLaunchCard([
    "@main /accord", "", "Subject:", "Ship or wait?", "", "Selected accord members: drew.",
    "Run the accord skill for exactly those selected members and this subject. Use app_chat_request_participants for those members only. The app has enabled request-members permission for you in this chat; the user can revoke it from your member controls."
  ].join("\n"))!;
  const progress = accordProgressFromNotes("launch-1", card, [
    `@main created draft collection ${ref} · Drafts 0/2`,
    `@main submitted a draft to ${ref} · Submitted`,
    `@drew submitted a draft to ${ref} · Submitted`,
    `@main published ${ref} · v1 — Wait for the fix, then ship on Monday.`,
    `@main signed ${ref} v1 (1/2 signed)`
  ].map((content) => ({ content, accordLaunchMessageId: "launch-1" })))!;
  return { launchId: "launch-1", card, progress };
}

function renderIn(
  sessions: boolean,
  element: ReactElement,
  extra: { links?: ChatSessionsLinks; openArtifact?: (artifactId: string, focus?: ArtifactFocus) => void } = {}
): { root: ReactTestInstance; update: (next: ReactElement) => void; unmount: () => void } {
  let renderer: ReturnType<typeof create> | undefined;
  const wrap = (inner: ReactElement): ReactElement => (
    <TooltipProvider>
      <ArtifactsContext.Provider value={{ byId: new Map(), openArtifact: extra.openArtifact ?? noop }}>
        <ChatSessionsLinksContext.Provider value={extra.links}>
          <ChatSessionsPresentationContext.Provider value={sessions}>{inner}</ChatSessionsPresentationContext.Provider>
        </ChatSessionsLinksContext.Provider>
      </ArtifactsContext.Provider>
    </TooltipProvider>
  );
  act(() => {
    renderer = create(wrap(element));
  });
  return { root: renderer!.root, update: (next) => act(() => renderer!.update(wrap(next))), unmount: () => act(() => renderer!.unmount()) };
}

test("above the composer the sessions view keeps one line, Accord · name · where it stands, that opens the Accord in the right panel", async (t) => {
  resetAccordDockStoreForTests();
  const closes: unknown[] = [];
  const page = window as unknown as { consensus?: unknown };
  const bridge = page.consensus;
  page.consensus = { closeAccordCard: async (request: unknown) => { closes.push(request); } };
  t.after(() => {
    page.consensus = bridge;
    resetAccordDockStoreForTests();
  });
  const opened: string[] = [];
  const docked = accord();
  const strip = renderIn(true, <ChatAccordDockSlot docked={docked} conversationId="chat-1" participants={PARTICIPANTS} onOpenInPanel={(id) => opened.push(id)} />);
  assert.equal(strip.root.findAll(byTestId("chat-accord-strip")).length, 1);
  assert.equal(strip.root.findAll(hasClass("chat-accord-dock")).length, 0, "not the pinned card");
  assert.equal(strip.root.findAll(hasClass("chat-accord-progress-stage")).length, 0, "no stages above the composer");
  const line = strip.root.find(byTestId("chat-accord-strip-open"));
  assert.deepEqual(
    [textOf(line.find(hasClass("chat-accord-row-kind"))), textOf(line.find(hasClass("chat-accord-row-title"))), textOf(line.find(hasClass("chat-accord-row-status")))],
    ["Accord", "Ship or wait", "v1 · 1/2 signed"]
  );
  act(() => line.props.onClick());
  assert.deepEqual(opened, ["launch-1"]);
  // Its cross closes the Accord into a line in the chat, as the pinned card's does.
  await act(async () => { strip.root.find((node) => node.props?.label === "Close" && typeof node.props.onClick === "function").props.onClick(); });
  assert.deepEqual(closes, [{ conversationId: "chat-1", launchMessageId: "launch-1", title: "Ship or wait" }]);
  strip.unmount();

  resetAccordDockStoreForTests();
  const classic = renderIn(false, <ChatAccordDockSlot docked={docked} conversationId="chat-1" participants={PARTICIPANTS} />);
  assert.equal(classic.root.findAll(byTestId("chat-accord-strip")).length, 0);
  assert.equal(classic.root.findAll(hasClass("chat-accord-progress-stage")).length, 4, "the classic view keeps the pinned card");
  assert.equal(classic.root.findAll(hasClass("chat-accord-progress-avatar")).length, 4, "with its member avatars (drafts and signatures)");
  classic.unmount();
});

function rightPanel(panel: ChatRightPanel, calls: string[]): ChatRightPanelState {
  return {
    panel, memberDrafts: {}, selectThread: noop, setMemberDraft: noop, reset: noop,
    openMembers: () => calls.push("members"), openAgentsToAdd: () => calls.push("add-agent"), openMember: (id) => calls.push(`member:${id}`),
    openAccord: (id) => calls.push(`accord:${id}`), close: () => calls.push("close")
  };
}

function rightPanelElement(panel: ChatRightPanel, calls: string[], latest?: DockedAccord,
  chat: { conversation?: Conversation; participants?: ChatParticipant[]; accordNeedsAgent?: boolean } = {}): ReactElement {
  const settings = { chatRoleConfigs: [] } as unknown as AppSettings;
  return (
    <ChatSessionsRightPanel
      rightPanel={rightPanel(panel, calls)}
      sessions={{ memberRows: { current: [], previous: [] } } as unknown as ChatSessionsView}
      latestAccord={latest}
      onOpenAccord={(id) => calls.push(`open-accord:${id}`)}
      accordNeedsAgent={chat.accordNeedsAgent}
      conversation={chat.conversation ?? { id: "chat-1", messages: [] } as unknown as Conversation}
      participants={chat.participants ?? PARTICIPANTS}
      participantStatusById={new Map()}
      runIdsByParticipantId={new Map()}
      messageContext={{ settings } as unknown as ChatPanelMessageContext}
      hasOlderMessages={false}
      olderMessagesLoading={false}
      onLoadOlderMessages={noop}
      onSendToMember={async () => false}
    />
  );
}

test("the Accord in the right panel is the whole card, members by provider logo; Back goes to the members, the cross closes the panel", () => {
  const calls: string[] = [];
  const latest = accord();
  const panel = renderIn(true, rightPanelElement({ kind: "accord", launchId: "launch-1" }, calls, latest));
  const section = panel.root.find(byTestId("chat-accord-panel"));
  assert.equal(section.props["data-launch-id"], "launch-1");
  assert.deepEqual(panel.root.findAll(hasClass("chat-accord-progress-label")).map(textOf), ["Drafts", "v1 published", "Signatures", "Accord reached"]);
  assert.equal(panel.root.findAll((node) => node.type === "button" && hasClass("chat-accord-dock-toggle")(node)).length, 0, "nothing to fold in the panel");
  assert.equal(panel.root.findAll(hasClass("chat-accord-progress-avatar")).length, 0, "no avatar pictures");
  assert.deepEqual(
    panel.root.findAll(hasClass("chat-accord-progress-member")).map((chip) => [textOf(chip), chip.findAll(hasClass("chat-provider-icon"))[0]?.props["data-provider-kind"]]),
    [["@main", MAIN.kind], ["@drew", DREW.kind], ["@main", MAIN.kind], ["@drew", DREW.kind]],
    "drafts and signatures: each member by its provider's logo"
  );
  act(() => panel.root.find(byTestId("chat-accord-panel-back")).props.onClick({ defaultPrevented: false, preventDefault: noop }));
  act(() => panel.root.find((node) => node.props?.label === "Close Accord" && typeof node.props.onClick === "function").props.onClick());
  assert.deepEqual(calls, ["members", "close"]);
  panel.unmount();

  const missing = renderIn(true, rightPanelElement({ kind: "accord", launchId: "launch-old" }, calls, latest));
  assert.match(textOf(missing.root.find(byTestId("chat-accord-panel"))), /not loaded yet/, "an Accord whose notes are not loaded says so");
  missing.unmount();
});

test("the members panel lists the chat's latest Accord first, as a row that opens it", () => {
  const opened: string[] = [];
  const latest = accord();
  const panel = renderIn(true, (
    <ChatMembersPanel
      accord={latest}
      onOpenAccord={(id) => opened.push(id)}
      rows={{ current: [], previous: [] }}
      activity={{ runningSince: new Map(), finishedAt: new Map() }}
      runIdsByParticipantId={new Map()}
      memberTitle={() => ""}
      onOpenMember={noop}
      onClose={noop}
    />
  ));
  const body = panel.root.find(hasClass("chat-members-body"));
  const first = body.findAll((node) => node.type === "button")[0];
  assert.equal(first?.props["data-testid"], "chat-members-accord", "the Accord comes first");
  assert.match(textOf(first!), /AccordShip or waitv1 · 1\/2 signed/);
  act(() => first!.props.onClick());
  assert.deepEqual(opened, ["launch-1"]);
  panel.unmount();

  const none = renderIn(true, (
    <ChatMembersPanel rows={{ current: [], previous: [] }} activity={{ runningSince: new Map(), finishedAt: new Map() }} runIdsByParticipantId={new Map()} memberTitle={() => ""} onOpenMember={noop} onClose={noop} />
  ));
  assert.equal(none.root.findAll(byTestId("chat-members-accord")).length, 0, "no Accord, no row");
  none.unmount();
});

/** Detection as the app reports it: these CLIs ready, the others not installed. */
function agentsReady(ready: string[]): SubagentProvidersActions["agents"] {
  return ["codex-cli", "claude-code", "gemini-cli"].map((kind) => (ready.includes(kind)
    ? { kind, label: kind, installed: true, detection: "detected", runnable: "ready", authentication: "ready" }
    : { kind, label: kind, installed: false, detection: "not-detected" })) as unknown as SubagentProvidersActions["agents"];
}

test("opened from the Accord button with too few for an Accord, the side panel says what Accord needs and brings back a CLI this chat took out", async () => {
  const updates: unknown[] = [];
  const opened: string[] = [];
  const actions = (ready: string[]): SubagentProvidersActions => ({
    agents: agentsReady(ready), providers: [], hosts: [], openSetup: () => opened.push("setup"),
    update: async (change) => { updates.push(change); return true; }
  });
  const chat = (entries: unknown[]): Conversation =>
    ({ id: "chat-1", messages: [], metadata: { participants: [MAIN], mainSessionParticipantId: MAIN.id, subagentProviders: { entries } } }) as unknown as Conversation;
  const element = (accordNeedsAgent: boolean, conversation: Conversation, ready = ["codex-cli", "gemini-cli"]): ReactElement => (
    <TooltipProvider>
      <ChatSessionsPresentationContext.Provider value>
        <SubagentProvidersContext.Provider value={actions(ready)}>
          {rightPanelElement({ kind: "members", addAgent: 1 }, [], undefined, { conversation, participants: [MAIN], accordNeedsAgent })}
        </SubagentProvidersContext.Provider>
      </ChatSessionsPresentationContext.Provider>
    </TooltipProvider>
  );
  // In a document: Add opens its list in a popover, which react-test-renderer cannot draw.
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const byId = (id: string): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
  const render = async (next: ReactElement): Promise<void> => {
    await reactAct(async () => { root.render(next); await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await render(element(true, chat([{ kind: "codex-cli", removed: true }, { kind: "gemini-cli", removed: true }])));
    assert.equal(byId("chat-subagents-note")[0]?.textContent, ACCORD_NEEDS_AGENT_LINE, "Add is open with what Accord needs");
    const codex = document.querySelector<HTMLElement>('[data-testid="chat-subagent-pick"] [data-provider-kind="codex-cli"] [data-testid="chat-subagent-pick-add"]');
    assert.ok(codex, "the CLIs this chat took out are offered back");
    await reactAct(async () => { codex.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(updates, [{ type: "add", kind: "codex-cli" }], "back in this chat, nothing else changed");
    await render(element(false, chat([{ kind: "gemini-cli", removed: true }])));
    assert.equal(byId("chat-subagent-add")[0]?.getAttribute("data-state"), "closed", "the request was answered: Add does not open again");
    await render(element(false, chat([])));
    assert.equal(byId("chat-subagent-add").length, 0, "nothing taken out: no Add");
    assert.equal(byId("chat-subagents-note").length, 0, "once Accord has enough, the line is gone");

    // Nothing this chat can have back: another CLI has to be set up first.
    await render(element(true, chat([]), ["codex-cli"]));
    assert.equal(byId("chat-subagent-add").length, 0);
    assert.equal(byId("chat-subagents-note")[0]?.textContent, ACCORD_NEEDS_AGENT_SETUP_LINE);
    await reactAct(async () => { byId("chat-subagents-setup")[0]!.click(); });
    assert.deepEqual(opened, ["setup"]);
  } finally {
    await reactAct(async () => { root.unmount(); });
    container.remove();
  }
});

test("in the sessions view the card names members by model and effort; a submitted draft and the published version open in the document", async (t) => {
  resetAccordDockStoreForTests();
  resetMemberModelCatalogs();
  const page = window as unknown as { consensus?: unknown };
  const bridge = page.consensus;
  const catalog = (kind: string, models: unknown[]) => ({ kind, models, authoritative: true, fetchedAt: NOW });
  page.consensus = {
    listMachines: async () => ({ machines: [], status: [] }),
    listProviderModels: async (kind: string) => kind === "claude-code"
      ? catalog(kind, [{ id: "claude-opus-5-5", label: "Opus 5.5" }])
      : catalog(kind, [{ id: "gpt-5.5", label: "GPT-5.5 (gpt-5.5)", supportedReasoningEfforts: [{ id: "high", label: "High" }] }])
  };
  t.after(() => {
    page.consensus = bridge;
    resetMemberModelCatalogs();
    resetAccordDockStoreForTests();
  });
  const participants = [{ ...MAIN, model: "claude-opus-5-5", reasoningEffort: "xhigh" }, { ...DREW, model: "gpt-5.5", reasoningEffort: "high" }] as typeof PARTICIPANTS;
  const links: ChatSessionsLinks = {
    mainSessionId: MAIN.id,
    mainHandle: "main",
    byHandle: new Map([["drew", { id: DREW.id, title: "Fix the login page", kind: DREW.kind }]]),
    openMember: noop
  };
  const opened: Array<[string, ArtifactFocus | undefined]> = [];
  const latest = accord();
  const card = renderIn(true, rightPanelElement({ kind: "accord", launchId: "launch-1" }, [], latest, { participants }), {
    links, openArtifact: (artifactId, focus) => opened.push([artifactId, focus])
  });
  // The model lists come a moment later.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const chips = card.root.findAll(hasClass("chat-accord-progress-member"));
  assert.deepEqual(chips.map(textOf), ["Opus 5.5 Extra High", "GPT-5.5 High", "Opus 5.5 Extra High", "GPT-5.5 High"]);
  assert.equal(textOf(card.root.find(hasClass("chat-accord-dock-meta"))), "Accord · with GPT-5.5 High", "the head names the members the same way, the main session by nothing");

  // Drafts open; signatures do not.
  assert.deepEqual(chips.map((chip) => chip.type), ["button", "button", "span", "span"]);
  act(() => chips[1]!.props.onClick());
  act(() => card.root.find((node) => node.type === "button" && hasClass("chat-accord-progress-label")(node)).props.onClick());
  assert.deepEqual(opened, [["art-1", { draftAuthor: "drew" }], ["art-1", { version: 1 }]]);
  card.unmount();

  // A former member is named by its task's title.
  const former = renderIn(true, rightPanelElement({ kind: "accord", launchId: "launch-1" }, [], latest, { participants: [participants[0]!] }), { links });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(former.root.findAll(hasClass("chat-accord-progress-member")).map(textOf).slice(0, 2), ["Opus 5.5 Extra High", "Fix the login page"]);
  former.unmount();
});
