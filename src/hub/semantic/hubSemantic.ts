import { createHash } from "node:crypto";
import type { StorageService } from "../../main/services/storage";
import type { SemanticSettingsView } from "../../shared/memory";
import { EMBED_BATCH_INPUTS, EmbeddingError, OpenAiEmbeddings } from "./openAiEmbeddings";
import {
  EMBEDDING_MODEL, MESSAGE_DIMS, NOTE_DIMS, QUERY_MAX_CHARS, closeness, decodePrint, encodePrint, messagePassages, notePassages,
  printableMessage, queryPrint, shortenPrint, storedPrint, type SemanticKind, type StoredPrint
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

interface StoredSettings {
  version: 1;
  openAiKey?: string;
  keySetAt?: string;
  /** Why the key stopped working (OpenAI refused it, or no credit left). */
  keyError?: string;
}

interface Entry {
  hash: string;
  prints: StoredPrint[];
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
  private ready?: Promise<void>;
  private settingsCache?: StoredSettings;
  private client?: OpenAiEmbeddings;
  /** Bumped whenever the key changes or the server closes: work started
   *  under an older one stops. */
  private generation = 0;
  private loaded?: Promise<void>;
  private readonly notes = new Map<string, Entry>();
  private readonly messages = new Map<string, Entry>();
  private readonly pending = new Map<string, Job>();
  private draining?: Promise<void>;
  private catchingUp = false;
  private caughtUp = false;
  private lastError?: string;
  private settleTimer?: NodeJS.Timeout;
  private readonly queryCache = new Map<string, number[]>();
  private noteSource?: NoteSource;
  private closing = new AbortController();
  private settingsQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: HubSemanticOptions) {}

  private get log(): (event: string, payload: Record<string, unknown>) => void {
    return this.options.log ?? (() => undefined);
  }

  setNoteSource(source: NoteSource): void {
    this.noteSource = source;
  }

  /** Reads the key and, with one, the prints kept, then prints what is missing. */
  async start(): Promise<void> {
    await this.init();
    const settings = await this.settings();
    if (settings.openAiKey && !settings.keyError) this.enable(settings.openAiKey);
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.closing.abort();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    await this.draining?.catch(() => undefined);
  }

  /** Whether search by meaning is on (a key that works is given). */
  enabled(): boolean {
    return Boolean(this.client);
  }

  // --- the key ----------------------------------------------------------------

  async view(): Promise<SemanticSettingsView> {
    const settings = await this.settings();
    return {
      keySet: Boolean(settings.openAiKey),
      ...(settings.keyError ? { keyError: settings.keyError } : {}),
      ...(settings.openAiKey ? {
        notesPrinted: this.notes.size,
        messagesPrinted: this.messages.size,
        catchingUp: !this.caughtUp,
        ...(this.lastError && !settings.keyError ? { lastError: this.lastError } : {})
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

  private enable(key: string): void {
    this.generation += 1;
    this.client = new OpenAiEmbeddings(key, this.options.fetchImpl, this.options.openAiBaseUrl);
    this.lastError = undefined;
    this.caughtUp = false;
    const generation = this.generation;
    void this.loadPrints().then(() => this.catchUp(generation)).catch((error: unknown) => {
      this.lastError = messageOf(error);
      this.log("hub.semantic.catch-up-failed", { message: this.lastError });
    });
  }

  private disable(): void {
    this.generation += 1;
    this.client = undefined;
    this.pending.clear();
  }

  /** OpenAI refused the key while printing: kept, said in Settings, unused. */
  private async keyRefused(error: EmbeddingError, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.disable();
    this.log("hub.semantic.key-stopped", { message: error.message });
    await this.updateSettings((settings) => { settings.keyError = error.message; }).catch(() => undefined);
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
    this.pending.delete(jobKey("note", "", noteId));
    if (!this.notes.delete(noteId)) return;
    void this.deletePrints([{ kind: "note", scopeId: "", itemId: noteId }]).catch(() => undefined);
  }

  /** A chat message the server accepted (new, or changed). */
  messageChanged(conversationId: string, message: { id: string; role?: unknown; status?: unknown; content?: unknown; metadata?: { hiddenFromTimeline?: unknown } | null }): void {
    if (!this.client) return;
    const { texts } = printableMessage(message) ? messagePassages(message.content) : { texts: [] };
    if (!texts.length) {
      // Hidden or emptied since it was printed: no longer found.
      const key = messageKey(conversationId, message.id);
      this.pending.delete(jobKey("message", conversationId, message.id));
      if (this.messages.delete(key)) void this.deletePrints([{ kind: "message", scopeId: conversationId, itemId: message.id }]).catch(() => undefined);
      return;
    }
    this.queue({ kind: "message", scopeId: conversationId, itemId: message.id, texts, hash: hashOf(MESSAGE_DIMS, texts) });
  }

  private queue(job: Job): void {
    const kept = job.kind === "note" ? this.notes.get(job.itemId) : this.messages.get(messageKey(job.scopeId, job.itemId));
    if (kept?.hash === job.hash) return;
    this.pending.set(jobKey(job.kind, job.scopeId, job.itemId), job);
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
    const input = text.slice(0, QUERY_MAX_CHARS).trim();
    if (!input) return undefined;
    const key = createHash("sha256").update(input).digest("hex");
    const cached = this.queryCache.get(key);
    if (cached) return cached;
    try {
      const [print] = await client.embed([input], timeoutMs);
      this.queryCache.set(key, print);
      if (this.queryCache.size > QUERY_CACHE_SIZE) this.queryCache.delete(this.queryCache.keys().next().value as string);
      await this.loadPrints();
      return print;
    } catch (error) {
      if (error instanceof EmbeddingError && error.kind === "key") await this.keyRefused(error, this.generation);
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
      scores.set(id, best(asked, entry));
    }
    return scores;
  }

  /** The messages of the given chats closest to a query, closest first. */
  async messageCloseness(query: number[], conversationIds: ReadonlySet<string>, limit: number): Promise<MessageCloseness[]> {
    const asked = queryPrint(query, MESSAGE_DIMS);
    const found: MessageCloseness[] = [];
    let counted = 0;
    for (const [key, entry] of this.messages) {
      const split = key.indexOf("\n");
      const conversationId = key.slice(0, split);
      if (!conversationIds.has(conversationId)) continue;
      // Thousands of messages: other requests are answered meanwhile.
      if (++counted % 2000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const { score, part } = best(asked, entry);
      found.push({ conversationId, messageId: key.slice(split + 1), part, score });
    }
    found.sort((left, right) => right.score - left.score);
    return found.slice(0, limit);
  }

  /** Whether every old note and message has been printed by now. */
  complete(): boolean {
    return this.caughtUp && this.pending.size === 0;
  }

  // --- the prints kept -----------------------------------------------------------

  private loadPrints(): Promise<void> {
    this.loaded ??= (async () => {
      await this.init();
      let after = 0;
      for (;;) {
        const rows = await this.query<{ rowid: number; kind: string; scopeId: string; itemId: string; part: number; hash: string; print: string }>(
          `select rowid, kind, scope_id as scopeId, item_id as itemId, part, hash, print from semantic_prints where rowid > ${after} order by rowid limit ${LOAD_PAGE};`);
        for (const row of rows) {
          const kind = row.kind === "note" ? "note" : row.kind === "message" ? "message" : undefined;
          if (!kind) continue;
          const values = decodePrint(row.print, kind === "note" ? NOTE_DIMS : MESSAGE_DIMS);
          if (!values) continue;
          const map = kind === "note" ? this.notes : this.messages;
          const key = kind === "note" ? row.itemId : messageKey(row.scopeId, row.itemId);
          const entry = map.get(key);
          if (entry && entry.hash !== row.hash) continue;
          const prints = entry?.prints ?? [];
          prints[Number(row.part)] = storedPrint(values);
          map.set(key, { hash: row.hash, prints });
        }
        if (rows.length < LOAD_PAGE) break;
        after = Number(rows[rows.length - 1].rowid);
      }
      // A print with a missing passage (cut short by a crash) is printed again.
      for (const map of [this.notes, this.messages]) {
        for (const [key, entry] of map) if (entry.prints.some((print) => !print) || !entry.prints.length) map.delete(key);
      }
      this.log("hub.semantic.loaded", { notes: this.notes.size, messages: this.messages.size });
    })().catch((error: unknown) => {
      this.loaded = undefined;
      throw error;
    });
    return this.loaded;
  }

  /** Prints every note and message not printed yet (or changed), once, a
   *  page at a time, and forgets prints of what is gone. */
  private async catchUp(generation: number): Promise<void> {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
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
      const seenMessages = new Set<string>();
      let afterRow = 0;
      while (generation === this.generation) {
        const rows = await this.query<{ rowid: number; conversationId: string; messageId: string; role: string; status: string | null; hidden: number | null; content: string | null }>(`
          select m.rowid as rowid, m.conversation_id as conversationId, m.message_id as messageId,
            json_extract(m.payload_json, '$.role') as role, json_extract(m.payload_json, '$.status') as status,
            json_extract(m.payload_json, '$.metadata.hiddenFromTimeline') as hidden,
            substr(json_extract(m.payload_json, '$.content'), 1, 12000) as content
          from conversation_messages m join conversations c on c.id = m.conversation_id
          where m.rowid > ${afterRow} and c.kind = 'chat' and json_valid(m.payload_json)
            and json_extract(m.payload_json, '$.role') in ('user', 'participant')
          order by m.rowid limit ${MESSAGE_PAGE};`);
        for (const row of rows) {
          const message = { id: row.messageId, role: row.role, status: row.status, content: row.content, metadata: { hiddenFromTimeline: row.hidden === 1 } };
          if (!printableMessage(message)) continue;
          seenMessages.add(messageKey(row.conversationId, row.messageId));
          const { texts } = messagePassages(message.content);
          if (texts.length) this.queueQuietly({ kind: "message", scopeId: row.conversationId, itemId: row.messageId, texts, hash: hashOf(MESSAGE_DIMS, texts) });
        }
        await this.drain(generation);
        if (rows.length < MESSAGE_PAGE) break;
        afterRow = Number(rows[rows.length - 1].rowid);
      }
      if (generation !== this.generation) return;
      // What was printed but is gone now (deleted, hidden, archived).
      const gone: Array<{ kind: SemanticKind; scopeId: string; itemId: string }> = [];
      if (this.noteSource) for (const id of this.notes.keys()) if (!seenNotes.has(id)) gone.push({ kind: "note", scopeId: "", itemId: id });
      for (const key of this.messages.keys()) {
        if (seenMessages.has(key)) continue;
        const split = key.indexOf("\n");
        gone.push({ kind: "message", scopeId: key.slice(0, split), itemId: key.slice(split + 1) });
      }
      for (const item of gone) (item.kind === "note" ? this.notes : this.messages).delete(item.kind === "note" ? item.itemId : messageKey(item.scopeId, item.itemId));
      for (let at = 0; at < gone.length; at += 200) await this.deletePrints(gone.slice(at, at + 200));
      this.caughtUp = this.pending.size === 0;
      this.log("hub.semantic.caught-up", { notes: this.notes.size, messages: this.messages.size, forgotten: gone.length });
    } finally {
      this.catchingUp = false;
    }
  }

  private noteChangedQuietly(note: PrintableNote): void {
    const { texts } = notePassages(note);
    this.queueQuietly({ kind: "note", scopeId: "", itemId: note.id, texts, hash: hashOf(NOTE_DIMS, texts) });
  }

  /** Queued without the settle timer: catching up drains itself. */
  private queueQuietly(job: Job): void {
    const kept = job.kind === "note" ? this.notes.get(job.itemId) : this.messages.get(messageKey(job.scopeId, job.itemId));
    if (kept?.hash !== job.hash) this.pending.set(jobKey(job.kind, job.scopeId, job.itemId), job);
  }

  /** Prints what is queued, a batch at a time, until nothing is left or the
   *  key changed. One drain runs at a time; a second call waits for it. */
  private drain(generation: number): Promise<void> {
    if (this.draining) return this.draining.then(() => (this.pending.size && generation === this.generation ? this.drain(generation) : undefined));
    const run = (async () => {
      let retryMs = RETRY_MIN_MS;
      while (this.pending.size && generation === this.generation && this.client) {
        const client = this.client;
        const batch = this.nextBatch();
        try {
          await this.printJobs(client, batch);
          retryMs = RETRY_MIN_MS;
          this.lastError = undefined;
          if (this.pending.size) await this.sleep(CATCH_UP_PAUSE_MS);
        } catch (error) {
          if (!(error instanceof EmbeddingError)) {
            // The database: tried again later, the jobs kept.
            for (const job of batch) this.requeue(job);
            this.lastError = messageOf(error);
            this.log("hub.semantic.store-failed", { message: this.lastError });
            await this.sleep(retryMs);
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
            for (const job of batch) await this.printJobs(client, [job]).catch((single: unknown) => {
              if (single instanceof EmbeddingError && single.kind === "input") this.log("hub.semantic.skipped", { kind: job.kind, message: single.message });
              else this.requeue(job);
            });
            continue;
          }
          for (const job of batch) this.requeue(job);
          this.lastError = error.message;
          this.log("hub.semantic.print-failed", { message: error.message, kind: error.kind });
          await this.sleep(error.retryAfterMs ?? retryMs);
          retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
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

  /** Put back, unless a newer text of the same thing came meanwhile. */
  private requeue(job: Job): void {
    const key = jobKey(job.kind, job.scopeId, job.itemId);
    if (!this.pending.has(key)) this.pending.set(key, job);
  }

  private async printJobs(client: OpenAiEmbeddings, jobs: Job[]): Promise<void> {
    const prints = await client.embed(jobs.flatMap((job) => job.texts), BATCH_TIMEOUT_MS, this.closing.signal);
    let at = 0;
    const rows: string[] = [];
    const stored: Array<{ job: Job; prints: StoredPrint[] }> = [];
    for (const job of jobs) {
      const dims = job.kind === "note" ? NOTE_DIMS : MESSAGE_DIMS;
      const values = job.texts.map(() => shortenPrint(prints[at++], dims));
      values.forEach((print, part) => rows.push(`(${quote(job.kind)}, ${quote(job.scopeId)}, ${quote(job.itemId)}, ${part}, ${quote(job.hash)}, ${quote(encodePrint(print))})`));
      stored.push({ job, prints: values.map(storedPrint) });
    }
    const deletes = jobs.map((job) => `delete from semantic_prints where kind = ${quote(job.kind)} and scope_id = ${quote(job.scopeId)} and item_id = ${quote(job.itemId)};`);
    await this.run(`begin; ${deletes.join(" ")} insert into semantic_prints (kind, scope_id, item_id, part, hash, print) values ${rows.join(", ")}; commit;`);
    for (const { job, prints: values } of stored) {
      (job.kind === "note" ? this.notes : this.messages).set(job.kind === "note" ? job.itemId : messageKey(job.scopeId, job.itemId), { hash: job.hash, prints: values });
    }
  }

  private async deletePrints(items: Array<{ kind: SemanticKind; scopeId: string; itemId: string }>): Promise<void> {
    if (!items.length) return;
    await this.run(`begin; ${items.map((item) => `delete from semantic_prints where kind = ${quote(item.kind)} and scope_id = ${quote(item.scopeId)} and item_id = ${quote(item.itemId)};`).join(" ")} commit;`);
  }

  // --- plumbing -----------------------------------------------------------------

  private init(): Promise<void> {
    this.ready ??= this.run(SCHEMA_SQL).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
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

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep) return this.options.sleep(ms, this.closing.signal);
    return new Promise<void>((resolve) => {
      if (this.closing.signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      this.closing.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

function best(query: Float32Array, entry: Entry): { score: number; part: number } {
  let score = -1;
  let part = 0;
  entry.prints.forEach((print, index) => {
    const value = closeness(query, print);
    if (value > score) {
      score = value;
      part = index;
    }
  });
  return { score, part };
}

function hashOf(dims: number, texts: string[]): string {
  return createHash("sha256").update(`${EMBEDDING_MODEL}:${dims}:${texts.join("\u0000")}`).digest("hex").slice(0, 32);
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
