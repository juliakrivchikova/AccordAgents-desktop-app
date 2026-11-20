// The sessions view has no avatar pictures: a member's only mark there is its
// provider's logo tile (the User, 2026-11-20). The classic view keeps every
// avatar.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatAppToolApproval } from "../../../shared/types";
import { avatarForParticipant } from "../avatar/avatar";
import { ChatAccordLaunchCard } from "./chat-accord-launch-card";
import { ChatAppToolApprovalCard } from "./chat-app-tool-approval-card";
import { ChatMemberMark, ChatSessionsPresentationContext, renderComposerMemberMark } from "./chat-member-mark";
import { DREW, MAIN, PARTICIPANTS, TAYLOR } from "./chat-sessions-fixtures.test";

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const hasClass = (name: string) => (node: ReactTestInstance): boolean =>
  typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(/\s+/).includes(name);
const providerKinds = (root: ReactTestInstance): string[] =>
  root.findAll((node) => typeof node.type === "string" && node.props["data-provider-kind"] !== undefined).map((node) => node.props["data-provider-kind"]);
const avatars = (root: ReactTestInstance): number =>
  root.findAll((node) => typeof node.type === "string" && typeof node.props.className === "string" && /avatar(?!-slot)/.test(node.props.className)).length;

function renderIn(sessions: boolean, element: ReactElement): { root: ReactTestInstance; unmount: () => void } {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(
      <TooltipProvider>
        <ChatSessionsPresentationContext.Provider value={sessions}>{element}</ChatSessionsPresentationContext.Provider>
      </TooltipProvider>
    );
  });
  return { root: renderer!.root, unmount: () => act(() => renderer!.unmount()) };
}

test("a member's mark: its avatar in the classic view; its provider's logo tile in the sessions view, nothing for a member no longer known", () => {
  const avatar = avatarForParticipant("@drew", DREW.id);
  const classic = renderIn(false, <ChatMemberMark className="mini-avatar" avatar={avatar} member={DREW} />);
  assert.equal(classic.root.findAll(hasClass("mini-avatar")).length, 1);
  assert.deepEqual(providerKinds(classic.root), []);
  classic.unmount();

  const sessions = renderIn(true, <ChatMemberMark className="mini-avatar" markClassName="is-mini" avatar={avatar} member={DREW} />);
  assert.equal(sessions.root.findAll(hasClass("mini-avatar")).length, 0, "no avatar picture");
  const mark = sessions.root.find(hasClass("chat-provider-icon"));
  assert.equal(mark.props["data-provider-kind"], "codex-cli");
  assert.equal(mark.props["aria-label"], "Codex CLI");
  assert.ok(mark.props.className.split(" ").includes("is-mini"));
  sessions.unmount();

  const gone = renderIn(true, <ChatMemberMark className="mini-avatar" avatar={avatar} />);
  assert.equal(gone.root.findAll(hasClass("mini-avatar")).length + providerKinds(gone.root).length, 0, "a removed member has no mark");
  gone.unmount();

  // The composer's @ list and running members use the same mark.
  const composer = renderIn(true, renderComposerMemberMark(TAYLOR));
  assert.deepEqual(providerKinds(composer.root), ["gemini-cli"]);
  assert.equal(avatars(composer.root), 0);
  composer.unmount();
});

test("an Accord's launch card names its members by handle with the provider's logo in the sessions view; avatars stay in the classic view", () => {
  const card = { facilitator: "main", members: ["drew", "gone"], subject: "Ship on Monday?" };
  const sessions = renderIn(true, <ChatAccordLaunchCard card={card} participants={PARTICIPANTS} />);
  assert.equal(sessions.root.findAll(hasClass("chat-accord-launch-avatar")).length, 0, "no avatar pictures");
  assert.deepEqual(providerKinds(sessions.root), [MAIN.kind, DREW.kind], "led by @main (Claude), with @drew (Codex); @gone has no mark");
  assert.match(textOf(sessions.root), /Accordled by @mainwith @drew, @gone/);
  sessions.unmount();

  const classic = renderIn(false, <ChatAccordLaunchCard card={card} participants={PARTICIPANTS} />);
  assert.equal(classic.root.findAll(hasClass("chat-accord-launch-avatar")).length, 3);
  assert.deepEqual(providerKinds(classic.root), []);
  classic.unmount();
});

function approval(patch: Partial<ChatAppToolApproval>): ChatAppToolApproval {
  return {
    id: `a-${patch.toolName}`, conversationId: "chat-sessions", requesterParticipantId: MAIN.id, requesterHandle: "main",
    requesterRoleConfigId: "main-session", capability: "permissions.request", status: "pending", summary: "", request: {},
    createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", ...patch
  } as ChatAppToolApproval;
}

test("approval cards on the main timeline show who asks by the provider's logo in the sessions view, by the avatar in the classic view", () => {
  const cards = [
    approval({ toolName: "codex_auto_review_approval", summary: "Run git push", request: {
      kind: "codexApproval", method: "item/commandExecution/requestApproval", requestId: "r1", threadId: "t", turnId: "u", itemId: "i", action: "command",
      options: [{ id: "accept", label: "Allow once", outcome: "approve" }, { id: "decline", label: "Deny", outcome: "deny" }]
    } as never }),
    approval({ toolName: "app_connector_sign_in", summary: "Sign in to claude.ai Gmail", request: { kind: "connectorSignIn", connector: "claude.ai Gmail", action: "sign-in" } as never })
  ];
  for (const item of cards) {
    const element = (
      <ChatAppToolApprovalCard approval={item} participants={PARTICIPANTS} savedParticipants={[]} roles={[]} submitting={false} onRespond={async () => undefined} />
    );
    const sessions = renderIn(true, element);
    assert.equal(sessions.root.findAll(hasClass("chat-app-tool-approval-avatar")).length, 0, `${item.toolName}: no avatar picture`);
    assert.deepEqual(providerKinds(sessions.root), ["claude-code"], `${item.toolName}: the main session's provider logo`);
    sessions.unmount();
    const classic = renderIn(false, element);
    assert.equal(classic.root.findAll(hasClass("chat-app-tool-approval-avatar")).length, 1, `${item.toolName}: the avatar, as before`);
    classic.unmount();
  }
});
