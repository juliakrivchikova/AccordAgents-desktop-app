import { createHash } from "node:crypto";
import type { StorageService } from "../../main/services/storage";
import type { SemanticSettingsView } from "../../shared/memory";
import type { ChatMessage } from "../../shared/types";
import { EMBED_BATCH_INPUTS, EmbeddingError, OpenAiEmbeddings } from "./openAiEmbeddings";
import {
  EMBEDDING_MODEL, MESSAGE_DIMS, NOTE_DIMS, PRINT_SOURCE_CHARS, PRINT_SOURCE_POSTS, PrintArena, QUERY_MAX_CHARS, decodePrint, encodePrint, messagePassages, notePassages,
  printableText, queryPrint, shortenPrint, type PrintableMessageFields, type SemanticKind
} from "./semanticVectors";

/** Where the User's OpenAI key lives on her server (hub_documents), like the
 *  Telegram token for alerts: the server searches, so the server holds it. */
const SETTINGS_DOCUMENT = "semantic-search";
const KEY_FORMAT = /^sk-[A-Za-z0-9_-]{20,300}$/;

const SCHEMA_SQL = `
  create table if not exists semantic_prints (
    kind text not null,
    scope_id text not null,
    item_id text not null,
    part integer not null,
    hash text not null,
    print text not null,
    primary key (kind, scope_id, item_id, part)
  );
`;

/** Rows read at once (prints, messages): no answer of the database grows
 *  past a megabyte or two, whatever the server holds. */
const LOAD_PAGE = 1000;
const MESSAGE_PAGE = 100;
const NOTE_PAGE = 50;
const QUERY_CACHE_SIZE = 64;
/** Between requests while old notes and messages are printed: OpenAI's
 *  lowest tier allows about a million tokens a minute. */
const CATCH_UP_PAUSE_MS = 2_000;
const BATCH_TIMEOUT_MS = 30_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const SETTLE_MS = 1_500;
/** After a query OpenAI did not print (slow, down), queries go by words for
 *  this long: no member's turn waits on OpenAI again and again meanwhile. */
const QUERY_BACKOFF_MS = 30_000;

interface StoredSettings {
  version: 1;
  openAiKey?: string;
  keySetAt?: string;
  /** Why the key stopped working (OpenAI refused it, or no credit left). */
  keyError?: string;
}

/** A note's or a message's prints: the slots of its passages in an arena. */
interface Entry {
  hash: string;
  slots: number[];
}

interface Item {
  kind: SemanticKind;
  scopeId: string;
  itemId: string;
}

interface Job {
  kind: SemanticKind;
  scopeId: string;
  itemId: string;
  texts: string[];
  hash: string;
}

/** A note as it is printed (HubMemory gives them). */
export interface PrintableNote {
  id: string;
  title: string;
  tags: string[];
  body: string;
}

export interface NoteSource {
  /** Notes not archived, by id, after `afterId`. */
  notesPage(afterId: string, limit: number): Promise<PrintableNote[]>;
}

export interface MessageCloseness {
  conversationId: string;
  messageId: string;
  part: number;
  score: number;
}

