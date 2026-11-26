// The slash menu as data: what matches the typed query, how the matches are
// grouped and folded, and the order the arrow keys walk. Variant A of the
// slash menu redesign, chosen by the User (docs/design/slash-menu).

export type SlashKind = "command" | "prompt" | "skill" | "plugin";

export const SLASH_KINDS: readonly SlashKind[] = ["command", "prompt", "skill", "plugin"];

export interface SlashMenuItem<T> {
  kind: SlashKind;
  key: string;
  /** What follows the "/" on the row; matched and highlighted. */
  name: string;
  /** Other names the item answers to, matched without a highlight. */
  aliases?: readonly string[];
  description: string;
  disabled: boolean;
  value: T;
}

export interface SlashMatch {
  rank: number;
  /** Positions of the matched letters in the name. */
  name: readonly number[];
  /** The matched span of the description, end exclusive. */
  description?: readonly [number, number];
}

export type SlashMenuNav<T> =
  | { type: "item"; item: SlashMenuItem<T>; match: SlashMatch }
  | { type: "more"; kind: SlashKind; count: number }
  | { type: "less"; kind: SlashKind };

export type SlashMenuRow<T> =
  | { type: "header"; kind: SlashKind; count: number }
  | (SlashMenuNav<T> & { nav: number });

export interface SlashMenu<T> {
  rows: SlashMenuRow<T>[];
  nav: SlashMenuNav<T>[];
}

const WORD_BREAK = /[-:_\s./]/;
const DESCRIPTION_RANK = 5000;
// Rows a group shows before "Show all": the empty query fits without scrolling.
const FOLD_EMPTY: Record<SlashKind, number> = { command: Infinity, prompt: 2, skill: 4, plugin: 2 };
const FOLD_QUERY: Record<SlashKind, number> = { command: Infinity, prompt: 5, skill: 5, plugin: 5 };

interface NameMatch {
  score: number;
  indices: number[];
  extra: number;
}

/** Exact, prefix, word start, substring, then initials: every letter goes on
 *  from the previous one or starts a word ("ocgr" finds oleg-codex-gemini-review). */
export function matchSlashName(name: string, query: string): NameMatch | undefined {
  const value = name.toLowerCase();
  if (!query) {
    return undefined;
  }
  if (value === query) {
    return { score: 0, indices: range(0, query.length), extra: 0 };
  }
  if (value.startsWith(query)) {
    return { score: 1, indices: range(0, query.length), extra: 0 };
  }
  for (let index = 1; index < value.length; index += 1) {
    if (WORD_BREAK.test(value[index - 1]) && value.startsWith(query, index)) {
      return { score: 2, indices: range(index, index + query.length), extra: index };
    }
  }
  const at = value.indexOf(query);
  if (at >= 0) {
    return { score: 3, indices: range(at, at + query.length), extra: at };
  }
  if (query.length < 3) {
    return undefined;
  }
  const indices = initialsMatch(value, query);
  return indices ? { score: 4, indices, extra: (indices[indices.length - 1] - indices[0]) * 4 } : undefined;
}

function initialsMatch(value: string, query: string): number[] | undefined {
  const failed = new Set<string>();
  const walk = (queryIndex: number, from: number, previous: number): number[] | undefined => {
    if (queryIndex === query.length) {
      return [];
    }
    const key = `${queryIndex}:${previous}`;
    if (failed.has(key)) {
      return undefined;
    }
    for (let index = from; index < value.length; index += 1) {
      const continues = index === previous + 1 || index === 0 || WORD_BREAK.test(value[index - 1]);
      if (value[index] !== query[queryIndex] || !continues) {
        continue;
      }
      const rest = walk(queryIndex + 1, index + 1, index);
      if (rest) {
        return [index, ...rest];
      }
    }
    failed.add(key);
    return undefined;
  };
  return walk(0, 0, -2);
}

/** A description matches where a word starts with the query. */
export function matchSlashDescription(description: string, query: string): [number, number] | undefined {
  if (query.length < 2 || !description) {
    return undefined;
  }
  const lower = description.toLowerCase();
  for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(lower[at - 1])) {
      return [at, at + query.length];
    }
  }
  return undefined;
}

