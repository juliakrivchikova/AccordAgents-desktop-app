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

import { isInferredParticipantRequestCarrier } from "../../shared/chatParticipantRequestThreads";
import { isChatMessageHiddenFromTimeline } from "../../shared/chatTimelineVisibility";
import { chatMessageMemberText } from "../../shared/interimPosts";
import { MEMORY_PICK_TEXT_MAX_CHARS } from "../../shared/memory";
import type { ChatMessage } from "../../shared/types";

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
/** What of a message is printed at most (the same on every path, so a
 *  print made as it came and one made catching up are told the same). */
export const MESSAGE_MAX_CHARS = MESSAGE_PASSAGE_CHARS * MESSAGE_MAX_PASSAGES;
/** What a query or a message to pick notes for is printed from, at most
 *  (under the model's 8191 tokens even for text of a token per character). */
export const QUERY_MAX_CHARS = MEMORY_PICK_TEXT_MAX_CHARS;
/** What of a message's text and of each of its posts is read to print it,
 *  at most, and how many posts: the same on every path (as it comes, and
 *  read back from the database a page at a time), so both print it alike.
 *  More than is printed, so cutting never changes what is printed. */
export const PRINT_SOURCE_CHARS = MESSAGE_MAX_CHARS + 1000;
export const PRINT_SOURCE_POSTS = 32;

export type SemanticKind = "note" | "message";

/** One passage's place in its text. */
export interface PassageRange {
  start: number;
  end: number;
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
export function messagePassages(whole: string): { texts: string[]; ranges: PassageRange[] } {
  const content = whole.slice(0, MESSAGE_MAX_CHARS);
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

export function encodePrint(values: Int8Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64");
}

export function decodePrint(text: string, dims: number): Int8Array | undefined {
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== dims) return undefined;
  // A view (the arena copies it; no allocation per print while loading).
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Two rankings of the same things merged: one of each in turn, the first
 * ranking leading, each thing once. Measured on the User's notes
 * (2026-11-26): meaning first then words buried exact names and ids (the
 * right note in the first five for 82% of such queries); taking turns put
 * it there for all of them, and kept the first place of every query by
 * meaning (sums of scores and reciprocal ranks lost it for a third).
 */
export function takeTurns<T>(first: readonly T[], second: readonly T[], keyOf: (item: T) => string): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    for (const item of [first[index], second[index]]) {
      if (item === undefined) continue;
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/** A message as the server reads it to print it. */
export type PrintableMessageFields = Pick<ChatMessage, "role" | "content"> & { status?: unknown; metadata?: ChatMessage["metadata"] | null };

/**
 * The text a message is printed and found by, or nothing: a line of the
 * User's or a member's finished reply, shown in the chat (as the chat shows
 * it: what it hides is not found), with its posts made during the turn.
 * A request carrier written for another member is left out: the chat shows
 * it under the message that asked, which is found itself.
 */
export function printableText(message: PrintableMessageFields): string | undefined {
  if (message.role !== "user" && message.role !== "participant") return undefined;
  if (message.role === "participant" && message.status !== "done") return undefined;
  if (typeof message.content !== "string") return undefined;
  const posts = message.metadata?.interimPosts as unknown;
  const metadata = message.metadata
    ? {
      ...message.metadata,
      ...(Array.isArray(posts) ? {
        interimPosts: posts.slice(0, PRINT_SOURCE_POSTS).map((post: unknown) =>
          post && typeof post === "object" && typeof (post as { content?: unknown }).content === "string"
            ? { ...post, content: (post as { content: string }).content.slice(0, PRINT_SOURCE_CHARS) }
            : post)
      } : {})
    } as ChatMessage["metadata"]
    : undefined;
  const fields = { role: message.role, content: message.content.slice(0, PRINT_SOURCE_CHARS), metadata };
  if (isChatMessageHiddenFromTimeline(fields) || isInferredParticipantRequestCarrier(fields)) return undefined;
  const text = chatMessageMemberText(fields);
  return text.trim().length > 1 ? text : undefined;
}

/**
 * Prints of one length kept side by side in big blocks, with their lengths:
 * one allocation per few thousand prints, not one per print (the User's
 * server has 512 MB; about 30 thousand passages of messages). A slot freed
 * is used again; `compactInto` copies the live ones into a fresh arena.
 */
export class PrintArena {
  private chunks: Int8Array[] = [];
  private norms: Float32Array[] = [];
  private free: number[] = [];
  private next = 0;

  constructor(readonly dims: number, private readonly perChunk = 2048) {}

  /** Prints held. */
  get size(): number {
    return this.next - this.free.length;
  }

  /** Slots allocated (held or free). */
  get capacity(): number {
    return this.chunks.length * this.perChunk;
  }

  add(values: ArrayLike<number>): number {
    const slot = this.free.pop() ?? this.next++;
    const chunk = Math.floor(slot / this.perChunk);
    while (this.chunks.length <= chunk) {
      this.chunks.push(new Int8Array(this.dims * this.perChunk));
      this.norms.push(new Float32Array(this.perChunk));
    }
    const target = this.chunks[chunk];
    const offset = (slot % this.perChunk) * this.dims;
    let sum = 0;
    for (let index = 0; index < this.dims; index += 1) {
      const value = index < values.length ? values[index] : 0;
      target[offset + index] = value;
      sum += value * value;
    }
    this.norms[chunk][slot % this.perChunk] = Math.sqrt(sum);
    return slot;
  }

  release(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.next) return;
    this.norms[Math.floor(slot / this.perChunk)][slot % this.perChunk] = 0;
    this.free.push(slot);
  }

  /** How close a print is to a query of this length and of length one (cosine). */
  closeness(query: Float32Array, slot: number): number {
    const chunk = Math.floor(slot / this.perChunk);
    const norm = this.norms[chunk][slot % this.perChunk];
    if (!norm || query.length !== this.dims) return 0;
    const values = this.chunks[chunk];
    const offset = (slot % this.perChunk) * this.dims;
    let sum = 0;
    for (let index = 0; index < this.dims; index += 1) sum += query[index] * values[offset + index];
    return sum / norm;
  }

  /** The print in a slot, copied into another arena; its new slot. */
  copyTo(slot: number, other: PrintArena): number {
    const offset = (slot % this.perChunk) * this.dims;
    return other.add(this.chunks[Math.floor(slot / this.perChunk)].subarray(offset, offset + this.dims));
  }

  /** Whether more than half the slots stand free (worth compacting). */
  sparse(): boolean {
    return this.capacity > this.perChunk && this.free.length * 2 > this.capacity;
  }

  clear(): void {
    this.chunks = [];
    this.norms = [];
    this.free = [];
    this.next = 0;
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
