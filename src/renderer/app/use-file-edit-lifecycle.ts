import { useEffect, useRef } from "react";
import { toast } from "sonner";

import type { ArtifactsState } from "../components/artifacts/use-artifacts";
import { fileEditBuffers, type FileEditBuffer } from "../components/files/file-edit-buffers";

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/**
 * The file panel's edits across the app's life:
 * - the main process asks the window to save every open file before it closes,
 *   quits or restarts for an update;
 * - edits left unsaved by a crash or a refused save come back at start;
 * - a save that finds the file changed after its panel was closed says so.
 */
export function useFileEditLifecycle(props: {
  conversationId: string | undefined;
  artifacts: ArtifactsState;
  openChat: (conversationId: string) => void;
}): void {
  const pendingOpen = useRef<{ conversationId: string; realPath: string } | undefined>();
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => window.consensus.onFlushFileEdits((requestId) => {
    void fileEditBuffers.flushAll().finally(() => window.consensus.fileEditsFlushed(requestId));
  }), []);

  useEffect(() => {
    const open = (buffer: Pick<FileEditBuffer, "conversationId" | "realPath">): void => {
      const current = latest.current;
      if (current.conversationId === buffer.conversationId) {
        current.artifacts.openFile({ path: buffer.realPath });
        return;
      }
      pendingOpen.current = { conversationId: buffer.conversationId, realPath: buffer.realPath };
      current.openChat(buffer.conversationId);
    };

    fileEditBuffers.onBackgroundConflict((buffer) => {
      toast.warning(`Your edits to ${basename(buffer.realPath)} are not saved: the file changed on disk.`, {
        duration: Infinity,
        action: { label: "Open", onClick: () => open(buffer) }
      });
    });

    let cancelled = false;
    void window.consensus.listUnsavedFileEdits().then((edits) => {
      if (cancelled) return;
      for (const edit of edits) {
        fileEditBuffers.restore(edit);
        toast.info(`Unsaved edits in ${basename(edit.realPath)} from your last session.`, {
          duration: Infinity,
          action: { label: "Open", onClick: () => open(edit) },
          cancel: { label: "Discard", onClick: () => { void fileEditBuffers.discard(edit.realPath); } }
        });
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      fileEditBuffers.onBackgroundConflict(undefined);
    };
  }, []);

  // A file asked for in another chat opens once that chat is shown.
  useEffect(() => {
    const pending = pendingOpen.current;
    if (!pending || pending.conversationId !== props.conversationId) return;
    pendingOpen.current = undefined;
    props.artifacts.openFile({ path: pending.realPath });
  }, [props.conversationId, props.artifacts.openFile]);
}
