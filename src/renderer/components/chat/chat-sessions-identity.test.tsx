// The sessions view has no avatar pictures: a member's only mark there is its
// provider's bare logo glyph (the User, 2026-11-20/21). The classic view keeps every
// avatar.
import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatAppToolApproval, ProviderModelCatalog } from "../../../shared/types";
import { avatarForParticipant } from "../avatar/avatar";
import { ChatAccordLaunchCard } from "./chat-accord-launch-card";
import { ChatAppToolApprovalCard } from "./chat-app-tool-approval-card";
import { ChatMemberMark, ChatSessionsPresentationContext, renderComposerMemberMark, renderNewChatMemberMark } from "./chat-member-mark";
import { ChatComposerSendButton } from "./chat-composer-send-button";
import { memberDefaultModelName, resetMemberModelCatalogs } from "./chat-member-model-name";
import { ChatParticipantRosterRow } from "./chat-participant-roster-row";
import { SESSIONS_COMPOSER_PLACEHOLDER, mainComposerTargetIds, memberModelChip, sessionsComposerProps } from "./chat-sessions-composer";
import { ChatSessionsLinksContext, type ChatSessionsLinks } from "./chat-sessions-links";
import { ChatTurnFinishedNote } from "./chat-turn-finished-note";
import { DREW, MAIN, PARTICIPANTS, TAYLOR } from "./chat-sessions-fixtures.test";

const NOW_ISO = "2026-11-21T10:00:00.000Z";

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

