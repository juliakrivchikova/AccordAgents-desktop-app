// The compaction card the User approved on 2026-11-22: its words, its meter,
// its answers,
// who it names in each view, and its folded line once answered.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatAppToolApproval, ChatAppToolApprovalScope } from "../../../shared/types";
import { ChatAppToolApprovalCard } from "./chat-app-tool-approval-card";
import { ChatSessionsPresentationContext } from "./chat-member-mark";
import { ChatSessionsLinksContext, ChatSessionsNamesContext, sessionsViewNamesFromLinks, type ChatSessionsLinks } from "./chat-sessions-links";
import { DREW, MAIN, PARTICIPANTS } from "./chat-sessions-fixtures.test";

const AT = "2026-11-22T08:59:00.000Z";
const SENTENCE = "After this reply the older part of the conversation is replaced by a short summary, and work continues from it.";

const LINKS: ChatSessionsLinks = {
  mainSessionId: MAIN.id,
  mainHandle: "main",
  byHandle: new Map([["drew", { id: DREW.id, title: "Fix the logout", kind: DREW.kind }]]),
  openMember: () => undefined
};

function approval(patch: Partial<ChatAppToolApproval> = {}, request: Record<string, unknown> = {}): ChatAppToolApproval {
  return {
    id: "approval-compact",
    conversationId: "chat-1",
    requesterParticipantId: DREW.id,
    requesterHandle: DREW.handle,
    requesterRoleConfigId: DREW.roleConfigId,
    toolName: "app_chat_request_compaction",
    capability: "compaction.request",
    status: "pending",
    request: { type: "self_compaction", instructions: "beta.3 status, your rules, open defects", contextPercentage: 82, ...request } as never,
    summary: `Compact @${DREW.handle} context`,
    createdAt: AT,
    updatedAt: AT,
    ...patch
  };
}

type Answer = [string, boolean, ChatAppToolApprovalScope | undefined];

function render(item: ChatAppToolApproval, sessions = false): { root: ReactTestInstance; answers: Answer[]; renderer: ReactTestRenderer } {
  const answers: Answer[] = [];
  let renderer: ReactTestRenderer | undefined;
  const element: ReactElement = (
    <TooltipProvider>
      <ChatSessionsPresentationContext.Provider value={sessions}>
        <ChatSessionsLinksContext.Provider value={sessions ? LINKS : undefined}>
          <ChatSessionsNamesContext.Provider value={sessions ? sessionsViewNamesFromLinks(LINKS) : undefined}>
            <ChatAppToolApprovalCard approval={item} participants={PARTICIPANTS} savedParticipants={[]} roles={[]} submitting={false}
              onRespond={async (id, approve, scope) => { answers.push([id, approve, scope]); }} />
          </ChatSessionsNamesContext.Provider>
        </ChatSessionsLinksContext.Provider>
      </ChatSessionsPresentationContext.Provider>
    </TooltipProvider>
  );
  act(() => { renderer = create(element); });
  return { root: renderer!.root, answers, renderer: renderer! };
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}

function byClass(root: ReactTestInstance, className: string): ReactTestInstance[] {
  return root.findAll((node) => typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(className) && typeof node.type === "string");
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => node.type === "button" && text(node).trim() === label);
  assert.equal(found.length, 1, `one ${label} button`);
  return found[0];
}

