/**
 * Prints of meaning (embeddings) as the User's server keeps them: what text
 * a note or a message is printed from, cut into passages, and the prints
 * shortened and stored as one signed byte per number.
 *
 * Measured on the User's own notes (59 notes, 37 queries, 2026-11-26) with
 * OpenAI text-embedding-3-small: full prints of 1200-character passages put
 * the right note in the first three for every query; prints cut to 512
 * numbers did for 95%, and a byte per number changed nothing. Notes are few
 * and keep full prints; messages are many (about 21 thousand on the User's
 * server) and keep 512, about 12 MB in memory.
 */

export const EMBEDDING_MODEL = "text-embedding-3-small";
/** What the model gives (prints are asked whole and cut here). */
export const EMBEDDING_DIMS = 1536;
export const NOTE_DIMS = 1536;
export const MESSAGE_DIMS = 512;
export const NOTE_PASSAGE_CHARS = 1200;
export const MESSAGE_PASSAGE_CHARS = 1500;
/** A longer message is printed only this far (what is past it is still
 *  found by its words). */
export const MESSAGE_MAX_PASSAGES = 8;
/** What a query or a message to pick notes for is printed from, at most
 *  (under the model's 8191 tokens even for text of a token per character). */
export const QUERY_MAX_CHARS = 6000;

export type SemanticKind = "note" | "message";

/** One passage's place in its text. */
export interface PassageRange {
  start: number;
  end: number;
}

/** A shortened print: one signed byte per number and its length. */
export interface StoredPrint {
  values: Int8Array;
  norm: number;
}

/**
 * Cuts text into passages of at most `size` characters, ending each at a
 * line or a space in its last fifth when there is one, never inside a
 * character. An empty text is one empty passage.
 */
export function passageRanges(text: string, size: number, max = Number.POSITIVE_INFINITY): PassageRange[] {
  const ranges: PassageRange[] = [];
  let start = 0;
  while (start < text.length && ranges.length < max) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const window = text.slice(start + Math.floor(size * 0.8), end);
      const line = window.lastIndexOf("\n");
      const space = line >= 0 ? line : Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
      if (space >= 0) end = start + Math.floor(size * 0.8) + space + 1;
      // Never between the two halves of one character.
      if (end < text.length && isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    }
    ranges.push({ start, end });
    start = end;
  }
  return ranges.length ? ranges : [{ start: 0, end: 0 }];
}

/** What a note is printed from: its title and tags with each passage of its body. */
export function notePassages(note: { title: string; tags: string[]; body: string }): { texts: string[]; ranges: PassageRange[] } {
  const head = `${note.title}\n${note.tags.join(" ")}`;
  const ranges = passageRanges(note.body, NOTE_PASSAGE_CHARS);
  return { texts: ranges.map((range) => `${head}\n${note.body.slice(range.start, range.end)}`.trim()), ranges };
}

/** What a message is printed from: its passages, up to a limit. */
export function messagePassages(content: string): { texts: string[]; ranges: PassageRange[] } {
  const ranges = passageRanges(content, MESSAGE_PASSAGE_CHARS, MESSAGE_MAX_PASSAGES).filter((range) => content.slice(range.start, range.end).trim());
  return { texts: ranges.map((range) => content.slice(range.start, range.end)), ranges };
}

/** The first `dims` numbers of a print, one signed byte each. */
export function shortenPrint(print: ArrayLike<number>, dims: number): Int8Array {
  const length = Math.min(dims, print.length);
  let max = 0;
  for (let index = 0; index < length; index += 1) max = Math.max(max, Math.abs(print[index]));
  const values = new Int8Array(length);
  if (max === 0) return values;
  for (let index = 0; index < length; index += 1) values[index] = Math.round((print[index] / max) * 127);
  return values;
}

export function storedPrint(values: Int8Array): StoredPrint {
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) sum += values[index] * values[index];
  return { values, norm: Math.sqrt(sum) };
}

/** A query's print cut to `dims` numbers and made of length one. */
export function queryPrint(print: ArrayLike<number>, dims: number): Float32Array {
  const length = Math.min(dims, print.length);
  const values = new Float32Array(length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    values[index] = print[index];
    sum += print[index] * print[index];
  }
  const norm = Math.sqrt(sum) || 1;
  for (let index = 0; index < length; index += 1) values[index] /= norm;
  return values;
}

/** How close a passage is to a query (cosine; the query is of length one). */
export function closeness(query: Float32Array, print: StoredPrint): number {
  if (!print.norm || query.length !== print.values.length) return 0;
  let sum = 0;
  const values = print.values;
  for (let index = 0; index < values.length; index += 1) sum += query[index] * values[index];
  return sum / print.norm;
}

export function encodePrint(values: Int8Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64");
}

export function decodePrint(text: string, dims: number): Int8Array | undefined {
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== dims) return undefined;
  return new Int8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** What a message must be to be printed and found: a line of the User's or
 *  a member's finished reply, shown in the chat, with text in it. */
export function printableMessage(message: { role?: unknown; status?: unknown; content?: unknown; metadata?: { hiddenFromTimeline?: unknown } | null }): message is { role: "user" | "participant"; content: string } {
  if (message.role !== "user" && message.role !== "participant") return false;
  if (message.role === "participant" && message.status !== "done") return false;
  if (message.metadata?.hiddenFromTimeline === true) return false;
  return typeof message.content === "string" && message.content.trim().length > 1;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
