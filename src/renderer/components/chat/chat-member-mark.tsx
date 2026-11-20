import { createContext, useContext } from "react";

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

/** A member's provider logo tile, at row size. */
export function ChatProviderMark(props: { member: ChatMemberProvider; className?: string }): JSX.Element {
  return (
    <ProviderIcon
      className={props.className ? `chat-provider-icon ${props.className}` : "chat-provider-icon"}
      kind={props.member.kind}
      label={participantProviderLabel(props.member.kind, props.member.hostLabel)}
    />
  );
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