export function matchSlashItem<T>(item: SlashMenuItem<T>, query: string, order: number): SlashMatch | undefined {
  if (!query) {
    return { rank: order, name: [] };
  }
  const own = matchSlashName(item.name, query);
  const alias = (item.aliases ?? [])
    .map((value) => matchSlashName(value, query))
    .filter((value): value is NameMatch => Boolean(value))
    .sort((left, right) => left.score - right.score)[0];
  if (own && (!alias || own.score <= alias.score)) {
    return { rank: own.score * 1000 + own.extra + item.name.length, name: own.indices };
  }
  if (alias) {
    return { rank: alias.score * 1000 + alias.extra + item.name.length, name: own?.indices ?? [] };
  }
  const description = matchSlashDescription(item.description, query);
  return description ? { rank: DESCRIPTION_RANK + description[0], name: [], description } : undefined;
}

export function normalizeSlashQuery(query: string): string {
  return query.trim().replace(/^\/+/, "").toLowerCase();
}

/** Groups in kind order, or, while filtering, only the matches with the group
 *  that holds the best match first. A long group shows its first rows and a
 *  "Show all" row; an expanded one ends with "Show fewer". */
export function buildSlashMenu<T>(
  items: readonly SlashMenuItem<T>[],
  rawQuery: string,
  expanded: ReadonlySet<SlashKind>
): SlashMenu<T> {
  const query = normalizeSlashQuery(rawQuery);
  const groups = SLASH_KINDS.map((kind) => {
    const entries = items
      .filter((item) => item.kind === kind)
      .map((item, order) => ({ item, match: matchSlashItem(item, query, order) }))
      .filter((entry): entry is { item: SlashMenuItem<T>; match: SlashMatch } => Boolean(entry.match));
    if (query) {
      entries.sort((left, right) => left.match.rank - right.match.rank);
    }
    return { kind, entries };
  }).filter((group) => group.entries.length > 0);
  if (query) {
    groups.sort((left, right) => left.entries[0].match.rank - right.entries[0].match.rank);
  }
  const rows: SlashMenuRow<T>[] = [];
  const nav: SlashMenuNav<T>[] = [];
  const push = (entry: SlashMenuNav<T>): void => {
    rows.push({ ...entry, nav: nav.length });
    nav.push(entry);
  };
  for (const group of groups) {
    const fold = (query ? FOLD_QUERY : FOLD_EMPTY)[group.kind];
    // Folding is worth it only when it hides at least two rows.
    const foldable = group.entries.length > fold + 1;
    const open = expanded.has(group.kind);
    const shown = foldable && !open ? group.entries.slice(0, fold) : group.entries;
    rows.push({ type: "header", kind: group.kind, count: group.entries.length });
    for (const entry of shown) {
      push({ type: "item", item: entry.item, match: entry.match });
    }
    if (foldable && !open) {
      push({ type: "more", kind: group.kind, count: group.entries.length });
    } else if (foldable) {
      push({ type: "less", kind: group.kind });
    }
  }
  return { rows, nav };
}

export function isSlashNavEnabled<T>(entry: SlashMenuNav<T> | undefined): boolean {
  return Boolean(entry) && !(entry?.type === "item" && entry.item.disabled);
}

/** A row's identity across rebuilds: a reply or a fold that adds rows above
 *  it must not move the highlight onto another item. */
export function slashNavKey<T>(entry: SlashMenuNav<T>): string {
  return entry.type === "item" ? entry.item.key : `${entry.type}:${entry.kind}`;
}

export function slashMoreKey(kind: SlashKind): string {
  return `more:${kind}`;
}

/** The row the menu highlights: the one the user moved to while it is still
 *  listed, otherwise the first that can be inserted. */
export function resolveSlashActive<T>(nav: readonly SlashMenuNav<T>[], key: string | undefined): number {
  const chosen = key === undefined ? -1 : nav.findIndex((entry) => slashNavKey(entry) === key);
  if (chosen >= 0) {
    return chosen;
  }
  const first = nav.findIndex((entry) => isSlashNavEnabled(entry));
  return first < 0 ? 0 : first;
}

/** Arrows walk every row across the groups and wrap at both ends. */
export function stepSlashActive(count: number, current: number, step: number): number {
  return count > 0 ? (current + step + count) % count : 0;
}

export function withSlashKind(set: ReadonlySet<SlashKind>, kind: SlashKind, on: boolean): ReadonlySet<SlashKind> {
  const next = new Set(set);
  if (on) {
    next.add(kind);
  } else {
    next.delete(kind);
  }
  return next;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}