export interface HubSemanticOptions {
  storage: StorageService;
  log?: (event: string, payload: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
  /** Local QA only: an OpenAI stand-in on this computer. */
  openAiBaseUrl?: string;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Search by meaning on the User's server: keeps a print of every memory note
 * and every chat message once the User gave her OpenAI key (Settings →
 * General), prints new ones as they come, and the old ones once in the
 * background. Without the key it holds nothing new and answers nothing:
 * search goes by words, as before.
 */
export class HubSemantic {
  private schemaReady?: Promise<void>;
  private settingsCache?: StoredSettings;
  private client?: OpenAiEmbeddings;
  /** Bumped whenever the key changes or the server closes: work started
   *  under an older one stops. */
  private generation = 0;
  /** Aborted when the generation changes: waits and requests of work for an
   *  older key end at once (a new key never waits behind them). */
  private generationAbort = new AbortController();
  /** The key the current generation uses (a refusal names it). */
  private clientKey?: string;
  /** Bumped whenever the prints held in memory are let go (the key removed
   *  or refused, the server closing): a load started before stops. */
  private epoch = 0;
  private loaded?: { epoch: number; promise: Promise<void>; done: boolean };
  /** Items forgotten while the prints kept are read (jobKey): not taken in. */
  private forgottenWhileLoading?: Set<string>;
  private readonly notes = new Map<string, Entry>();
  private readonly messages = new Map<string, Entry>();
  private noteArena = new PrintArena(NOTE_DIMS, 256);
  private messageArena = new PrintArena(MESSAGE_DIMS, 2048);
  private readonly pending = new Map<string, Job>();
  /** Jobs being printed now (jobKey), and those of them forgotten meanwhile:
   *  their prints are not kept. */
  private readonly inFlight = new Set<string>();
  private readonly superseded = new Set<string>();
  private draining?: Promise<void>;
  /** The key (generation) old notes and messages are being printed for. */
  private catchingUpFor?: number;
  private caughtUp = false;
  /** Every note is printed for this key (generation): notes can be picked. */
  private notesReadyFor?: number;
  private lastError?: string;
  private settleTimer?: NodeJS.Timeout;
  private readonly queryCache = new Map<string, number[]>();
  private queryBackoffUntil = 0;
  private noteSource?: NoteSource;
  private closing = new AbortController();
  private settingsQueue: Promise<unknown> = Promise.resolve();
  private starting?: Promise<void>;
  /** The background pass under way (close waits for it). */
  private catchingUpRun?: Promise<void>;

  constructor(private readonly options: HubSemanticOptions) {}

  private get log(): (event: string, payload: Record<string, unknown>) => void {
    return this.options.log ?? (() => undefined);
  }

  setNoteSource(source: NoteSource): void {
    this.noteSource = source;
  }

  /** Reads the key and, with one, the prints kept, then prints what is missing. */
  start(): Promise<void> {
    this.starting ??= (async () => {
      await this.init();
      const settings = await this.settings();
      if (settings.openAiKey && !settings.keyError && !this.closing.signal.aborted) this.enable(settings.openAiKey);
    })();
    return this.starting;
  }

  /** Stops, and waits for what is under way to stop: nothing reads or
   *  writes the database after it returns. */
  async close(): Promise<void> {
    this.nextGeneration();
    this.epoch += 1;
    this.closing.abort();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    await this.starting?.catch(() => undefined);
    await this.catchingUpRun?.catch(() => undefined);
    await this.draining?.catch(() => undefined);
  }

  /** Whether search by meaning is on (a key that works is given). */
  enabled(): boolean {
    return Boolean(this.client);
  }

  /** Whether notes can be picked for a message now: the key works, the
   *  prints kept are read, every note is printed, and OpenAI answers. */
  ready(): boolean {
    return Boolean(this.client) && this.loaded?.epoch === this.epoch && this.loaded.done &&
      this.notesReadyFor === this.generation && this.now().getTime() >= this.queryBackoffUntil;
  }

  // --- the key ----------------------------------------------------------------

  async view(): Promise<SemanticSettingsView> {
    const settings = await this.settings();
    return {
      keySet: Boolean(settings.openAiKey),
      ...(settings.keyError ? { keyError: settings.keyError } : {}),
      ...(settings.openAiKey && !settings.keyError ? {
        notesPrinted: this.notes.size,
        messagesPrinted: this.messages.size,
        catchingUp: !this.caughtUp,
        ...(this.lastError ? { lastError: this.lastError } : {})
      } : {})
    };
  }

  /** Checks the key with OpenAI, then keeps it. */
  async setKey(raw: unknown): Promise<{ ok: true; value: SemanticSettingsView } | { ok: false; message: string }> {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!KEY_FORMAT.test(key)) return { ok: false, message: "That doesn't look like an OpenAI API key. Copy the whole key, it starts with sk-." };
    await this.init();
    try {
      await new OpenAiEmbeddings(key, this.options.fetchImpl, this.options.openAiBaseUrl).embed(["test"], 15_000);
    } catch (error) {
      const message = error instanceof EmbeddingError ? error.message : "OpenAI could not be reached.";
      this.log("hub.semantic.key-refused", { message });
      return { ok: false, message };
    }
    await this.updateSettings((settings) => {
      settings.openAiKey = key;
      settings.keySetAt = this.now().toISOString();
      delete settings.keyError;
    });
    this.enable(key);
    this.log("hub.semantic.key-set", {});
    return { ok: true, value: await this.view() };
  }

  async removeKey(): Promise<SemanticSettingsView> {
    await this.init();
    await this.updateSettings((settings) => {
      delete settings.openAiKey;
      delete settings.keySetAt;
      delete settings.keyError;
    });
    this.disable();
    this.log("hub.semantic.key-removed", {});
    return this.view();
  }

  private nextGeneration(): void {
    this.generation += 1;
    this.generationAbort.abort();
    this.generationAbort = new AbortController();
  }

  private enable(key: string): void {
    this.nextGeneration();
    this.client = new OpenAiEmbeddings(key, this.options.fetchImpl, this.options.openAiBaseUrl);
    this.clientKey = key;
    this.lastError = undefined;
    this.caughtUp = false;
    this.queryBackoffUntil = 0;
    const run = this.keepCatchingUp(this.generation);
    this.catchingUpRun = run;
    void run.finally(() => {
      if (this.catchingUpRun === run) this.catchingUpRun = undefined;
    });
  }

  /** Off: nothing more is printed, and the prints held in memory are let go
   *  (they stay in the database for a key given again). */
  private disable(): void {
    this.nextGeneration();
    this.epoch += 1;
    this.client = undefined;
    this.clientKey = undefined;
    this.pending.clear();
    this.notes.clear();
    this.messages.clear();
    this.noteArena = new PrintArena(NOTE_DIMS, 256);
    this.messageArena = new PrintArena(MESSAGE_DIMS, 2048);
    this.loaded = undefined;
    this.forgottenWhileLoading = undefined;
    this.queryCache.clear();
    this.caughtUp = false;
    this.notesReadyFor = undefined;
  }

  /** OpenAI refused the key while printing: kept, said in Settings, unused. */
  private async keyRefused(error: EmbeddingError, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const refused = this.clientKey;
    this.disable();
    this.log("hub.semantic.key-stopped", { message: error.message });
    // Said of that key only: one given (or removed) meanwhile is not marked.
    await this.updateSettings((settings) => {
      if (refused && settings.openAiKey === refused) settings.keyError = error.message;
    }).catch(() => undefined);
  }

  // --- what is printed ----------------------------------------------------------

  /** A note was written or changed: printed again if its text changed. */
  noteChanged(note: PrintableNote): void {
    if (!this.client) return;
    const { texts } = notePassages(note);
    this.queue({ kind: "note", scopeId: "", itemId: note.id, texts, hash: hashOf(NOTE_DIMS, texts) });
  }

  /** A note is gone for good (the User deleted it in Settings). */
  noteRemoved(noteId: string): void {
    this.forget([{ kind: "note", scopeId: "", itemId: noteId }], true);
  }

  /** A chat message the server accepted (new, or changed). */
  messageChanged(conversationId: string, message: { id: string } & PrintableMessageFields): void {
    if (!this.client) return;
    const text = printableText(message);
    const { texts } = text ? messagePassages(text) : { texts: [] };
    if (!texts.length) {
      // Hidden or emptied: not found, and forgotten by the database too (it
      // may hold a print made for an older key). A member's reply still
      // running was never printed: nothing to forget at each of its updates.
      const running = message.role === "participant" && message.status === "pending";
      this.forget([{ kind: "message", scopeId: conversationId, itemId: message.id }], !running);
      return;
    }
    this.queue({ kind: "message", scopeId: conversationId, itemId: message.id, texts, hash: hashOf(MESSAGE_DIMS, texts) });
  }

  /** A message removed from a chat. */
  messageRemoved(conversationId: string, messageId: string): void {
    this.forget([{ kind: "message", scopeId: conversationId, itemId: messageId }], true);
  }

  /** A chat moved to the server as a whole: its messages are printed from
   *  the database a page at a time (thousands of them never wait at once). */
  chatImported(conversationId: string): void {
    if (!this.client) return;
    const generation = this.generation;
    void this.printMessages(generation, `and m.conversation_id = ${quote(conversationId)}`).catch((error: unknown) => {
      this.log("hub.semantic.import-failed", { message: messageOf(error) });
    });
  }

  /** A chat deleted: its messages are found no more. */
  chatRemoved(conversationId: string): void {
    const jobPrefix = jobKey("message", conversationId, "");
    for (const key of [...this.pending.keys()]) if (key.startsWith(jobPrefix)) this.pending.delete(key);
    for (const key of this.inFlight) if (key.startsWith(jobPrefix)) this.superseded.add(key);
    const prefix = messageKey(conversationId, "");
    for (const key of [...this.messages.keys()]) if (key.startsWith(prefix)) this.dropEntry("message", key);
    this.forgottenWhileLoading?.add(chatMarker(conversationId));
    void this.init().then(() => this.run(`delete from semantic_prints where kind = 'message' and scope_id = ${quote(conversationId)};`)).catch((error: unknown) => {
      this.log("hub.semantic.forget-failed", { message: messageOf(error) });
    });
  }

  /**
   * Items found no more: their queued and running prints are dropped and
   * their prints let go; the database forgets them too when it may hold
   * them (or always, for an item removed for good).
   */
  private forget(items: Item[], always: boolean): void {
    const stored: Item[] = [];
    for (const item of items) {
      const key = jobKey(item.kind, item.scopeId, item.itemId);
      this.pending.delete(key);
      const running = this.inFlight.has(key);
      if (running) this.superseded.add(key);
      this.forgottenWhileLoading?.add(key);
      const dropped = this.dropEntry(item.kind, item.kind === "note" ? item.itemId : messageKey(item.scopeId, item.itemId));
      if (always || dropped || running) stored.push(item);
    }
    if (!stored.length) return;
    void this.init().then(() => this.deletePrints(stored)).catch((error: unknown) => {
      this.log("hub.semantic.forget-failed", { message: messageOf(error) });
    });
  }

  /** Lets an entry's prints go; whether there was one. */
  private dropEntry(kind: SemanticKind, key: string): boolean {
    const map = kind === "note" ? this.notes : this.messages;
    const entry = map.get(key);
    if (!entry) return false;
    const arena = kind === "note" ? this.noteArena : this.messageArena;
    for (const slot of entry.slots) arena.release(slot);
    map.delete(key);
    return true;
  }

  /** Keeps an entry, letting go of the one it replaces. */
  private keepEntry(kind: SemanticKind, key: string, entry: Entry): void {
    this.dropEntry(kind, key);
    (kind === "note" ? this.notes : this.messages).set(key, entry);
  }

  private queue(job: Job): void {
    const key = jobKey(job.kind, job.scopeId, job.itemId);
    const kept = job.kind === "note" ? this.notes.get(job.itemId) : this.messages.get(messageKey(job.scopeId, job.itemId));
    if (kept?.hash === job.hash) {
      // Back to the text printed (an edit undone): a newer one queued or
      // being printed is not kept over it.
      this.pending.delete(key);
      if (this.inFlight.has(key)) this.superseded.add(key);
      return;
    }
    this.pending.set(key, job);
    // A moment for the rest of a burst (a reply and its edits) to arrive.
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      void this.drain(this.generation);
    }, SETTLE_MS);
    this.settleTimer.unref?.();
  }

  // --- finding -----------------------------------------------------------------

  /** A text's print, or nothing (no key, OpenAI did not answer in time). */
  async printQuery(text: string, timeoutMs: number): Promise<number[] | undefined> {
    const client = this.client;
    if (!client) return undefined;
    // The key this query is printed with: a refusal of it stops only it.
    const generation = this.generation;
    const input = text.slice(0, QUERY_MAX_CHARS).trim();
    if (!input) return undefined;
    const key = createHash("sha256").update(input).digest("hex");
    const cached = this.queryCache.get(key);
    if (this.now().getTime() < this.queryBackoffUntil && !cached) return undefined;
    try {
      const print = cached ?? (await client.embed([input], timeoutMs, this.closing.signal))[0];
      if (!this.client) return undefined;
      this.queryCache.delete(key);
      this.queryCache.set(key, print);
      if (this.queryCache.size > QUERY_CACHE_SIZE) this.queryCache.delete(this.queryCache.keys().next().value as string);
      await this.loadPrints();
      return print;
    } catch (error) {
      if (error instanceof EmbeddingError && error.kind === "key") await this.keyRefused(error, generation);
      else if (generation === this.generation) this.queryBackoffUntil = this.now().getTime() + QUERY_BACKOFF_MS;
      this.log("hub.semantic.query-failed", { message: messageOf(error) });
      return undefined;
    }
  }

  /** How close each named note is to a query: its closest passage. Notes not
   *  printed yet are absent. */
  noteCloseness(query: number[], noteIds: Iterable<string>): Map<string, { score: number; part: number }> {
    const asked = queryPrint(query, NOTE_DIMS);
    const scores = new Map<string, { score: number; part: number }>();
    for (const id of noteIds) {
      const entry = this.notes.get(id);
      if (!entry) continue;
      scores.set(id, best(this.noteArena, asked, entry));
    }
    return scores;
  }

  /** The messages of the given chats closest to a query, closest first. */
  async messageCloseness(query: number[], conversationIds: ReadonlySet<string>, limit: number): Promise<MessageCloseness[]> {
    const asked = queryPrint(query, MESSAGE_DIMS);
    // A compaction while waiting below moves the slots: counted again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found: MessageCloseness[] = [];
      let counted = 0;
      const arena = this.messageArena;
      let moved = false;
      for (const [key, entry] of [...this.messages]) {
        const split = key.indexOf("\n");
        const conversationId = key.slice(0, split);
        if (!conversationIds.has(conversationId)) continue;
        // Thousands of messages: other requests are answered meanwhile.
        if (++counted % 2000 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (arena !== this.messageArena) {
            moved = true;
            break;
          }
        }
        if (this.messages.get(key) !== entry) continue;
        const { score, part } = best(arena, asked, entry);
        found.push({ conversationId, messageId: key.slice(split + 1), part, score });
      }
      if (moved) continue;
      found.sort((left, right) => right.score - left.score);
      return found.slice(0, limit);
    }
    return [];
  }

  /** Whether every old note and message has been printed by now. */
  complete(): boolean {
    return this.caughtUp && this.pending.size === 0;
  }

  // --- the prints kept -----------------------------------------------------------

  /** Reads the prints kept into memory, once while they are held. */
  private loadPrints(): Promise<void> {
    const epoch = this.epoch;
    if (this.loaded?.epoch === epoch) return this.loaded.promise;
    const state: { epoch: number; promise: Promise<void>; done: boolean } = { epoch, promise: Promise.resolve(), done: false };
    const forgotten = new Set<string>();
    this.forgottenWhileLoading = forgotten;
    const read = { note: new Map<string, Entry>(), message: new Map<string, Entry>() };
    const noteArena = this.noteArena;
    const messageArena = this.messageArena;
    const letGo = () => {
      // By index: a print missing a passage leaves a hole.
      for (const entry of read.note.values()) for (let index = 0; index < entry.slots.length; index += 1) noteArena.release(entry.slots[index]);
      for (const entry of read.message.values()) for (let index = 0; index < entry.slots.length; index += 1) messageArena.release(entry.slots[index]);
    };
    state.promise = (async () => {
      await this.init();
      let after = 0;
      for (;;) {
        if (epoch !== this.epoch) return;
        const rows = await this.query<{ rowid: number; kind: string; scopeId: string; itemId: string; part: number; hash: string; print: string }>(
          `select rowid, kind, scope_id as scopeId, item_id as itemId, part, hash, print from semantic_prints where rowid > ${after} order by rowid limit ${LOAD_PAGE};`);
        if (epoch !== this.epoch) return;
        for (const row of rows) {
          const kind = row.kind === "note" ? "note" : row.kind === "message" ? "message" : undefined;
          if (!kind) continue;
          const values = decodePrint(row.print, kind === "note" ? NOTE_DIMS : MESSAGE_DIMS);
          const part = Number(row.part);
          if (!values || !Number.isSafeInteger(part) || part < 0 || part >= 64) continue;
          const key = kind === "note" ? row.itemId : messageKey(row.scopeId, row.itemId);
          let entry = read[kind].get(key);
          if (entry && entry.hash !== row.hash) continue;
          if (!entry) read[kind].set(key, entry = { hash: row.hash, slots: [] });
          if (entry.slots[part] !== undefined) continue;
          entry.slots[part] = (kind === "note" ? noteArena : messageArena).add(values);
        }
        if (rows.length < LOAD_PAGE) break;
        after = Number(rows[rows.length - 1].rowid);
      }
      // Taken in, unless printed anew meanwhile (newer) or forgotten
      // meanwhile; a print missing a passage (cut short by a crash) is
      // printed again.
      const stale: Item[] = [];
      for (const kind of ["note", "message"] as const) {
        const arena = kind === "note" ? noteArena : messageArena;
        const live = kind === "note" ? this.notes : this.messages;
        for (const [key, entry] of read[kind]) {
          const item = kind === "note" ? { kind, scopeId: "", itemId: key } : { kind, scopeId: key.slice(0, key.indexOf("\n")), itemId: key.slice(key.indexOf("\n") + 1) };
          const wasForgotten = forgotten.has(jobKey(item.kind, item.scopeId, item.itemId)) || (kind === "message" && forgotten.has(chatMarker(item.scopeId)));
          if (wasForgotten || live.has(key) || hasHole(entry.slots)) {
            for (const slot of entry.slots) if (slot !== undefined) arena.release(slot);
            // Forgotten and not printed anew since: the database forgets it too.
            if (wasForgotten && !live.has(key)) stale.push(item);
            continue;
          }
          live.set(key, entry);
        }
      }
      read.note.clear();
      read.message.clear();
      if (stale.length) await this.deletePrints(stale);
      state.done = true;
      this.log("hub.semantic.loaded", { notes: this.notes.size, messages: this.messages.size });
    })().catch((error: unknown) => {
      // Read again next time, whatever letting go does.
      if (this.loaded === state) this.loaded = undefined;
      letGo();
      throw error;
    }).finally(() => {
      if (this.forgottenWhileLoading === forgotten) this.forgottenWhileLoading = undefined;
    });
    this.loaded = state;
    return state.promise;
  }

  /** Catches up for a key, again and again after a failure of the
   *  database, until done or the key changes. */
  private async keepCatchingUp(generation: number): Promise<void> {
    let retryMs = RETRY_MIN_MS;
    const signal = this.generationAbort.signal;
    while (generation === this.generation && !this.closing.signal.aborted) {
      try {
        await this.loadPrints();
        await this.catchUp(generation);
        return;
      } catch (error) {
        if (generation !== this.generation) return;
        this.lastError = messageOf(error);
        this.log("hub.semantic.catch-up-failed", { message: this.lastError, retryMs });
        await this.sleep(retryMs, signal);
        retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
      }
    }
  }

  /** Prints every note and message not printed yet (or changed), once, a
   *  page at a time, and forgets prints of what is gone. */
  private async catchUp(generation: number): Promise<void> {
    // A pass for an older key stops at its next page; this one starts anyway.
    if (this.catchingUpFor === generation) return;
    this.catchingUpFor = generation;
    try {
      // Only what was printed before the pass can be gone: what is printed
      // during it came as it was written (a note, a message), after its page.
      const notesBefore = new Set(this.notes.keys());
      const messagesBefore = new Set(this.messages.keys());
      const seenNotes = new Set<string>();
      let afterNote = "";
      while (this.noteSource && generation === this.generation) {
        const notes = await this.noteSource.notesPage(afterNote, NOTE_PAGE);
        for (const note of notes) {
          seenNotes.add(note.id);
          this.noteChangedQuietly(note);
        }
        await this.drain(generation);
        if (notes.length < NOTE_PAGE) break;
        afterNote = notes[notes.length - 1].id;
      }
      if (generation !== this.generation) return;
      this.notesReadyFor = generation;
      const seenMessages = await this.printMessages(generation, "");
      if (!seenMessages) return;
      if (generation !== this.generation) return;
      // What was printed but is gone now (deleted, hidden, archived).
      const gone: Item[] = [];
      if (this.noteSource) for (const id of notesBefore) if (!seenNotes.has(id) && this.notes.has(id)) gone.push({ kind: "note", scopeId: "", itemId: id });
      for (const key of messagesBefore) {
        if (seenMessages.has(key) || !this.messages.has(key)) continue;
        const split = key.indexOf("\n");
        gone.push({ kind: "message", scopeId: key.slice(0, split), itemId: key.slice(split + 1) });
      }
      for (let at = 0; at < gone.length; at += 200) this.forget(gone.slice(at, at + 200), true);
      this.compact();
      // Done: what came meanwhile is printed as it comes (complete() also
      // waits for the queue).
      this.caughtUp = true;
      this.log("hub.semantic.caught-up", { notes: this.notes.size, messages: this.messages.size, forgotten: gone.length });
    } finally {
      if (this.catchingUpFor === generation) this.catchingUpFor = undefined;
    }
  }

  /**
   * Prints the chat messages read from the database (all, or those `where`
   * adds to), a page at a time; the keys of those that can be found, or
   * nothing when the key changed meanwhile.
   */
  private async printMessages(generation: number, where: string): Promise<Set<string> | undefined> {
    const seen = new Set<string>();
    let afterRow = 0;
    while (generation === this.generation) {
      const rows = await this.query<MessageRow & { rowid: number }>(`
        select m.rowid as rowid, ${MESSAGE_COLUMNS}
        from conversation_messages m join conversations c on c.id = m.conversation_id
        where m.rowid > ${afterRow} and c.kind = 'chat' and json_valid(m.payload_json)
          and json_extract(m.payload_json, '$.role') in ('user', 'participant') ${where}
        order by m.rowid limit ${MESSAGE_PAGE};`);
      for (const row of rows) {
        const text = printableText(messageOfRow(row));
        if (!text) continue;
        seen.add(messageKey(row.conversationId, row.messageId));
        const { texts } = messagePassages(text);
        if (texts.length) this.queueQuietly({ kind: "message", scopeId: row.conversationId, itemId: row.messageId, texts, hash: hashOf(MESSAGE_DIMS, texts) });
      }
      await this.drain(generation);
      if (rows.length < MESSAGE_PAGE) break;
      afterRow = Number(rows[rows.length - 1].rowid);
    }
    return generation === this.generation ? seen : undefined;
  }

  /** Many prints let go: the live ones are copied into fresh arenas, and
   *  the old blocks freed. Not while prints are being read in. */
  private compact(): void {
    if (this.forgottenWhileLoading) return;
    for (const kind of ["note", "message"] as const) {
      const arena = kind === "note" ? this.noteArena : this.messageArena;
      if (!arena.sparse()) continue;
      const fresh = new PrintArena(arena.dims, kind === "note" ? 256 : 2048);
      for (const entry of (kind === "note" ? this.notes : this.messages).values()) entry.slots = entry.slots.map((slot) => arena.copyTo(slot, fresh));
      if (kind === "note") this.noteArena = fresh;
      else this.messageArena = fresh;
      this.log("hub.semantic.compacted", { kind, prints: fresh.size });
    }
  }

  private noteChangedQuietly(note: PrintableNote): void {
    const { texts } = notePassages(note);
    this.queueQuietly({ kind: "note", scopeId: "", itemId: note.id, texts, hash: hashOf(NOTE_DIMS, texts) });
  }

  /** Queued without the settle timer: catching up drains itself. What came
   *  as it was written (queued or being printed) is newer than a page read
   *  from the database, and is not replaced by it. */
  private queueQuietly(job: Job): void {
    const key = jobKey(job.kind, job.scopeId, job.itemId);
    if (this.pending.has(key) || this.inFlight.has(key)) return;
    const kept = job.kind === "note" ? this.notes.get(job.itemId) : this.messages.get(messageKey(job.scopeId, job.itemId));
    if (kept?.hash !== job.hash) this.pending.set(key, job);
  }

  /** Prints what is queued, a batch at a time, until nothing is left or the
   *  key changed. One drain runs at a time; a second call waits for it. */
  private drain(generation: number): Promise<void> {
    if (this.draining) return this.draining.then(() => (this.pending.size && generation === this.generation ? this.drain(generation) : undefined));
    const run = (async () => {
      let retryMs = RETRY_MIN_MS;
      const signal = this.generationAbort.signal;
      while (this.pending.size && generation === this.generation && this.client) {
        const client = this.client;
        const batch = this.nextBatch();
        const keys = batch.map((job) => jobKey(job.kind, job.scopeId, job.itemId));
        for (const key of keys) this.inFlight.add(key);
        try {
          await this.printJobs(client, batch, generation, signal);
          retryMs = RETRY_MIN_MS;
          this.lastError = undefined;
          if (this.pending.size) await this.sleep(CATCH_UP_PAUSE_MS, signal);
        } catch (error) {
          // The key changed meanwhile (its request was cut short): nothing of
          // this batch is kept or tried again for it.
          if (generation !== this.generation) return;
          if (!(error instanceof EmbeddingError)) {
            // The database: tried again later, the jobs kept.
            for (const job of batch) this.requeue(job);
            this.lastError = messageOf(error);
            this.log("hub.semantic.store-failed", { message: this.lastError });
            await this.sleep(retryMs, signal);
            retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
            continue;
          }
          if (error.kind === "key") {
            await this.keyRefused(error, generation);
            return;
          }
          if (error.kind === "input") {
            // One text OpenAI will not print: the rest is printed one by one.
            if (batch.length === 1) {
              this.log("hub.semantic.skipped", { kind: batch[0].kind, message: error.message });
              continue;
            }
            for (const job of batch) {
              // Removed or changed meanwhile: nothing more goes out with it.
              if (generation !== this.generation || this.client !== client) return;
              try {
                await this.printJobs(client, [job], generation, signal);
              } catch (single) {
                if (generation !== this.generation) return;
                if (single instanceof EmbeddingError && single.kind === "input") this.log("hub.semantic.skipped", { kind: job.kind, message: single.message });
                else if (single instanceof EmbeddingError && single.kind === "key") {
                  await this.keyRefused(single, generation);
                  return;
                } else this.requeue(job);
              }
            }
            continue;
          }
          for (const job of batch) this.requeue(job);
          this.lastError = error.message;
          this.log("hub.semantic.print-failed", { message: error.message, kind: error.kind });
          await this.sleep(error.retryAfterMs ?? retryMs, signal);
          retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
        } finally {
          for (const key of keys) {
            this.inFlight.delete(key);
            this.superseded.delete(key);
          }
        }
      }
    })().finally(() => {
      if (this.draining === run) this.draining = undefined;
    });
    this.draining = run;
    return run;
  }

  /** The next jobs to print, up to a request's worth of passages. */
  private nextBatch(): Job[] {
    const batch: Job[] = [];
    let inputs = 0;
    for (const [key, job] of this.pending) {
      if (batch.length && inputs + job.texts.length > EMBED_BATCH_INPUTS) break;
      batch.push(job);
      inputs += job.texts.length;
      this.pending.delete(key);
    }
    return batch;
  }

  /** Put back, unless a newer text of the same thing came meanwhile, or it
   *  was forgotten meanwhile. */
  private requeue(job: Job): void {
    const key = jobKey(job.kind, job.scopeId, job.itemId);
    if (!this.pending.has(key) && !this.superseded.has(key)) this.pending.set(key, job);
  }

  private async printJobs(client: OpenAiEmbeddings, jobs: Job[], generation: number, signal: AbortSignal): Promise<void> {
    const prints = await client.embed(jobs.flatMap((job) => job.texts), BATCH_TIMEOUT_MS, signal);
    let at = 0;
    const rows: string[] = [];
    const made: Array<{ job: Job; values: Int8Array[] }> = [];
    for (const job of jobs) {
      const dims = job.kind === "note" ? NOTE_DIMS : MESSAGE_DIMS;
      const values = job.texts.map(() => shortenPrint(prints[at++], dims));
      // Forgotten while OpenAI printed it (hidden, deleted): not kept.
      if (this.superseded.has(jobKey(job.kind, job.scopeId, job.itemId))) continue;
      values.forEach((print, part) => rows.push(`(${quote(job.kind)}, ${quote(job.scopeId)}, ${quote(job.itemId)}, ${part}, ${quote(job.hash)}, ${quote(encodePrint(print))})`));
      made.push({ job, values });
    }
    if (!made.length) return;
    const deletes = made.map(({ job }) => `delete from semantic_prints where kind = ${quote(job.kind)} and scope_id = ${quote(job.scopeId)} and item_id = ${quote(job.itemId)};`);
    await this.run(`begin; ${deletes.join(" ")} insert into semantic_prints (kind, scope_id, item_id, part, hash, print) values ${rows.join(", ")}; commit;`);
    // Kept in memory only for the key it was printed for, and not when it was
    // forgotten while it was written (the forgetting deletes it after).
    if (generation !== this.generation) return;
    for (const { job, values } of made) {
      if (this.superseded.has(jobKey(job.kind, job.scopeId, job.itemId))) continue;
      const arena = job.kind === "note" ? this.noteArena : this.messageArena;
      this.keepEntry(job.kind, job.kind === "note" ? job.itemId : messageKey(job.scopeId, job.itemId), { hash: job.hash, slots: values.map((print) => arena.add(print)) });
    }
  }

  private async deletePrints(items: Array<{ kind: SemanticKind; scopeId: string; itemId: string }>): Promise<void> {
    if (!items.length) return;
    await this.run(`begin; ${items.map((item) => `delete from semantic_prints where kind = ${quote(item.kind)} and scope_id = ${quote(item.scopeId)} and item_id = ${quote(item.itemId)};`).join(" ")} commit;`);
  }

  // --- plumbing -----------------------------------------------------------------

  private init(): Promise<void> {
    this.schemaReady ??= this.run(SCHEMA_SQL).catch((error: unknown) => {
      this.schemaReady = undefined;
      throw error;
    });
    return this.schemaReady;
  }

  private async settings(): Promise<StoredSettings> {
    if (this.settingsCache) return { ...this.settingsCache };
    const stored = (await this.options.storage.hub().document(SETTINGS_DOCUMENT))?.value as Partial<StoredSettings> | undefined;
    this.settingsCache = {
      version: 1,
      ...(typeof stored?.openAiKey === "string" && stored.openAiKey ? { openAiKey: stored.openAiKey } : {}),
      ...(typeof stored?.keySetAt === "string" ? { keySetAt: stored.keySetAt } : {}),
      ...(typeof stored?.keyError === "string" && stored.keyError ? { keyError: stored.keyError } : {})
    };
    return { ...this.settingsCache };
  }

  private updateSettings(change: (settings: StoredSettings) => void): Promise<StoredSettings> {
    const run = this.settingsQueue.then(async () => {
      const settings = await this.settings();
      change(settings);
      await this.options.storage.hub().setDocument(SETTINGS_DOCUMENT, settings, this.now().toISOString());
      this.settingsCache = settings;
      return settings;
    });
    this.settingsQueue = run.catch(() => undefined);
    return run;
  }

  private query<T>(sql: string): Promise<T[]> {
    return this.options.storage.sqlExecutor().queryJson<T>(sql);
  }

  private run(sql: string): Promise<void> {
    return this.options.storage.sqlExecutor().runSql(sql);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Waits, unless the work's key changes or the server closes meanwhile
   *  (both abort `signal`). */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms, signal);
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

