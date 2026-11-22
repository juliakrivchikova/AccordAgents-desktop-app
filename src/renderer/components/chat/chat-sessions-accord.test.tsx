// The Accord in the sessions view (the User, 2026-11-20): one line above the
// composer that opens it in the right panel, the whole card there, and a row
// at the top of the members panel. The classic view keeps its pinned card.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { parseAccordLaunchCard } from "../../../shared/accordLaunchCard";
import { accordProgressFromNotes, type DockedAccord } from "../../../shared/accordProgress";
import type { AppSettings, Conversation } from "../../../shared/types";
import { ArtifactsContext } from "../artifacts/artifacts-context";
import { resetAccordDockStoreForTests } from "./accord-dock-store";
import { ChatAccordDockSlot } from "./chat-accord-dock";
import { ChatMembersPanel } from "./chat-members-panel";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import { ChatSessionsRightPanel, type ChatPanelMessageContext } from "./chat-sessions-right-panel";
import { DREW, MAIN, PARTICIPANTS } from "./chat-sessions-fixtures.test";
import type { ChatRightPanel, ChatRightPanelState } from "./use-chat-right-panel";
import type { ChatSessionsView } from "./use-chat-sessions-view";

const NOW = "2026-11-20T10:00:00.000Z";
const noop = (): void => undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
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

function renderIn(sessions: boolean, element: ReactElement): { root: ReactTestInstance; unmount: () => void } {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ArtifactsContext.Provider value={{ byId: new Map(), openArtifact: noop }}>
          <ChatSessionsPresentationContext.Provider value={sessions}>{element}</ChatSessionsPresentationContext.Provider>
        </ArtifactsContext.Provider>
      </TooltipProvider>
    );
  });
  return { root: renderer!.root, unmount: () => act(() => renderer!.unmount()) };
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
    openMembers: () => calls.push("members"), openMember: (id) => calls.push(`member:${id}`),
    openAccord: (id) => calls.push(`accord:${id}`), close: () => calls.push("close")
  };
}

function rightPanelElement(panel: ChatRightPanel, calls: string[], latest?: DockedAccord): ReactElement {
  const settings = { chatRoleConfigs: [] } as unknown as AppSettings;
  return (
    <ChatSessionsRightPanel
      rightPanel={rightPanel(panel, calls)}
      sessions={{ memberRows: { current: [], previous: [] } } as unknown as ChatSessionsView}
      latestAccord={latest}
      onOpenAccord={(id) => calls.push(`open-accord:${id}`)}
      conversation={{ id: "chat-1", messages: [] } as unknown as Conversation}
      participants={PARTICIPANTS}
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
