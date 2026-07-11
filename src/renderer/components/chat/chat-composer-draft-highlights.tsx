import type { ReactNode } from "react";
import { FileBox, Puzzle } from "lucide-react";

import type { ChatSkillMention } from "../../../shared/types";
import {
  draftArtifactMentions,
  escapeRegExp,
  type DraftPluginMention
} from "./chat-composer-draft-utils";
import { PLUGIN_ICON_SPACER } from "./chat-composer-plugin-token";
import { draftMentionRanges } from "./chat-composer-mention-token";

interface DraftHighlight {
  start: number;
  end: number;
  key: string;
  className: string;
  content: ReactNode;
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
    content: <><FileBox size={15} strokeWidth={2.2} aria-hidden /><span>{mention.label}</span></>
  }));
  for (const [mentionIndex, mention] of draftMentionRanges(value).entries()) {
    highlights.push({
      start: mention.start,
      end: mention.end,
      key: `participant-${mention.handle.toLowerCase()}-${mentionIndex}`,
      className: "chat-draft-member-token",
      content: value.slice(mention.start, mention.end)
    });
  }
  if (names.length > 0) {
    const pattern = new RegExp(`(^|\\s)/(${names.map(escapeRegExp).join("|")})(?=\\s|$)`, "g");
    let index = 0;
    for (const match of value.matchAll(pattern)) {
      const leading = match[1] ?? "";
      const name = match[2] ?? "";
      const start = (match.index ?? 0) + leading.length;
      const end = start + name.length + 1;
      const token = byName.get(name);
      const hasPluginSpacer = Boolean(token?.icon) && start >= PLUGIN_ICON_SPACER.length &&
        value.slice(start - PLUGIN_ICON_SPACER.length, start) === PLUGIN_ICON_SPACER;
      highlights.push({
        start: hasPluginSpacer ? start - PLUGIN_ICON_SPACER.length : start,
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
