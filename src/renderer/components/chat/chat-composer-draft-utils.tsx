import type { CSSProperties, ReactNode } from "react";
import { Puzzle } from "lucide-react";

import type {
  ArtifactSummary,
  ChatParticipant,
  ChatSkillMention,
  UserSkillTargetSummary
} from "../../../shared/types";
import { artifactReference } from "../../../shared/artifacts";
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

export interface DraftPluginMention {
  name: string;
  displayName: string;
  iconUrl?: string;
}

interface DraftArtifactMention {
  id: string;
  label: string;
  start: number;
  end: number;
}

interface DraftHighlight {
  start: number;
  end: number;
  key: string;
  className: string;
  content: ReactNode;
}

const ARTIFACT_MARKER_START = "\u2063";
const ARTIFACT_MARKER_END = "\u2064";
const ARTIFACT_MARKER_DIGITS = ["\u200B", "\u200C", "\u200D", "\u2060"] as const;
const ARTIFACT_MARKER_DIGIT_INDEX: ReadonlyMap<string, number> = new Map(ARTIFACT_MARKER_DIGITS.map((digit, index) => [digit, index]));

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
    description: "Compact the mentioned member context"
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

export function matchArtifactMentions(artifacts: ArtifactSummary[], query: string, limit = 8): ArtifactSummary[] {
  const needle = query.trim().toLowerCase();
  return artifacts
    .filter((artifact) => artifact.name.toLowerCase().includes(needle))
    .sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(needle) ? 0 : 1;
      const rightStarts = right.name.toLowerCase().startsWith(needle) ? 0 : 1;
      if (leftStarts !== rightStarts) {
        return leftStarts - rightStarts;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
}

export function artifactMentionToken(artifact: Pick<ArtifactSummary, "id" | "name">): string {
  return artifactReference(artifact.id, artifactDisplayLabel(artifact.name));
}

export function serializeArtifactDraft(value: string): string {
  const mentions = draftArtifactMentions(value);
  if (mentions.length === 0) {
    return stripInvalidArtifactMarkers(value);
  }
  let cursor = 0;
  let serialized = "";
  for (const mention of mentions) {
    serialized += value.slice(cursor, mention.start);
    serialized += artifactReference(mention.id, mention.label);
    cursor = mention.end;
  }
  return serialized + stripInvalidArtifactMarkers(value.slice(cursor));
}

export function replaceActiveArtifactMention(value: string, artifact: Pick<ArtifactSummary, "id" | "name">): string {
  const label = artifactDisplayLabel(artifact.name);
  const token = `${label}${artifactMarker(artifact.id, label)}`;
  const match = value.match(/(?:^|\s)#([^\s#]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}${token} `;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}${token} `;
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

export function replaceActiveSlashToken(value: string, replacement: string): string {
  const insertion = replacement.trim();
  const match = value.match(/(?:^|\s)\/([A-Za-z0-9_-]*)$/);
  if (!match || match.index === undefined) {
    return `${value}${value.endsWith(" ") || !value ? "" : " "}${insertion}`;
  }
  const prefix = value.slice(0, match.index);
  const leadingSpace = match[0].startsWith(" ") ? " " : "";
  return `${prefix}${leadingSpace}${insertion}`;
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

export function draftStartsWithPluginMention(value: string, pluginMentions: DraftPluginMention[]): boolean {
  return pluginMentions.some((mention) => new RegExp(`^/${escapeRegExp(mention.name)}(?=\\s|$)`).test(value));
}

export function renderSlashHighlightedDraft(
  value: string,
  skillMentions: ChatSkillMention[],
  pluginMentions: DraftPluginMention[] = []
): ReactNode[] {
  const byName = new Map<string, { className: string; icon?: ReactNode }>();
  for (const mention of pluginMentions) {
    byName.set(mention.name, {
      className: "chat-draft-plugin-token",
      icon: mention.iconUrl
        ? <img className="chat-draft-plugin-token-icon" src={mention.iconUrl} alt="" aria-hidden="true" />
        : <Puzzle className="chat-draft-plugin-token-icon" size={15} strokeWidth={2.2} aria-hidden="true" />
    });
  }
  for (const mention of skillMentions) {
    byName.set(mention.frontmatterName, { className: "chat-draft-skill-token" });
  }
  const names = Array.from(byName.keys()).sort((left, right) => right.length - left.length);
  const highlights: DraftHighlight[] = draftArtifactMentions(value).map((mention, index) => ({
    start: mention.start,
    end: mention.end,
    key: `artifact-${mention.id}-${index}`,
    className: "chat-draft-artifact-token",
    content: mention.label
  }));
  if (names.length > 0) {
    const pattern = new RegExp(`(^|\\s)/(${names.map(escapeRegExp).join("|")})(?=\\s|$)`, "g");
    let index = 0;
    for (const match of value.matchAll(pattern)) {
      const leading = match[1] ?? "";
      const name = match[2] ?? "";
      const start = (match.index ?? 0) + leading.length;
      const end = start + name.length + 1;
      const token = byName.get(name);
      highlights.push({
        start,
        end,
        key: `slash-${name}-${index}`,
        className: token?.className ?? "chat-draft-skill-token",
        content: <>{token?.icon}{value.slice(start, end)}</>
      });
      index += 1;
    }
  }
  if (highlights.length === 0 || !value) {
    return [value || "\u00a0"];
  }
  highlights.sort((left, right) => left.start - right.start || left.end - right.end);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const highlight of highlights) {
    if (highlight.start < cursor) {
      continue;
    }
    if (highlight.start > cursor) {
      nodes.push(value.slice(cursor, highlight.start));
    }
    nodes.push(<span className={highlight.className} key={highlight.key}>{highlight.content}</span>);
    cursor = highlight.end;
  }
  if (cursor < value.length) {
    nodes.push(value.slice(cursor));
  }
  return nodes.length > 0 ? nodes : [value];
}

export function draftHasFileMention(value: string, filePath: string): boolean {
  return new RegExp(`(^|\\s)#${escapeRegExp(filePath)}(?=\\s|$)`).test(value);
}

export function draftHasArtifactMention(value: string): boolean {
  return draftArtifactMentions(value).length > 0;
}

export function normalizeArtifactDraft(value: string): string {
  return stripInvalidArtifactMarkers(value, true);
}

export function repoFileBasename(filePath: string): string {
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

export function skillPickerTargetLabel(target: UserSkillTargetSummary, participants: ChatParticipant[]): string {
  if (!target.hasClearTargets || target.providerKinds.length === 0) {
    return "Mention a member to select a skill";
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

function artifactDisplayLabel(name: string): string {
  return name.replace(/[\[\]\n\r]/g, " ").replace(/\s+/g, " ").trim() || "artifact";
}

function artifactMarker(id: string, label: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ id, label }));
  let encoded = ARTIFACT_MARKER_START;
  for (const byte of bytes) {
    encoded += ARTIFACT_MARKER_DIGITS[(byte >> 6) & 3];
    encoded += ARTIFACT_MARKER_DIGITS[(byte >> 4) & 3];
    encoded += ARTIFACT_MARKER_DIGITS[(byte >> 2) & 3];
    encoded += ARTIFACT_MARKER_DIGITS[byte & 3];
  }
  return `${encoded}${ARTIFACT_MARKER_END}`;
}

function draftArtifactMentions(value: string): DraftArtifactMention[] {
  const mentions: DraftArtifactMention[] = [];
  let searchFrom = 0;
  while (searchFrom < value.length) {
    const markerStart = value.indexOf(ARTIFACT_MARKER_START, searchFrom);
    if (markerStart < 0) {
      break;
    }
    const markerEnd = value.indexOf(ARTIFACT_MARKER_END, markerStart + ARTIFACT_MARKER_START.length);
    if (markerEnd < 0) {
      break;
    }
    const metadata = decodeArtifactMarker(value.slice(markerStart + ARTIFACT_MARKER_START.length, markerEnd));
    const start = metadata ? markerStart - metadata.label.length : markerStart;
    if (metadata && start >= 0 && value.slice(start, markerStart) === metadata.label) {
      mentions.push({ id: metadata.id, label: metadata.label, start, end: markerEnd + ARTIFACT_MARKER_END.length });
    }
    searchFrom = markerEnd + ARTIFACT_MARKER_END.length;
  }
  return mentions;
}

function decodeArtifactMarker(value: string): { id: string; label: string } | undefined {
  if (!value || value.length % 4 !== 0) {
    return undefined;
  }
  const bytes = new Uint8Array(value.length / 4);
  for (let index = 0; index < value.length; index += 4) {
    const digits = [
      ARTIFACT_MARKER_DIGIT_INDEX.get(value[index]),
      ARTIFACT_MARKER_DIGIT_INDEX.get(value[index + 1]),
      ARTIFACT_MARKER_DIGIT_INDEX.get(value[index + 2]),
      ARTIFACT_MARKER_DIGIT_INDEX.get(value[index + 3])
    ];
    if (digits.some((digit) => digit === undefined)) {
      return undefined;
    }
    bytes[index / 4] = (digits[0]! << 6) | (digits[1]! << 4) | (digits[2]! << 2) | digits[3]!;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { id?: unknown; label?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.label !== "string" || !parsed.id || !parsed.label) {
      return undefined;
    }
    return { id: parsed.id, label: parsed.label };
  } catch {
    return undefined;
  }
}

function stripInvalidArtifactMarkers(value: string, keepValid = false): string {
  let normalized = "";
  let cursor = 0;
  while (cursor < value.length) {
    const markerStart = value.indexOf(ARTIFACT_MARKER_START, cursor);
    if (markerStart < 0) {
      return `${normalized}${value.slice(cursor)}`;
    }
    normalized += value.slice(cursor, markerStart);
    const markerEnd = value.indexOf(ARTIFACT_MARKER_END, markerStart + ARTIFACT_MARKER_START.length);
    if (markerEnd < 0) {
      return normalized;
    }
    const metadata = decodeArtifactMarker(value.slice(markerStart + ARTIFACT_MARKER_START.length, markerEnd));
    const start = metadata ? markerStart - metadata.label.length : markerStart;
    const valid = Boolean(metadata && start >= 0 && value.slice(start, markerStart) === metadata.label);
    if (valid && keepValid) {
      normalized += value.slice(markerStart, markerEnd + ARTIFACT_MARKER_END.length);
    }
    cursor = markerEnd + ARTIFACT_MARKER_END.length;
  }
  return normalized;
}
