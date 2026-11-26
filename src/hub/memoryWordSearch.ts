/**
 * Members' memory search by words, without a model (the User, 2026-11-26:
 * memory must get as much better as it can without a key). A note is found
 * when it has any of the words asked, not all of them; a word counts in any
 * of its forms (its first five letters, the same way for every language); notes
 * are ranked by how well they match (BM25), and each comes with the passage
 * where it matched, so a member need not open every note to see whether it
 * is the one.
 *
 * Pure functions: the server picks the candidates (the notes the member sees
 * that hold any of the stems) and ranks them here.
 */

/** A word is told by its first letters: "декларация" and "декларации",
 *  "deploy" and "deployment" are the same word. */
const STEM_CHARS = 5;
/** Shorter words ("a", "и") say nothing about a note. */
const MIN_WORD_CHARS = 2;
/** At most this many different words are looked for: a member is asked to
 *  give synonyms and translations, so more than a phrase's worth. */
export const MEMORY_SEARCH_MAX_STEMS = 32;
/** A match in the title counts as this many matches in the body. */
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
/** Notes scoring under this share of the best one are left out: they hold
 *  only a common word or two ("не", "for") and would bury the list. On the
 *  User's notes this never dropped a right answer. */
const MIN_SHARE_OF_BEST = 0.15;
/** BM25's usual constants. */
const K1 = 1.2;
const B = 0.75;
/** How long the passage given with a note is, at most. */
export const MEMORY_SNIPPET_MAX_CHARS = 220;

const WORD = /[\p{L}\p{N}]+/gu;

/** Lower case by the language's own rules, as the server keeps search_text. */
function lower(text: string): string {
  return text.toLocaleLowerCase();
}

function stemOf(word: string): string {
  const letters = [...word];
  return letters.length > STEM_CHARS ? letters.slice(0, STEM_CHARS).join("") : word;
}

/** The stems a query asks for, in its order, without repeats. */
export function searchStems(query: string): string[] {
  const stems: string[] = [];
  for (const word of lower(query).match(WORD) ?? []) {
    if ([...word].length < MIN_WORD_CHARS) continue;
    const stem = stemOf(word);
    if (!stems.includes(stem)) stems.push(stem);
    if (stems.length >= MEMORY_SEARCH_MAX_STEMS) break;
  }
  return stems;
}

/** The stem asked that a word of a note is a form of, if any. (A short word
 *  asked is not matched as the start of longer ones: "key" would find
 *  "keyboard"; measured on the User's notes, that found less, not more.) */
function matchingStem(word: string, stems: readonly string[]): string | undefined {
  const stem = stemOf(word);
  return stems.includes(stem) ? stem : undefined;
}

export interface WordSearchNote {
  title: string;
  tags: readonly string[];
  body: string;
}

export interface WordSearchCorpus {
  /** Notes the search is over (the member sees, the filters keep). */
  total: number;
  /** Their average length in characters (title, tags and body). */
  averageLength: number;
}

export interface RankedNote<T> {
  note: T;
  score: number;
}

/**
 * Ranks the candidates (every note holding any stem; the others score 0) by
 * BM25 over stems. A word's weight comes from how many candidates hold it,
 * which is exactly how many of all the notes do: a note without the stem in
 * its text is never a candidate.
 */
export function rankByWords<T extends WordSearchNote>(candidates: readonly T[], stems: readonly string[], corpus: WordSearchCorpus): Array<RankedNote<T>> {
  if (!stems.length) return [];
  const counted = candidates.map((note) => ({ note, counts: stemCounts(note, stems), length: noteLength(note) }));
  const holding = new Map<string, number>();
  for (const { counts } of counted) for (const stem of counts.keys()) holding.set(stem, (holding.get(stem) ?? 0) + 1);
  const total = Math.max(corpus.total, candidates.length, 1);
  const average = corpus.averageLength > 0 ? corpus.averageLength : Math.max(1, counted.reduce((sum, item) => sum + item.length, 0) / Math.max(1, counted.length));
  const ranked: Array<RankedNote<T>> = [];
  for (const { note, counts, length } of counted) {
    let score = 0;
    for (const [stem, count] of counts) {
      const df = holding.get(stem) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * (count * (K1 + 1)) / (count + K1 * (1 - B + B * length / average));
    }
    if (score > 0) ranked.push({ note, score });
  }
  ranked.sort((left, right) => right.score - left.score);
  const best = ranked[0]?.score ?? 0;
  return ranked.filter((item) => item.score >= best * MIN_SHARE_OF_BEST);
}

/** How often each stem occurs in a note, matches in the title and tags weighing more. */
function stemCounts(note: WordSearchNote, stems: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const word of lower(text).match(WORD) ?? []) {
      const stem = matchingStem(word, stems);
      if (stem) counts.set(stem, (counts.get(stem) ?? 0) + weight);
    }
  };
  add(note.title, TITLE_WEIGHT);
  add(note.tags.join(" "), TAG_WEIGHT);
  add(note.body, 1);
  return counts;
}

/** A note's length as search_text has it (title, tags and body). */
export function noteLength(note: WordSearchNote): number {
  return note.title.length + 1 + note.tags.join(" ").length + 1 + note.body.length;
}

/**
 * The passage of a note's body where most of the words asked are found close
 * together, at most MEMORY_SNIPPET_MAX_CHARS long, cut at word edges and
 * marked with … where it was cut. The body's start when no word asked is in
 * the body (the title or a tag matched).
 */
export function snippetOf(body: string, stems: readonly string[], maxChars = MEMORY_SNIPPET_MAX_CHARS): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const hits: Array<{ at: number; end: number; stem: string }> = [];
  for (const match of flat.matchAll(WORD)) {
    const stem = matchingStem(lower(match[0]), stems);
    if (stem) hits.push({ at: match.index ?? 0, end: (match.index ?? 0) + match[0].length, stem });
  }
  if (!hits.length) return cut(flat, 0, maxChars);
  // The window starting at a hit that covers the most different stems (the
  // earliest such one).
  let best = { from: hits[0].at, distinct: 0, count: 0 };
  for (let first = 0; first < hits.length; first += 1) {
    const seen = new Set<string>();
    let count = 0;
    for (let next = first; next < hits.length && hits[next].end - hits[first].at <= maxChars; next += 1) {
      seen.add(hits[next].stem);
      count += 1;
    }
    if (seen.size > best.distinct || (seen.size === best.distinct && count > best.count)) best = { from: hits[first].at, distinct: seen.size, count };
  }
  // A little of what comes before the first hit, so it reads as a sentence.
  const lead = Math.min(60, Math.floor(maxChars / 4));
  return cut(flat, Math.max(0, best.from - lead), maxChars);
}

function cut(text: string, from: number, maxChars: number): string {
  let start = from;
  if (start > 0) {
    // Start at the beginning of a word (or of a sentence close by).
    const sentence = text.lastIndexOf(". ", start);
    if (sentence >= 0 && start - sentence <= 40) start = sentence + 2;
    else while (start < text.length && /[\p{L}\p{N}]/u.test(text[start - 1])) start += 1;
  }
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + maxChars / 2) end = space;
  }
  const piece = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${piece}${end < text.length ? "…" : ""}`;
}
