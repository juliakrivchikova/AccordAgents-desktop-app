import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatViewMode, ChatViewState, Conversation, SetChatViewRequest } from "../../../shared/types";
import {
  CHAT_VIEW_SWITCH_DISABLED_REASON,
  ChatViewHeaderContext,
  ChatViewHeaderControls,
  type ChatViewHeaderState
} from "./chat-view-switch";
import { useChatViewMode, type ChatViewModeState } from "./use-chat-view-mode";
import { sessionsConversation } from "./chat-sessions-fixtures.test";

const noop = (): void => undefined;
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const byTestId = (id: string) => (node: ReactTestInstance): boolean => typeof node.type === "string" && node.props["data-testid"] === id;

function renderHeader(state: ChatViewHeaderState | undefined): ReturnType<typeof create> {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatViewHeaderContext.Provider value={state}>
          <ChatViewHeaderControls />
        </ChatViewHeaderContext.Provider>
      </TooltipProvider>
    );
  });
  return renderer!;
}

test("an old chat's switch is disabled and says why; there is no members button", () => {
  const renderer = renderHeader({ view: "classic", canSwitch: false, onChangeView: noop });
  const root = renderer.root;
  const group = root.find(byTestId("chat-view-switch"));
  assert.equal(group.props["data-chat-view"], "classic");
  assert.equal(group.props["data-disabled-reason"], CHAT_VIEW_SWITCH_DISABLED_REASON);
  const buttons = group.findAll((node) => node.type === "button");
  assert.deepEqual(buttons.map((button) => [button.props["data-view"], button.props.disabled, button.props["aria-pressed"]]),
    [["sessions", true, false], ["classic", true, true]]);
  assert.equal(root.findAll(byTestId("chat-members-button")).length, 0);
  act(() => renderer.unmount());
});

test("outside a chat view the header shows no view controls", () => {
  const renderer = renderHeader(undefined);
  assert.equal(renderer.toJSON(), null);
  act(() => renderer.unmount());
});

test("a main-session chat switches its view from the header and, in the sessions view, opens its members", () => {
  const changes: ChatViewMode[] = [];
  let toggles = 0;
  const renderer = renderHeader({
    view: "sessions",
    canSwitch: true,
    onChangeView: (view) => changes.push(view),
    members: { runningCount: 2, open: false, onToggle: () => { toggles += 1; } }
  });
  const root = renderer.root;
  const group = root.find(byTestId("chat-view-switch"));
  assert.equal(group.props["data-disabled-reason"], undefined);
  act(() => root.find(byTestId("chat-view-switch-classic")).props.onClick());
  assert.deepEqual(changes, ["classic"]);
  const members = root.find(byTestId("chat-members-button"));
  assert.equal(textOf(members), "Members (2 running)");
  act(() => members.props.onClick());
  assert.equal(toggles, 1);
  act(() => renderer.unmount());
});

function viewModeHarness(conversation: Conversation, calls: SetChatViewRequest[], answer: (request: SetChatViewRequest) => Promise<ChatViewState | undefined>) {
  (window as unknown as { consensus: unknown }).consensus = {
    setChatView: (request: SetChatViewRequest) => { calls.push(request); return answer(request); }
  };
  let state: ChatViewModeState | undefined;
  const saved: ChatViewState[] = [];
  const errors: string[] = [];
  function Harness(props: { conversation: Conversation }): null {
    state = useChatViewMode({ conversation: props.conversation, onSaved: (value) => saved.push(value), onError: (message) => errors.push(message) });
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  act(() => { renderer = create(<Harness conversation={conversation} />); });
  return { state: () => state!, saved, errors, renderer: renderer!, Harness };
}

test("the switch shows the picked view at once and goes back to the saved one when her server refuses it", async () => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  const calls: SetChatViewRequest[] = [];
  let reject!: (error: Error) => void;
  const harness = viewModeHarness(sessionsConversation(), calls, () => new Promise((_resolve, no) => { reject = no; }));
  assert.equal(harness.state().view, "sessions", "a new chat opens in the sessions view");
  act(() => harness.state().setView("classic"));
  assert.equal(harness.state().view, "classic", "optimistic");
  assert.deepEqual(calls, [{ conversationId: "chat-sessions", view: "classic" }]);
  await act(async () => { reject(new Error("Error invoking remote method 'chat:set-view': Error: This chat has one view only.")); });
  assert.equal(harness.state().view, "sessions", "reverted");
  assert.deepEqual(harness.errors, ["Could not switch the view: This chat has one view only."]);
  act(() => harness.renderer.unmount());
});

test("a saved switch is handed to the open chat; an old chat never asks", async () => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  const calls: SetChatViewRequest[] = [];
  const harness = viewModeHarness(sessionsConversation(), calls, async (request) => request);
  await act(async () => { harness.state().setView("classic"); });
  assert.deepEqual(harness.saved, [{ conversationId: "chat-sessions", view: "classic" }]);
  act(() => harness.renderer.update(<harness.Harness conversation={sessionsConversation({ chatView: "classic" })} />));
  assert.equal(harness.state().view, "classic");
  act(() => harness.renderer.unmount());

  const oldCalls: SetChatViewRequest[] = [];
  const old = viewModeHarness(sessionsConversation({ mainSessionParticipantId: undefined }), oldCalls, async (request) => request);
  assert.equal(old.state().canSwitch, false);
  assert.equal(old.state().view, "classic");
  act(() => old.state().setView("sessions"));
  assert.equal(old.state().view, "classic");
  assert.deepEqual(oldCalls, []);
  act(() => old.renderer.unmount());
});
