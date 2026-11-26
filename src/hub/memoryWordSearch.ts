/**
 * Members' memory search by words, without a model (the User, 2026-11-26:
 * memory must get as much better as it can without a key). A note is found
 * when it has any of the words asked, not all of them; a word counts in its
 * other forms, the same way for every language (sameWord); notes are ranked
 * by how well they match (BM25), and each comes with the passage where it
 * matched, so a member need not open every note to see whether it is the one.
 *
 * Pure functions: the server picks the candidates (the notes the member sees
 * that hold any anchor) and ranks them here, on the text as the server keeps
 * it for search (search_text: title, tags and body, lower case).
 */

/** At most this many different words are looked for: a member is asked to
 *  give synonyms and translations, so more than a phrase's worth. */
export const MEMORY_SEARCH_MAX_WORDS = 32;
/** How long the passage given with a note is, at most, "…" marks included. */
export const MEMORY_SNIPPET_MAX_CHARS = 220;
/** A match in the title counts as this many matches in the body. */
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
/** A word asked found inside a longer word ("session" in "sqliteSession",
 *  "phone" in "telephone") counts this much; only for words of 5 letters or more. */
const INSIDE_WEIGHT = 0.5;
const INSIDE_MIN_LETTERS = 5;
/** A word held by more than this share of the notes says little: a note
 *  holding only such words is left out, unless every word asked is one. */
const COMMON_SHARE = 0.5;
/** BM25's usual constants. */
const K1 = 1.2;
const B = 0.75;

/** Letters with their marks (Hindi vowel signs, combining accents) and digits. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
/** Scripts written without spaces between words: a word asked there is found
 *  anywhere in the text, as the old search did. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Lower case by the language's own rules, as the server keeps search_text. */
export function lowerForSearch(text: string): string {
  return text.toLocaleLowerCase();
}

export interface SearchWord {
  /** The word as asked, in lower case. */
  word: string;
  /** Its first letters: every form it matches holds them (the server's
   *  candidates are the notes holding any anchor). */
  anchor: string;
  /** In a script without spaces: found anywhere in the text. */
  anywhere: boolean;
  /** Too short to tell much (two letters): not used to pick candidates when
   *  longer words are asked. */
  short: boolean;
}

function letters(text: string): string[] {
  return [...text];
}

/**
 * Whether two words are forms of one another, the same rule for every
 * language: the shorter one (of 3 or 4 letters) starts the longer one ("test"
 * and "tests", "ключ" and "ключи"); when the shorter has 5 letters they share
 * the first 4 ("ветка" and "ветку"); longer ones share the first 5 ("deploy"
 * and "deployment", "заметка" and "заметку"). Words of 2 letters only match
 * themselves.
 */
export function sameWord(left: string, right: string): boolean {
  if (left === right) return true;
  // Counted in UTF-16 units: letters outside the basic plane are rare in
  // words, and this runs for every occurrence of an anchor in every note.
  const shorter = Math.min(left.length, right.length);
  if (shorter < 3) return false;
  const need = shorter <= 4 ? shorter : shorter === 5 ? 4 : 5;
  return left.startsWith(right.slice(0, need)) && left.length >= need;
}

/** The words a query asks for, in its order, without repeats: of two forms
 *  of one word the shorter is kept (it finds the other's forms too). */
export function searchWords(query: string): SearchWord[] {
  const words: SearchWord[] = [];
  for (const word of lowerForSearch(query).match(WORD) ?? []) {
    const anywhere = NO_SPACES.test(word);
    const length = letters(word).length;
    if (length < (anywhere ? 1 : 2)) continue;
    const same = words.findIndex((item) => item.anywhere === anywhere && (anywhere ? item.word === word : sameWord(item.word, word)));
    if (same >= 0) {
      if (length < letters(words[same].word).length) words[same] = searchWord(word, anywhere);
      continue;
    }
    if (words.length >= MEMORY_SEARCH_MAX_WORDS) break;
    words.push(searchWord(word, anywhere));
  }
  return words;
}

