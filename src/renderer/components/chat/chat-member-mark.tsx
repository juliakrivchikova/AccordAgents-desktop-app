import { createContext, useContext } from "react";

import { MAIN_SESSION_ROLE_ID } from "../../../shared/mainSession";
import type { ChatParticipant, ChatProviderKind } from "../../../shared/types";
import { Avatar } from "../avatar/avatar";
import { avatarForChatParticipant, type AvatarSpec } from "./chat-avatars";
import { participantProviderLabel } from "./chat-mention-directory";
import { ProviderIcon } from "./provider-icon";

/**
 * Whether the chat is shown in the sessions view (docs/main-session.md).
 * There a member has no avatar picture anywhere: its only mark is its
 * provider's logo tile, the one Settings → Local CLI setup shows (the User,
 * 2026-11-20). The chat view provides it; outside a chat, and in the classic
 * view, every avatar stays.
 */
export const ChatSessionsPresentationContext = createContext(false);

export function useChatSessionsPresentation(): boolean {
  return useContext(ChatSessionsPresentationContext);
}

/** What a provider mark needs to know of a member. */
export interface ChatMemberProvider {
  kind: ChatProviderKind;
  hostLabel?: string;
}

/** A member's provider mark, at row size: the bare glyph (Claude's orange
 *  asterisk, Codex's glyph, Antigravity's "A"), sized to the text beside it,
 *  as T3 Code shows it (the User, 2026-11-21); `tile` puts it on its logo
 *  tile, as Settings → Local CLI setup shows it. */
export function ChatProviderMark(props: { member: ChatMemberProvider; className?: string; tile?: boolean }): JSX.Element {
  return (
    <ProviderIcon
      className={props.className ? `chat-provider-icon ${props.className}` : "chat-provider-icon"}
      kind={props.member.kind}
      label={participantProviderLabel(props.member.kind, props.member.hostLabel)}
      bare={props.tile !== true}
    />
  );
}

/** Where a member has no known provider (removed since): an empty slot of
 *  the bare mark's size. */
export function ChatProviderMarkSlot(): JSX.Element {
  return <span className="chat-provider-icon is-bare" aria-hidden="true" />;
}

/**
 * Where a member's avatar goes: the avatar, or in the sessions view its
 * provider's logo instead (nothing for a member whose provider is not known,
 * a member removed since).
 */
export function ChatMemberMark(props: {
  avatar: AvatarSpec;
  member?: ChatMemberProvider;
  /** The avatar's class. */
  className: string;
  /** The provider logo's own class, beside `chat-provider-icon`. */
  markClassName?: string;
  tooltip?: string | null;
}): JSX.Element | null {
  const sessions = useChatSessionsPresentation();
  if (!sessions) {
    return <Avatar className={props.className} spec={props.avatar} tooltip={props.tooltip} />;
  }
  return props.member ? <ChatProviderMark member={props.member} className={props.markClassName} /> : null;
}

/** A member's mark in a composer's member lists (@ suggestions, what runs). */
export function renderComposerMemberMark(participant: ChatParticipant): JSX.Element {
  return <ChatMemberMark className="mini-avatar" markClassName="is-mini" avatar={avatarForChatParticipant(participant)} member={participant} />;
}

/** A member's mark on the classic New chat screen: the main session has no
 *  avatar picture, its provider's logo tile is its mark. */
export function renderNewChatMemberMark(participant: ChatParticipant): JSX.Element {
  return participant.roleConfigId === MAIN_SESSION_ROLE_ID
    ? <ChatProviderMark member={participant} className="is-mini" tile />
    : <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant)} />;
}
