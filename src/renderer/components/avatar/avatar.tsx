import type { ReactNode } from "react";

import type {
  ChatParticipant,
  Conversation
} from "../../../shared/types";
import type { AvatarSpec } from "../chat/chat-avatars";
import { avatarForChatParticipant } from "../chat/chat-avatars";

const JUDGE_AVATAR_URL = new URL("../../assets/judge-flaticon-5452982.png", import.meta.url).href;
const CLAUDE_AVATAR_URL = new URL("../../assets/claude-avatar.png", import.meta.url).href;
const CODEX_AVATAR_URL = new URL("../../assets/codex-cli.svg", import.meta.url).href;

export const USER_AVATAR: AvatarSpec = { kind: "user", label: "You", mediaMode: "glyph" };
export const ARBITER_AVATAR: AvatarSpec = { kind: "arbiter", label: "Arbiter", mediaMode: "glyph" };

export function Avatar({ className, spec, tooltip }: { className: string; spec: AvatarSpec; tooltip?: string | null }): JSX.Element {
  const title = tooltip === null ? undefined : tooltip ?? spec.label;
  const mediaMode = spec.mediaMode ?? (spec.kind === "custom" ? "photo" : "glyph");
  return (
    <div className={`${className} avatar-icon avatar-${spec.kind}`} title={title} aria-label={spec.label}>
      {avatarGraphic(spec, mediaMode)}
    </div>
  );
}

export function avatarForMessage(message: Conversation["messages"][number], author: string, participant?: ChatParticipant): AvatarSpec {
  if (message.role === "user") {
    return USER_AVATAR;
  }
  if (message.role === "system" && participant) {
    return avatarForChatParticipant(participant, author);
  }
  if (message.role === "system" || message.role === "summary" || message.participantId?.startsWith("arbiter:")) {
    return { ...ARBITER_AVATAR, label: author };
  }
  if (participant) {
    return avatarForChatParticipant(participant, author);
  }
  return avatarForParticipant(author, message.participantId);
}

export function avatarForParticipant(label: string, participantId?: string): AvatarSpec {
  const text = `${participantId ?? ""} ${label}`.toLowerCase();
  if (text.includes("arbiter") || text.includes("planner")) {
    return ARBITER_AVATAR;
  }
  if (text.includes("claude") || text.includes("anthropic")) {
    return { kind: "anthropic", label, mediaMode: "glyph" };
  }
  if (text.includes("codex") || text.includes("openai")) {
    return { kind: "codex", label, mediaMode: "glyph" };
  }
  if (text.includes("gemini")) {
    return { kind: "gemini", label, mediaMode: "glyph" };
  }
  return { kind: "generic", label, initials: initials(label), mediaMode: "glyph" };
}

function avatarGraphic(spec: AvatarSpec, mediaMode: NonNullable<AvatarSpec["mediaMode"]>): ReactNode {
  const mediaClassName = `avatar-media avatar-media-${mediaMode}`;
  if (spec.kind === "user") {
    return (
      <svg className={mediaClassName} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8.2" r="5.1" />
        <path d="M3.6 22.2c1.3-5.1 4.2-7.6 8.4-7.6s7.1 2.5 8.4 7.6z" />
      </svg>
    );
  }
  if (spec.kind === "arbiter") {
    return <img className={mediaClassName} src={JUDGE_AVATAR_URL} alt="" aria-hidden="true" />;
  }
  if (spec.kind === "anthropic") {
    return <img className={mediaClassName} src={CLAUDE_AVATAR_URL} alt="" aria-hidden="true" />;
  }
  if (spec.kind === "codex") {
    return <img className={mediaClassName} src={CODEX_AVATAR_URL} alt="" aria-hidden="true" />;
  }
  if (spec.kind === "custom" && spec.imageUrl) {
    return <img className={mediaClassName} src={spec.imageUrl} alt="" aria-hidden="true" />;
  }
  if (spec.kind === "gemini") {
    return (
      <svg className={mediaClassName} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2.8c1 5 4.2 8.2 9.2 9.2-5 1-8.2 4.2-9.2 9.2-1-5-4.2-8.2-9.2-9.2 5-1 8.2-4.2 9.2-9.2Z" />
      </svg>
    );
  }
  return <span className={mediaClassName}>{spec.initials || initials(spec.label)}</span>;
}

function initials(value: string): string {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "M"
  );
}
