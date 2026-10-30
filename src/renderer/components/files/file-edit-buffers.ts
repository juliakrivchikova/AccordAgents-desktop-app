import type { UnsavedFileEdit, WriteFilePreviewResult } from "../../../shared/types";

export type FileEditConflict = "changed" | "replaced" | "deleted";

/** Unsaved text of one file, kept outside React so leaving the panel never drops it. */
export interface FileEditBuffer {
  conversationId: string;
  path: string;
  realPath: string;
  /** Hash of the disk content this text was started from. */
  baseHash: string;
  text: string;
  bom: boolean;
  dirty: boolean;
  conflict?: FileEditConflict;
  /** Restored from userData after a restart. */
  restored?: boolean;
  error?: string;
}

export type FileEditSaveOutcome =
  | { status: "saved" | "clean" }
  | { status: "conflict"; conflict: FileEditConflict }
  | { status: "error"; error: string };

const PERSIST_DELAY_MS = 1_000;

type Listener = (realPath: string) => void;

/**
 * Owns every unsaved panel edit. Saves go through here (one at a time per
 * file), so a save started as the panel closes finishes after it is gone. While
 * text is unsaved a copy is kept in userData, so a crash, a refused save at quit
 * or a renderer that cannot answer loses nothing: it is offered at the next start.
 */
export class FileEditBufferStore {
  private readonly buffers = new Map<string, FileEditBuffer>();
  private readonly saving = new Map<string, Promise<FileEditSaveOutcome>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<Listener>();
  /** Files a mounted panel shows; a conflict elsewhere is reported by a notice instead. */
  private readonly shown = new Map<string, number>();
  private conflictHandler?: (buffer: FileEditBuffer) => void;

  attach(realPath: string): () => void {
    this.shown.set(realPath, (this.shown.get(realPath) ?? 0) + 1);
    return () => {
      const count = (this.shown.get(realPath) ?? 1) - 1;
      if (count > 0) this.shown.set(realPath, count);
      else this.shown.delete(realPath);
    };
  }

  get(realPath: string): FileEditBuffer | undefined {
    return this.buffers.get(realPath);
  }

