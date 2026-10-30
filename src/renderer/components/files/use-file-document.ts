import { useCallback, useEffect, useRef, useState } from "react";

import { isEditablePreviewKind } from "../../../shared/filePreview";
import type { FilePreview } from "../../../shared/types";
import { cleanIpcError } from "../../lib/ipc-error";
import { fileEditBuffers, type FileEditBuffer } from "./file-edit-buffers";

const AUTOSAVE_DELAY_MS = 800;

export interface FileDocument {
  status: "loading" | "ready" | "error";
  preview?: FilePreview;
  error?: string;
  /** The text being shown and edited (text kinds). */
  buffer?: FileEditBuffer;
  deleted: boolean;
  /** Bumps when the disk content was read again, so viewers reload. */
  revision: number;
  saving: boolean;
  edit: (text: string) => void;
  saveNow: () => void;
  keepMine: () => Promise<void>;
  takeDiskVersion: () => Promise<void>;
}

/**
 * One file shown in the side panel: its preview, its unsaved text (kept in
 * fileEditBuffers, so it outlives the panel), autosave, and what happens when
 * the file changes on disk while it is open.
 */
export function useFileDocument(conversationId: string, path: string): FileDocument {
  const [preview, setPreview] = useState<FilePreview | undefined>();
  const [status, setStatus] = useState<FileDocument["status"]>("loading");
  const [error, setError] = useState<string | undefined>();
  const [deleted, setDeleted] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [, setTick] = useState(0);
  const realPathRef = useRef<string | undefined>();
  const loadSeq = useRef(0);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>();

  const load = useCallback(async (keepStatus = false): Promise<FilePreview | undefined> => {
    const seq = ++loadSeq.current;
    if (!keepStatus) setStatus("loading");
    try {
      const next = await window.consensus.readFilePreview({ conversationId, path });
      if (seq !== loadSeq.current) return undefined;
      realPathRef.current = next.realPath;
      if (isEditablePreviewKind(next.kind)) {
        if (typeof next.text === "string") {
          const buffer = fileEditBuffers.get(next.realPath);
          if (keepStatus && buffer && !buffer.dirty) {
            fileEditBuffers.replaceFromDisk(next.realPath, next.text, next.hash, next.bom);
          } else {
            fileEditBuffers.open({ conversationId, path, realPath: next.realPath, baseHash: next.hash, text: next.text, bom: next.bom });
          }
        }
      }
      setPreview(next);
      setDeleted(false);
      setError(undefined);
      setStatus("ready");
      setRevision((value) => value + 1);
      return next;
    } catch (cause) {
      if (seq !== loadSeq.current) return undefined;
      setError(cleanIpcError(cause));
      setStatus("error");
      return undefined;
    }
  }, [conversationId, path]);

  useEffect(() => {
    setPreview(undefined);
    setDeleted(false);
    realPathRef.current = undefined;
    void load();
    return () => { loadSeq.current += 1; };
  }, [load]);

  const realPath = preview?.realPath;

  // Re-render when the buffer changes (typing, a save, a conflict). A buffer
  // dropped elsewhere (Discard on the restore notice) is read again from disk,
  // so typing keeps working.
  const hasText = typeof preview?.text === "string";
  useEffect(() => {
    if (!realPath) return undefined;
    const detach = fileEditBuffers.attach(realPath);
    const unsubscribe = fileEditBuffers.subscribe((changed) => {
      if (changed !== realPath) return;
      if (hasText && !fileEditBuffers.get(realPath)) void load(true);
      setTick((value) => value + 1);
    });
    return () => {
      unsubscribe();
      detach();
      fileEditBuffers.forget(realPath);
    };
  }, [hasText, load, realPath]);

  // Watch the file on disk while it is shown.
  useEffect(() => {
    if (!realPath) return undefined;
    let active = true;
    void window.consensus.watchFilePreview({ conversationId, path }).catch(() => undefined);
    const off = window.consensus.onFilePreviewChanged((event) => {
      if (!active || event.realPath !== realPath) return;
      if (event.change === "deleted") {
        setDeleted(true);
        if (fileEditBuffers.get(realPath)?.dirty) fileEditBuffers.markConflict(realPath, "deleted");
        return;
      }
      const buffer = fileEditBuffers.get(realPath);
      if (buffer?.dirty) {
        if (event.hash !== buffer.baseHash) fileEditBuffers.markConflict(realPath, "changed");
        return;
      }
      void load(true);
    });
    return () => {
      active = false;
      off();
      void window.consensus.unwatchFilePreview(realPath).catch(() => undefined);
      void window.consensus.releaseFilePreview(realPath).catch(() => undefined);
    };
  }, [conversationId, path, realPath, load]);

  // Leaving the file (another file, closing the panel, another chat, a thread): save it now.
  useEffect(() => {
    if (!realPath) return undefined;
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      autosaveTimer.current = undefined;
      const buffer = fileEditBuffers.get(realPath);
      if (buffer?.dirty && !buffer.conflict) void fileEditBuffers.save(realPath);
    };
  }, [realPath]);

  const runSave = useCallback(() => {
    const current = realPathRef.current;
    if (!current) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = undefined;
    setSaving(true);
    void fileEditBuffers.save(current).finally(() => setSaving(false));
  }, []);

  const edit = useCallback((text: string) => {
    const current = realPathRef.current;
    if (!current) return;
    fileEditBuffers.edit(current, text);
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(runSave, AUTOSAVE_DELAY_MS);
  }, [runSave]);

  const keepMine = useCallback(async () => {
    const current = realPathRef.current;
    if (!current) return;
    try {
      const disk = await window.consensus.readFilePreview({ conversationId, path });
      fileEditBuffers.rebase(current, disk.hash);
      setDeleted(false);
      runSave();
    } catch (cause) {
      fileEditBuffers.setError(current, cleanIpcError(cause));
    }
  }, [conversationId, path, runSave]);

  const takeDiskVersion = useCallback(async () => {
    const current = realPathRef.current;
    if (!current) return;
    await fileEditBuffers.discard(current);
    await load();
  }, [load]);

  return {
    status,
    preview,
    error,
    buffer: realPath ? fileEditBuffers.get(realPath) : undefined,
    deleted,
    revision,
    saving,
    edit,
    saveNow: runSave,
    keepMine,
    takeDiskVersion
  };
}