function best(arena: PrintArena, query: Float32Array, entry: Entry): { score: number; part: number } {
  let score = -1;
  let part = 0;
  for (let index = 0; index < entry.slots.length; index += 1) {
    const value = arena.closeness(query, entry.slots[index]);
    if (value > score) {
      score = value;
      part = index;
    }
  }
  return { score, part };
}

/** Whether a passage is missing (a loop by index: holes are skipped by `some`). */
function hasHole(slots: number[]): boolean {
  if (!slots.length) return true;
  for (let index = 0; index < slots.length; index += 1) if (slots[index] === undefined) return true;
  return false;
}

/** What the server reads of a message to print it (its passages' text and
 *  what decides whether the chat shows it), never its activity. */
export const MESSAGE_COLUMNS = `m.conversation_id as conversationId, m.message_id as messageId,
  json_extract(m.payload_json, '$.role') as role, json_extract(m.payload_json, '$.status') as status,
  json_extract(m.payload_json, '$.metadata.hiddenFromTimeline') as hidden,
  json_extract(m.payload_json, '$.metadata.participantRequest.source') as requestSource,
  (select json_group_array(json_object('id', json_extract(p.value, '$.id'), 'createdAt', json_extract(p.value, '$.createdAt'),
      'content', case when json_type(p.value, '$.content') = 'text' then substr(json_extract(p.value, '$.content'), 1, ${PRINT_SOURCE_CHARS}) end))
    from json_each(m.payload_json, '$.metadata.interimPosts') p where p.key < ${PRINT_SOURCE_POSTS}) as posts,
  substr(json_extract(m.payload_json, '$.content'), 1, ${PRINT_SOURCE_CHARS}) as content`;

