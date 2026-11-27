/**
 * Members' memory ranked with the asking chat's own notes first (the User,
 * 2026-11-27): at similar relevance a note of the chat's project, of the
 * member's role or of the chat itself comes before a global one, while a
 * global note that fits clearly better still leads. A global note of another
 * project's work (filed globally because it could not be filed under that
 * project) otherwise came first in every project.
 *
 * Tuned on the User's 113 notes (~/reference/memory-search-eval/scripts/
 * project.mjs, 2026-11-27): another project's global runbook led "выпуск
 * беты через GitHub Actions" by 0.012 in closeness, while a global
 * preference that must win ("no release while a question is open") led the
 * chat's own note by 0.036; a lead of 0.03 fixes the first and keeps the
 * second (0.04 and more lost it). Words: 1.5 kept another project's note out
 * of the first three for more queries than 1.25 and changed nothing else.
 */

/** A note's own place: its chat's project, the member's role or the chat
 *  (a member sees only those of its own), as against a global note. */
export interface PlacedScore<T> {
  item: T;
  /** Closeness in meaning, or a word score. */
  score: number;
  /** The note is the asking chat's own (not global). */
  near: boolean;
}

/** How much closer in meaning a global note must be to come before one of
 *  the chat's own (closeness of prints of 1536 numbers). */
export const NEAR_MEANING_LEAD = 0.03;
/** How many times the word score of a global note must be higher to come
 *  before one of the chat's own (BM25). */
export const NEAR_WORDS_FACTOR = 1.5;

/** What a score counts for once the chat's own notes are given their lead. */
export function placedScore(score: number, near: boolean, by: "meaning" | "words"): number {
  if (!near) return score;
  return by === "meaning" ? score + NEAR_MEANING_LEAD : score * NEAR_WORDS_FACTOR;
}

/** The items best first, the chat's own given their lead; equal ones keep
 *  the order they came in. */
export function nearFirst<T>(scored: ReadonlyArray<PlacedScore<T>>, by: "meaning" | "words"): T[] {
  return scored
    .map((entry, index) => ({ entry, index, placed: placedScore(entry.score, entry.near, by) }))
    .sort((left, right) => right.placed - left.placed || left.index - right.index)
    .map(({ entry }) => entry.item);
}

/**
 * Notes for a message: each close enough by itself (`min`, never lowered for
 * the chat's own), and close to the best once the chat's own are given their
 * lead (`gap`); best first, at most `max`, none `skip` leaves out (counted
 * for the best all the same, as before).
 */
export function pickedNearFirst<T>(
  scored: ReadonlyArray<PlacedScore<T>>,
  rule: { min: number; gap: number; max: number },
  skip: (item: T) => boolean = () => false
): Array<PlacedScore<T>> {
  const placed = scored
    .map((entry, index) => ({ entry, index, placed: placedScore(entry.score, entry.near, "meaning") }))
    .sort((left, right) => right.placed - left.placed || left.index - right.index);
  const best = placed[0]?.placed ?? 0;
  return placed
    .filter(({ entry, placed: value }) => entry.score >= rule.min && value >= best - rule.gap && !skip(entry.item))
    .slice(0, rule.max)
    .map(({ entry }) => entry);
}