test("the card says what the User approved, with the meter and what the summary keeps", () => {
  const { root, renderer } = render(approval());
  const shown = text(root);
  assert.equal(text(byClass(root, "chat-compaction-card-title")[0]), "Compact the conversation?");
  assert.equal(text(byClass(root, "chat-compaction-card-desc")[0]), SENTENCE);
  assert.equal(text(byClass(root, "chat-compaction-card-meter-label")[0]), "82% of context used");
  assert.equal(byClass(root, "chat-compaction-card-bar")[0].props["aria-valuenow"], 82);
  assert.equal(text(byClass(root, "chat-compaction-card-keeps")[0]), "Summary keeps: beta.3 status, your rules, open defects");
  assert.match(shown, /Don't ask again in this chat/);
  button(root, "Not now");
  button(root, "Compact");
  // The old card's words are gone.
  assert.doesNotMatch(shown, /provider session|allow it|Yes, allow once|tell .* what to do differently|Skip|Submit/);
  act(() => renderer.unmount());
});

test("no figure, no meter; no instructions, no keeps line", () => {
  const { root, renderer } = render(approval({}, { contextPercentage: undefined, instructions: undefined }));
  assert.equal(byClass(root, "chat-compaction-card-meter").length, 0);
  assert.equal(byClass(root, "chat-compaction-card-keeps").length, 0);
  act(() => renderer.unmount());
});

test("Compact allows once, Compact with the box allows for this chat, Not now declines, Enter compacts", () => {
  const once = render(approval());
  act(() => { button(once.root, "Compact").props.onClick(); });
  assert.deepEqual(once.answers, [["approval-compact", true, "once"]]);
  act(() => once.renderer.unmount());

  const always = render(approval({ id: "approval-always" }));
  const box = always.root.find((node) => node.type === "input" && node.props.type === "checkbox");
  act(() => { box.props.onChange({ target: { checked: true } }); });
  act(() => always.renderer.unmount());
  // Drawn again (the timeline topping up, the view switching): still ticked.
  const redrawn = render(approval({ id: "approval-always" }));
  assert.equal(redrawn.root.find((node) => node.type === "input" && node.props.type === "checkbox").props.checked, true);
  act(() => { button(redrawn.root, "Compact").props.onClick(); });
  assert.deepEqual(redrawn.answers, [["approval-always", true, "chat"]]);
  act(() => redrawn.renderer.unmount());

  const notNow = render(approval({ id: "approval-not-now" }));
  act(() => { button(notNow.root, "Not now").props.onClick(); });
  assert.deepEqual(notNow.answers, [["approval-not-now", false, undefined]]);
  act(() => notNow.renderer.unmount());

  const enter = render(approval());
  const section = byClass(enter.root, "chat-compaction-card")[0];
  const card = (ring: boolean) => ({ matches: () => ring });
  const key = (patch: Record<string, unknown>, current = card(true)) =>
    act(() => { section.props.onKeyDown({ key: "Enter", currentTarget: current, target: current, preventDefault: () => undefined, ...patch }); });
  // Enter on a control is that control's (Not now, the box); Shift+Enter,
  // a held key, and a card focused by a click on its text (no ring) are not Compact.
  key({ target: { closest: () => ({}) } });
  key({ shiftKey: true });
  key({ repeat: true });
  const clicked = card(false);
  key({}, clicked);
  assert.deepEqual(enter.answers, []);
  // Focused by a click on its text: Chromium reports the ring once a key is
  // pressed, so the click itself is what keeps Enter from compacting.
  act(() => { section.props.onPointerDown(); });
  key({});
  assert.deepEqual(enter.answers, []);
  act(() => { section.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
  key({});
  assert.deepEqual(enter.answers, [["approval-compact", true, "once"]]);
  act(() => enter.renderer.unmount());
});

test("who asks: avatar and name in the classic view, the task's title in the sessions view, nothing for the main session", () => {
  const classic = render(approval());
  assert.equal(text(byClass(classic.root, "chat-compaction-card-who")[0]).trim(), "@drew");
  act(() => classic.renderer.unmount());

  const member = render(approval(), true);
  assert.equal(text(byClass(member.root, "chat-compaction-card-who")[0]).trim(), "Fix the logout");
  assert.doesNotMatch(text(member.root), /@drew|@main/);
  act(() => member.renderer.unmount());

  const main = render(approval({ requesterParticipantId: MAIN.id, requesterHandle: MAIN.handle, summary: "Compact @main context" }), true);
  assert.equal(byClass(main.root, "chat-compaction-card-who").length, 0);
  assert.doesNotMatch(text(main.root), /@main/);
  act(() => main.renderer.unmount());
});

test("answered, the card folds to one line that says how it ended", () => {
  const cases: Array<[Partial<ChatAppToolApproval>, RegExp]> = [
    [{ status: "approved", approvalScope: "once" }, /Compact the conversation.*@drew · Compact \d/],
    [{ status: "approved", approvalScope: "chat" }, /@drew · Compact · Don't ask again in this chat/],
    [{ status: "denied" }, /@drew · Not now/],
    [{ status: "denied", error: "Context compaction is already queued or running for @drew." }, /@drew · Not compacted/]
  ];
  for (const [patch, expected] of cases) {
    const { root, renderer } = render(approval(patch));
    assert.equal(byClass(root, "chat-compaction-card").length, 0, "no live card once answered");
    assert.equal(byClass(root, "chat-used-approval").length, 1);
    assert.match(text(root), expected);
    act(() => renderer.unmount());
  }
});