export interface MessageRow {
  conversationId: string;
  messageId: string;
  role: string | null;
  status: string | null;
  hidden: number | null;
  requestSource: string | null;
  posts: string | null;
  content: string | null;
}

/** A message read by MESSAGE_COLUMNS, as printableText takes it. */
export function messageOfRow(row: MessageRow): PrintableMessageFields {
  let interimPosts: unknown;
  try {
    interimPosts = row.posts ? JSON.parse(row.posts) : undefined;
  } catch {
    interimPosts = undefined;
  }
  return {
    role: row.role as ChatMessage["role"],
    status: row.status,
    content: row.content ?? "",
    metadata: {
      ...(row.hidden === 1 ? { hiddenFromTimeline: true } : {}),
      ...(row.requestSource ? { participantRequest: { source: row.requestSource } } : {}),
      ...(Array.isArray(interimPosts) ? { interimPosts } : {})
    } as ChatMessage["metadata"]
  };
}

function hashOf(dims: number, texts: string[]): string {
  return createHash("sha256").update(`${EMBEDDING_MODEL}:${dims}:${texts.join("\u0000")}`).digest("hex").slice(0, 32);
}

/** Marks a whole chat forgotten while prints are read in. */
function chatMarker(conversationId: string): string {
  return `chat\n${conversationId}`;
}

function messageKey(conversationId: string, messageId: string): string {
  return `${conversationId}\n${messageId}`;
}

function jobKey(kind: SemanticKind, scopeId: string, itemId: string): string {
  return `${kind}\n${scopeId}\n${itemId}`;
}

function quote(value: string): string {
  return `'${value.replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}