function searchWord(word: string, anywhere: boolean): SearchWord {
  const length = letters(word).length;
  return { word, anchor: anywhere ? word : letters(word).slice(0, 3).join(""), anywhere, short: anywhere ? length < 2 : length < 3 };
}

/** The anchors the server picks candidates by: the short words' only when
 *  nothing longer is asked (a two-letter word is in nearly every note). */
export function candidateAnchors(words: readonly SearchWord[]): string[] {
  const long = words.filter((item) => !item.short);
  return [...new Set((long.length ? long : words).map((item) => item.anchor))];
}

/** Where a word asked is found in a text (lower case): at a word's start as
 *  one of its forms, or (weighing less) inside a longer word. */
function findWord(text: string, asked: SearchWord, found: (at: number, end: number, weight: number) => void): void {
  if (asked.anywhere) {
    for (let at = text.indexOf(asked.word); at >= 0; at = text.indexOf(asked.word, at + asked.word.length)) found(at, at + asked.word.length, 1);
    return;
  }
  const inside = letters(asked.word).length >= INSIDE_MIN_LETTERS;
  for (let at = text.indexOf(asked.anchor); at >= 0; at = text.indexOf(asked.anchor, at + 1)) {
    if (startsWord(text, at)) {
      const end = wordEnd(text, at);
      if (sameWord(asked.word, text.slice(at, end))) found(at, end, 1);
      at = Math.max(at, end - 1);
    } else if (inside && text.startsWith(asked.word, at)) {
      found(at, at + asked.word.length, INSIDE_WEIGHT);
      at += asked.word.length - 1;
    }
  }
}

function startsWord(text: string, at: number): boolean {
  if (at <= 0) return true;
  let before = at - 1;
  // A low surrogate: the character before is the whole pair.
  if (isLowSurrogate(text.charCodeAt(before)) && before > 0) before -= 1;
  return !WORD_CHAR.test(String.fromCodePoint(text.codePointAt(before) ?? 0));
}

const REST_OF_WORD = /[\p{L}\p{M}\p{N}]*/uy;

function wordEnd(text: string, at: number): number {
  REST_OF_WORD.lastIndex = at;
  REST_OF_WORD.exec(text);
  return Math.max(at, REST_OF_WORD.lastIndex);
}

export interface WordSearchNote {
  /** search_text as the server keeps it: title, tags and body, lower case,
   *  one line each for the title and the tags. */
  searchText: string;
}

export interface WordSearchCorpus {
  /** Notes the search is over (the member sees, the filters keep). */
  total: number;
  /** Their average search_text length in characters. */
  averageLength: number;
}

export interface RankedNote<T> {
  note: T;
  score: number;
}

/**
 * Ranks the candidates by BM25 over the words asked. A word's weight comes
 * from how many candidates hold it, which is how many of all the notes do:
 * a note without a word's anchor is never a candidate. A note holding only
 * words most notes hold is left out, unless every word asked is one.
 */
export function rankByWords<T extends WordSearchNote>(candidates: readonly T[], words: readonly SearchWord[], corpus: WordSearchCorpus): Array<RankedNote<T>> {
  return rankCounted(candidates.map((note) => ({ note, counts: wordCounts(note.searchText, words) })), words, corpus);
}

/** rankByWords with each note's counts (wordCounts) taken beforehand, a few
 *  notes at a time, so a server never stops answering while it counts. */
export function rankCounted<T extends WordSearchNote>(counted: ReadonlyArray<{ note: T; counts: number[] }>, words: readonly SearchWord[], corpus: WordSearchCorpus): Array<RankedNote<T>> {
  if (!words.length) return [];
  const holding = words.map((_, index) => counted.filter((item) => item.counts[index] > 0).length);
  const total = Math.max(corpus.total, counted.length, 1);
  const average = corpus.averageLength > 0 ? corpus.averageLength : Math.max(1, counted.reduce((sum, item) => sum + item.note.searchText.length, 0) / Math.max(1, counted.length));
  const telling = holding.map((held) => total < 4 || held <= total * COMMON_SHARE);
  const anyTelling = words.some((_, index) => telling[index] && holding[index] > 0);
  const ranked: Array<RankedNote<T>> = [];
  for (const { note, counts } of counted) {
    const length = note.searchText.length;
    let score = 0;
    let tells = false;
    counts.forEach((count, index) => {
      if (count <= 0) return;
      const df = holding[index];
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * (count * (K1 + 1)) / (count + K1 * (1 - B + B * length / average));
      if (telling[index]) tells = true;
    });
    if (score > 0 && (tells || !anyTelling)) ranked.push({ note, score });
  }
  return ranked.sort((left, right) => right.score - left.score);
}