test("a member's mark: its avatar in the classic view; its provider's bare glyph in the sessions view, nothing for a member no longer known", () => {
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
  assert.ok(mark.props.className.split(" ").includes("is-bare"), "the glyph alone, no tile behind it");
  assert.equal(mark.props["data-variant"], "bare");
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

test("the New chat screen shows the main session by its provider's logo, not an avatar picture; other members keep theirs", () => {
  const main = renderIn(false, <>{renderNewChatMemberMark(MAIN)}</>);
  assert.deepEqual(providerKinds(main.root), [MAIN.kind]);
  assert.equal(avatars(main.root), 0);
  main.unmount();
  const member = renderIn(false, <>{renderNewChatMemberMark(DREW)}</>);
  assert.deepEqual(providerKinds(member.root), []);
  assert.ok(avatars(member.root) > 0, "its avatar");
  member.unmount();
});

test("the sessions view's composer writes to the main session: no members to mention, its own placeholder, the main session's model chip", () => {
  assert.deepEqual(sessionsComposerProps(undefined), {}, "the classic composer is as before");
  const props = sessionsComposerProps(MAIN.id, (id) => <span data-testid="chip">{id}</span>);
  assert.deepEqual(props.participants, []);
  assert.equal(props.placeholder, SESSIONS_COMPOSER_PLACEHOLDER);
  const chip = renderIn(true, <>{memberModelChip(PARTICIPANTS, MAIN.id)}</>);
  assert.deepEqual(providerKinds(chip.root), [MAIN.kind]);
  assert.equal(textOf(chip.root), "Claude Code", "no model of its own and no list of its CLI's: the CLI's name, never 'Default model'");
  chip.unmount();
  const tuned = renderIn(true, <>{memberModelChip([{ ...MAIN, model: "Haiku 5.5", reasoningEffort: "low" }], MAIN.id)}</>);
  assert.match(textOf(tuned.root), /Haiku 5\.5/);
  assert.match(textOf(tuned.root), /Low/);
  tuned.unmount();
});

test("the sessions view's main composer has no active-runs pill, and its button stops the main session while it runs and nothing is typed", () => {
  const stopped: string[] = [];
  const idle = sessionsComposerProps(MAIN.id, undefined, { runIds: [], onStopRun: (runId) => stopped.push(runId) });
  assert.equal(idle.activeRunCount, 0, "no 'N active runs' pill: the Waiting line and the side panel name the members");
  assert.ok("onStopAllRuns" in idle && idle.onStopAllRuns === undefined);
  assert.equal(idle.stop, undefined, "nothing to stop while the main session is idle");
  const busy = sessionsComposerProps(MAIN.id, undefined, { runIds: ["run-main", "run-main-queued"], onStopRun: (runId) => stopped.push(runId) });
  assert.equal(busy.stop?.label, "Stop the main session");
  busy.stop?.onStop();
  assert.deepEqual(stopped, ["run-main", "run-main-queued"], "the main session's runs only");

  const button = (canSend: boolean, draftEmpty = !canSend) =>
    renderIn(true, <ChatComposerSendButton canSend={canSend} draftEmpty={draftEmpty} isRunning={false} onSend={() => stopped.push("sent")} stop={busy.stop} />);
  const empty = button(false);
  const stop = empty.root.find((node) => node.type === "button");
  assert.equal(stop.props["data-testid"], "chat-composer-stop");
  assert.equal(stop.props["aria-label"], "Stop the main session");
  assert.equal(stop.props.disabled, undefined, "enabled with nothing typed");
  empty.unmount();
  const typed = button(true);
  const send = typed.root.find((node) => node.type === "button");
  assert.equal(send.props["aria-label"], "Send message", "typing turns it back into Send");
  act(() => send.props.onClick());
  assert.equal(stopped.at(-1), "sent");
  typed.unmount();
  // A picture still loading (nothing sendable yet) is not an empty draft: a disabled Send, not Stop.
  const loading = button(false, false);
  const waiting = loading.root.find((node) => node.type === "button");
  assert.equal(waiting.props["aria-label"], "Send message", "a picture still loading keeps Send");
  assert.equal(waiting.props.disabled, true);
  loading.unmount();
  const classic = renderIn(false, <ChatComposerSendButton canSend={false} draftEmpty isRunning={false} onSend={() => undefined} />);
  assert.equal(classic.root.find((node) => node.type === "button").props.disabled, true, "without a Stop, an empty draft is a disabled Send, as before");
  classic.unmount();
});

test("a member's settings card names it by its task in the sessions view, the main session as Main session; the classic view keeps the handle", () => {
  const links: ChatSessionsLinks = {
    mainSessionId: MAIN.id, mainHandle: "main",
    byHandle: new Map([["drew", { id: DREW.id, title: "Fix the logout" }]]), openMember: () => undefined
  };
  const row = (participant: typeof MAIN) => (
    <ChatParticipantRosterRow
      participant={participant} removeDisabledReason={undefined} busy={false} status="idle" runLocationLocked={false}
      renderParticipantAvatar={() => null} participantRoleLabel={() => "Member"} participantRoleArchived={() => false}
      onInsertMention={() => undefined} onJumpToLastMessage={() => undefined} onUpdateParticipantRuntime={() => undefined}
      onCompactParticipant={() => undefined} onRestartParticipant={async () => true} onStopRestart={() => undefined} onRemoveParticipant={() => undefined}
    />
  );
  const name = (root: ReactTestInstance) => textOf(root.find(hasClass("chat-participant-name")));
  const drew = renderIn(true, <ChatSessionsLinksContext.Provider value={links}>{row(DREW)}</ChatSessionsLinksContext.Provider>);
  assert.equal(name(drew.root), "Fix the logout");
  drew.unmount();
  const main = renderIn(true, <ChatSessionsLinksContext.Provider value={links}>{row(MAIN)}</ChatSessionsLinksContext.Provider>);
  assert.equal(name(main.root), "Main session");
  main.unmount();
  const classic = renderIn(false, row(DREW));
  assert.match(name(classic.root), /drew/);
  classic.unmount();
});

test("only the sessions view's main composer fixes its addressee; the classic one keeps today's routing", () => {
  assert.deepEqual(mainComposerTargetIds(MAIN.id), [MAIN.id], "sessions view: the main session, whatever the text names");
  assert.equal(mainComposerTargetIds(undefined), undefined, "classic view: no fixed target, so an @handle addresses that member");
  assert.deepEqual(sessionsComposerProps(undefined), {}, "and the classic composer is as before");
});

test("a member without a model of its own: its chip names the model its CLI runs on by default, else the CLI", async () => {
  const catalog = (models: ProviderModelCatalog["models"]): ProviderModelCatalog => ({ kind: "claude-code", models, authoritative: true, fetchedAt: NOW_ISO });
  // The CLI's own default, by its label; Codex's repeated id left out; the app's provider setting is not what a member runs on.
  assert.equal(memberDefaultModelName(MAIN, catalog([{ id: "opus", label: "Opus", recommended: true, source: "cli" }, { id: "haiku", label: "Haiku", source: "cli" }])), "Opus");
  assert.equal(memberDefaultModelName({ ...MAIN, kind: "codex-cli" }, catalog([{ id: "gpt-5.5", label: "GPT-5.5 (gpt-5.5)", recommended: true, source: "cli" }])), "GPT-5.5");
  assert.equal(memberDefaultModelName(MAIN, catalog([{ id: "my-model", label: "my-model", recommended: true, source: "configured" }])), "Claude Code");
  assert.equal(memberDefaultModelName(MAIN, undefined), "Claude Code");
  assert.equal(memberDefaultModelName({ ...TAYLOR, kind: "gemini-cli" }, undefined), "Antigravity");
  // A member on an added provider: the vendor's default model.
  assert.equal(memberDefaultModelName({ ...MAIN, hostVendor: "zai", hostLabel: "Z.ai" }, undefined), "GLM-5.3");

  // The chip asks the CLI's list once and shows its default, with the effort after it.
  resetMemberModelCatalogs();
  const asked: string[] = [];
  // The window the renderer tests run in, or one of its own.
  const host = (typeof window === "undefined" ? undefined : window) as unknown as { consensus?: unknown } | undefined;
  const target = host ?? {};
  if (!host) Object.defineProperty(globalThis, "window", { value: target, configurable: true, writable: true });
  const previous = target.consensus;
  target.consensus = { listProviderModels: async (kind: string) => {
    asked.push(kind);
    return catalog([{ id: "opus", label: "Opus", recommended: true, source: "cli" }]);
  } };
  try {
    const chip = renderIn(true, <>{memberModelChip([{ ...MAIN, reasoningEffort: "high" }], MAIN.id)}</>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(textOf(chip.root), "OpusHigh");
    chip.unmount();
    const again = renderIn(true, <>{memberModelChip(PARTICIPANTS, MAIN.id)}</>);
    assert.equal(textOf(again.root), "Opus", "known at once the next time");
    again.unmount();
    assert.deepEqual(asked, ["claude-code"], "asked once");
  } finally {
    target.consensus = previous;
    if (!host) delete (globalThis as { window?: unknown }).window;
    resetMemberModelCatalogs();
  }
});

test("a turn-finished note names the main session and members without handles in the sessions view", () => {
  const links: ChatSessionsLinks = {
    mainSessionId: MAIN.id, mainHandle: "main",
    byHandle: new Map([["drew", { id: DREW.id, title: "Fix the logout" }]]), openMember: () => undefined
  };
  const note = (participant: typeof MAIN) => (
    <ChatSessionsLinksContext.Provider value={links}>
      <ChatTurnFinishedNote
        message={{ id: "n", content: "Done", createdAt: "2026-11-20T10:00:00.000Z" }}
        note={{ messageId: "r", participantId: participant.id, participantLabel: `@${participant.handle}` }}
        participant={participant}
      />
    </ChatSessionsLinksContext.Provider>
  );
  const main = renderIn(true, note(MAIN));
  assert.match(textOf(main.root), /Main session finished answering/);
  main.unmount();
  const drew = renderIn(true, note(DREW));
  assert.match(textOf(drew.root), /Fix the logout finished answering/);
  assert.doesNotMatch(textOf(drew.root), /@/);
  drew.unmount();
});