  list(): FileEditBuffer[] {
    return [...this.buffers.values()];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Called when a save that nobody is looking at hits a conflict (the panel was closed). */
  onBackgroundConflict(handler: ((buffer: FileEditBuffer) => void) | undefined): void {
    this.conflictHandler = handler;
  }

  /** Starts tracking a file the panel opened, or returns the unsaved buffer it already has. */
  open(seed: Omit<FileEditBuffer, "dirty" | "text"> & { text: string }): FileEditBuffer {
    const existing = this.buffers.get(seed.realPath);
    if (existing?.dirty) {
      // Unsaved text wins over the disk; a different disk content is a conflict to settle.
      if (existing.baseHash !== seed.baseHash && !existing.conflict) {
        existing.conflict = "changed";
      }
      existing.conversationId = seed.conversationId;
      existing.path = seed.path;
      this.emit(seed.realPath);
      return existing;
    }
    const buffer: FileEditBuffer = { ...seed, dirty: false, conflict: undefined, error: undefined };
    this.buffers.set(seed.realPath, buffer);
    return buffer;
  }

  /** The User typed. */
  edit(realPath: string, text: string): void {
    const buffer = this.buffers.get(realPath);
    if (!buffer || buffer.text === text) return;
    buffer.text = text;
    buffer.dirty = true;
    buffer.error = undefined;
    this.schedulePersist(realPath);
    this.emit(realPath);
  }

  /** The disk changed and nothing was typed: take the disk's text. */
  replaceFromDisk(realPath: string, text: string, hash: string, bom: boolean): void {
    const buffer = this.buffers.get(realPath);
    if (!buffer) return;
    buffer.text = text;
    buffer.baseHash = hash;
    buffer.bom = bom;
    buffer.dirty = false;
    buffer.conflict = undefined;
    buffer.restored = false;
    this.emit(realPath);
  }

  markConflict(realPath: string, conflict: FileEditConflict): void {
    const buffer = this.buffers.get(realPath);
    if (!buffer) return;
    buffer.conflict = conflict;
    this.persistNow(realPath);
    this.emit(realPath);
  }

  /** "Keep mine": the next save writes over the disk content with this hash. */
  rebase(realPath: string, diskHash: string): void {
    const buffer = this.buffers.get(realPath);
    if (!buffer) return;
    buffer.baseHash = diskHash;
    buffer.conflict = undefined;
    this.emit(realPath);
  }

  /** "Use disk version" or the User dropped a restored copy. */
  async discard(realPath: string): Promise<void> {
    const timer = this.persistTimers.get(realPath);
    if (timer) clearTimeout(timer);
    this.persistTimers.delete(realPath);
    this.buffers.delete(realPath);
    await window.consensus.clearUnsavedFileEdit(realPath).catch(() => undefined);
    this.emit(realPath);
  }

  /** A buffer read back from userData at start. */
  restore(edit: UnsavedFileEdit): void {
    if (this.buffers.get(edit.realPath)?.dirty) return;
    this.buffers.set(edit.realPath, {
      conversationId: edit.conversationId,
      path: edit.path,
      realPath: edit.realPath,
      baseHash: edit.baseHash,
      text: edit.text,
      bom: edit.bom === true,
      dirty: true,
      restored: true
    });
    this.emit(edit.realPath);
  }

  save(realPath: string): Promise<FileEditSaveOutcome> {
    const previous = this.saving.get(realPath) ?? Promise.resolve<FileEditSaveOutcome>({ status: "clean" });
    const next = previous.catch(() => undefined).then(() => this.saveNow(realPath));
    this.saving.set(realPath, next);
    void next.finally(() => {
      if (this.saving.get(realPath) === next) this.saving.delete(realPath);
    });
    return next;
  }

  /** Saves everything that can be saved and keeps a copy of the rest. For quit, close and update. */
  async flushAll(): Promise<void> {
    const pending = this.list().filter((buffer) => buffer.dirty);
    await Promise.all(pending.map(async (buffer) => {
      if (buffer.conflict) {
        await this.persist(buffer.realPath);
        return;
      }
      const outcome = await this.save(buffer.realPath).catch(() => ({ status: "error", error: "" }) as FileEditSaveOutcome);
      if (outcome.status !== "saved" && outcome.status !== "clean") await this.persist(buffer.realPath);
    }));
  }

  private async saveNow(realPath: string): Promise<FileEditSaveOutcome> {
    const buffer = this.buffers.get(realPath);
    if (!buffer || !buffer.dirty) return { status: "clean" };
    if (buffer.conflict) return { status: "conflict", conflict: buffer.conflict };
    const text = buffer.text;
    let result: WriteFilePreviewResult;
    try {
      result = await window.consensus.writeFilePreview({
        conversationId: buffer.conversationId,
        path: buffer.path,
        content: text,
        baseHash: buffer.baseHash,
        bom: buffer.bom
      });
    } catch (error) {
      result = { ok: false, conflict: false, error: error instanceof Error ? error.message : String(error) };
    }
    const current = this.buffers.get(realPath);
    if (!current) return { status: "clean" };
    if (result.ok) {
      current.baseHash = result.hash;
      current.restored = false;
      if (current.text === text) {
        current.dirty = false;
        const timer = this.persistTimers.get(realPath);
        if (timer) clearTimeout(timer);
        this.persistTimers.delete(realPath);
        await window.consensus.clearUnsavedFileEdit(realPath).catch(() => undefined);
      }
      this.emit(realPath);
      return { status: "saved" };
    }
    if (result.conflict) {
      current.conflict = result.reason;
      await this.persist(realPath);
      this.emit(realPath);
      if (!this.shown.has(realPath)) this.conflictHandler?.(current);
      return { status: "conflict", conflict: result.reason };
    }
    current.error = result.error;
    await this.persist(realPath);
    this.emit(realPath);
    return { status: "error", error: result.error };
  }

  private schedulePersist(realPath: string): void {
    if (this.persistTimers.has(realPath)) return;
    this.persistTimers.set(realPath, setTimeout(() => {
      this.persistTimers.delete(realPath);
      void this.persist(realPath);
    }, PERSIST_DELAY_MS));
  }

  private persistNow(realPath: string): void {
    void this.persist(realPath);
  }

  private async persist(realPath: string): Promise<void> {
    const buffer = this.buffers.get(realPath);
    if (!buffer?.dirty) return;
    await window.consensus.saveUnsavedFileEdit({
      conversationId: buffer.conversationId,
      path: buffer.path,
      realPath: buffer.realPath,
      baseHash: buffer.baseHash,
      text: buffer.text,
      bom: buffer.bom,
      updatedAt: new Date().toISOString()
    }).catch((error) => {
      console.error("Could not keep a copy of unsaved file edits.", error);
    });
  }

  private emit(realPath: string): void {
    for (const listener of this.listeners) listener(realPath);
  }
}

export const fileEditBuffers = new FileEditBufferStore();
