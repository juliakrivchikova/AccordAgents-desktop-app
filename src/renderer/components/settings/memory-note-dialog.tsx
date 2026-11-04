import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { MemoryNote, MemoryNoteSummary } from "../../../shared/memory";
import { MarkdownText } from "../content/markdown-text";
import { IconButton } from "../primitives";
import { errorText } from "../review/review-conversation-data";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { MEMORY_KIND_LABELS, memoryDate, memoryScopeLabel } from "./memory-settings-item";

/** A note opened from Settings → Memory: read it whole, or delete it. Laid
 *  out like the role editor; nothing here edits a note (members do). */
export function MemoryNoteDialog(props: {
  note: MemoryNoteSummary | undefined;
  roleLabels: Record<string, string>;
  chatTitles: Record<string, string>;
  onClose: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const { note } = props;
  const [full, setFull] = useState<MemoryNote | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setFull(undefined);
    setError(undefined);
    if (!note) return;
    let cancelled = false;
    void window.consensus.readMemoryNote({ noteId: note.id })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setFull(result.value);
        else setError(result.error.message);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [note?.id, note?.version]);

  async function remove(): Promise<void> {
    if (!note) return;
    setDeleting(true);
    setError(undefined);
    try {
      const result = await window.consensus.deleteMemoryNote({ noteId: note.id });
      if (!result.ok) {
        setError(result.error.message);
        throw new Error(result.error.message);
      }
      props.onDeleted();
    } catch (caught) {
      setError((current) => current ?? errorText(caught));
      throw caught;
    } finally {
      setDeleting(false);
    }
  }

  // What was read just now wins over the list's summary of it.
  const shown: MemoryNoteSummary | undefined = full ?? note;
  const meta = shown ? [
    memoryScopeLabel(shown, props.roleLabels, props.chatTitles),
    `@${shown.author}${shown.updatedBy !== shown.author && shown.updatedBy !== "server" ? `, changed by @${shown.updatedBy}` : ""}`,
    `updated ${memoryDate(shown.updatedAt)}`,
    ...(shown.verifiedAt ? [`checked ${memoryDate(shown.verifiedAt)}`] : []),
    ...(shown.awaitingRepository ? ["waits for the repository"] : []),
    ...(shown.archivedAt ? [`archived ${memoryDate(shown.archivedAt)}`] : [])
  ] : [];
  return (
    <>
      <Dialog open={Boolean(note)} onOpenChange={(nextOpen) => { if (!nextOpen) props.onClose(); }}>
        <DialogContent className="roles-editor-dialog" data-testid="memory-note-dialog" showCloseButton={false}>
          <DialogHeader className="roles-editor-head">
            <div className="roles-editor-title-row">
              <span className="roles-editor-title-text">
                <DialogTitle>{shown?.title ?? ""}</DialogTitle>
              </span>
              {shown && <span className="roles-kind-badge is-built-in">{MEMORY_KIND_LABELS[shown.kind]}</span>}
              <DialogClose asChild>
                <IconButton className="roles-editor-close" label="Close note" icon={X} data-testid="memory-note-close" />
              </DialogClose>
            </div>
          </DialogHeader>
          <div className="roles-editor-body">
            <div className="memory-note-meta">{meta.join(" · ")}</div>
            {shown && shown.tags.length > 0 && <div className="memory-note-meta">{shown.tags.map((tag) => `#${tag}`).join(" ")}</div>}
            <div className="roles-preview-box markdown-preview is-readonly memory-note-body" data-testid="memory-note-body">
              {full ? <MarkdownText content={full.body} /> : <span className="memory-note-meta">{error ? "" : "Loading"}</span>}
            </div>
            {full?.source && <div className="memory-note-meta memory-note-source">Source: {full.source}</div>}
            {error && <div className="inline-error roles-editor-error">{error}</div>}
          </div>
          <DialogFooter className="roles-editor-footer">
            <Button type="button" variant="outline" size="sm" className="roles-editor-delete" disabled={!note || deleting}
              data-testid="memory-note-delete" onClick={() => setConfirmOpen(true)}>
              <Trash2 size={14} aria-hidden />
              Delete note
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" className="roles-editor-cancel" data-testid="memory-note-dialog-close">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteConfirmationDialog
        open={confirmOpen}
        title="Delete this note?"
        description="Members will no longer find it. This cannot be undone."
        confirmLabel="Delete note"
        pending={deleting}
        onOpenChange={setConfirmOpen}
        onConfirm={remove}
      />
    </>
  );
}
