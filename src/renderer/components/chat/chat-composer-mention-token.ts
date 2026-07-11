export interface DraftMentionRange {
  handle: string;
  start: number;
  end: number;
}

const MENTION_PATTERN = /(^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9_-]{0,31})/g;

export function draftHasMention(value: string): boolean {
  return draftMentionRanges(value).length > 0;
}

export function draftMentionRanges(value: string): DraftMentionRange[] {
  return Array.from(value.matchAll(MENTION_PATTERN), (match) => {
    const leading = match[1] ?? "";
    const handle = match[2] ?? "";
    const start = (match.index ?? 0) + leading.length;
    return { handle, start, end: start + handle.length + 1 };
  });
}
