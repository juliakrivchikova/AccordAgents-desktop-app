import type { CSSProperties, ReactNode } from "react";

import type {
  ChatParticipant,
  ChatSkillMention,
  UserSkillTargetSummary
} from "../../../shared/types";
import { providerLabel } from "./chat-conversation-data";

export const CHAT_COMPOSER_TEXTAREA_STYLE: CSSProperties = {
  fontSize: "14.5px",
  lineHeight: 1.5,
  // Match the design handoff composer: single-line resting height that grows.
  minHeight: "24px",
  padding: "3px 4px"
};

export interface SlashCommandOption {
  id: "compact";
  label: string;
  description: string;
}

export function activeMentionQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  return match ? match[1] : undefined;
}

export function activeFileQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)#([^\s#]*)$/);
  return match ? match[1] : undefined;
}

export function activeSkillQuery(value: string): string | undefined {
  const match = value.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
  return match ? match[1] : undefined;
}

export function compactCommandOption(query: string | undefined, target: UserSkillTargetSummary | undefined): SlashCommandOption | undefined {
  if (query === undefined || !target?.hasClearTargets || target.participantIds.length !== 1) {
    return undefined;
  }
  if (!"compact".startsWith(query.toLowerCase())) {
    return undefined;
  }
  return {
    id: "compact",
    label: "/compact",
    description: "Compact the mentioned participant context"
  };
}

export function replaceActiveMention(value: string, handle: string): string {
  const match = value.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}@${handle} `;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}@${handle} `;
}

export function replaceActiveFileMention(value: string, filePath: string): string {
  const match = value.match(/(?:^|\s)#([^\s#]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}#${filePath} `;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}#${filePath} `;
}

export function removeFileMentionToken(value: string, filePath: string): string {
  const escaped = escapeRegExp(filePath);
  return value
    .replace(new RegExp(`(^|\\s)#${escaped}(?=\\s|$)`, "g"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function replaceActiveSkillMention(value: string, skillName: string): string {
  const match = value.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}/${skillName} `;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}/${skillName} `;
}

export function removeSkillMentionToken(value: string, skillName: string): string {
  const escaped = escapeRegExp(skillName);
  return value
    .replace(new RegExp(`(^|\\s)/${escaped}(?=\\s|$)`, "g"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function draftHasSkillMention(value: string, skillName: string): boolean {
  return new RegExp(`(^|\\s)/${escapeRegExp(skillName)}(?=\\s|$)`).test(value);
}

export function renderSkillHighlightedDraft(value: string, mentions: ChatSkillMention[]): ReactNode[] {
  const byName = new Map<string, ChatSkillMention>();
  for (const mention of mentions) {
    byName.set(mention.frontmatterName, mention);
  }
  const names = Array.from(byName.keys()).sort((left, right) => right.length - left.length);
  if (names.length === 0 || !value) {
    return [value || "\u00a0"];
  }
  const pattern = new RegExp(`(^|\\s)/(${names.map(escapeRegExp).join("|")})(?=\\s|$)`, "g");
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of value.matchAll(pattern)) {
    const leading = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + leading.length;
    const end = start + name.length + 1;
    if (start > cursor) {
      nodes.push(value.slice(cursor, start));
    }
    nodes.push(
      <span className="chat-draft-skill-token" key={`${name}-${index}`}>
        {value.slice(start, end)}
      </span>
    );
    cursor = end;
    index += 1;
  }
  if (cursor < value.length) {
    nodes.push(value.slice(cursor));
  }
  return nodes.length > 0 ? nodes : [value];
}

export function draftHasFileMention(value: string, filePath: string): boolean {
  return new RegExp(`(^|\\s)#${escapeRegExp(filePath)}(?=\\s|$)`).test(value);
}

export function repoFileBasename(filePath: string): string {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

export function skillPickerTargetLabel(target: UserSkillTargetSummary, participants: ChatParticipant[]): string {
  if (!target.hasClearTargets || target.providerKinds.length === 0) {
    return "Mention a participant to select a skill";
  }
  const handles = target.participantIds
    .map((id) => participants.find((participant) => participant.id === id)?.handle)
    .filter((handle): handle is string => Boolean(handle))
    .map((handle) => `@${handle}`);
  const providerText = target.providerKinds.map(providerLabel).join(", ");
  return `For ${handles.length > 0 ? handles.join(", ") : "selected target"} · ${providerText}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