/** How often each word asked occurs, matches in the title and tags weighing more. */
export function wordCounts(searchText: string, words: readonly SearchWord[]): number[] {
  const titleEnd = searchText.indexOf("\n");
  const tagsEnd = titleEnd < 0 ? -1 : searchText.indexOf("\n", titleEnd + 1);
  const weightAt = (at: number) => titleEnd < 0 ? 1 : at < titleEnd ? TITLE_WEIGHT : tagsEnd < 0 || at < tagsEnd ? TAG_WEIGHT : 1;
  return words.map((asked) => {
    let count = 0;
    findWord(searchText, asked, (at, _end, weight) => { count += weight * weightAt(at); });
    return count;
  });
}

/** search_text for a note, as the server keeps it. */
export function searchTextOf(fields: { title: string; tags: readonly string[]; body: string }): string {
  return lowerForSearch(`${fields.title}\n${fields.tags.join(" ")}\n${fields.body}`);
}

/**
 * The passage of a note's body where most of the words asked are found close
 * together, at most MEMORY_SNIPPET_MAX_CHARS long ("…" marks included), cut at
 * word edges and never inside a character. The body's start when no word
 * asked is in the body (the title or a tag matched).
 */
export function snippetOf(body: string, words: readonly SearchWord[], maxChars = MEMORY_SNIPPET_MAX_CHARS): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const room = Math.max(20, maxChars - 2);
  const lowered = lowerForSearch(flat);
  const hits: Array<{ at: number; end: number; word: number }> = [];
  if (lowered.length === flat.length) {
    words.forEach((asked, index) => findWord(lowered, asked, (at, end) => hits.push({ at, end, word: index })));
  } else {
    // Lower case changed the text's length (İ): look word by word.
    for (const match of flat.matchAll(WORD)) {
      const at = match.index ?? 0;
      const lower = lowerForSearch(match[0]);
      const index = words.findIndex((asked) => asked.anywhere ? lower.includes(asked.word) : sameWord(asked.word, lower));
      if (index >= 0) hits.push({ at, end: at + match[0].length, word: index });
    }
  }
  if (!hits.length) return cut(flat, 0, room);
  hits.sort((left, right) => left.at - right.at);
  // The window starting at a hit that covers the most different words asked
  // (the earliest such one).
  let best = { from: hits[0].at, distinct: 0, count: 0 };
  for (let first = 0; first < hits.length; first += 1) {
    const seen = new Set<number>();
    let count = 0;
    for (let next = first; next < hits.length && hits[next].end - hits[first].at <= room; next += 1) {
      seen.add(hits[next].word);
      count += 1;
    }
    if (seen.size > best.distinct || (seen.size === best.distinct && count > best.count)) best = { from: hits[first].at, distinct: seen.size, count };
  }
  // A little of what comes before the first hit, so it reads as a sentence.
  const lead = Math.min(60, Math.floor(room / 4));
  return cut(flat, Math.max(0, best.from - lead), room);
}

function cut(text: string, from: number, room: number): string {
  let start = from;
  if (start > 0) {
    // Start at the beginning of a word (or of a sentence close by).
    const sentence = text.lastIndexOf(". ", start);
    if (sentence >= 0 && start - sentence <= 40) start = sentence + 2;
    else while (start < text.length && !startsWord(text, start)) start += 1;
  }
  let end = Math.min(text.length, start + room);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + room / 2) end = space;
  }
  // Never half of a character (a surrogate pair).
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  if (end < text.length && end > start && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  const piece = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${piece}${end < text.length ? "…" : ""}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
