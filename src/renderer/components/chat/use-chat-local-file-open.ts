import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { filePreviewKindForPath } from "../../../shared/filePreview";
import type {
  LocalFileOpenAction,
  OpenLocalFileResult,
  RepoFileExternalOpenAction,
  RepoFileOpenAction
} from "../../../shared/types";
import type { FileLinkRef } from "../content/local-file-link";

export function useChatLocalFileOpen(props: {
  conversationId: string;
  repoFileOpenAction: RepoFileOpenAction | null | undefined;
  repoFileExternalOpenAction: RepoFileExternalOpenAction | null | undefined;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
  /** Shows the file in the chat's side panel. */
  openInPanel: (ref: FileLinkRef) => void;
}): {
  chooserFileRef: FileLinkRef | null;
  chooserOpen: boolean;
  chooseLocalFileOpenAction: (action: RepoFileOpenAction) => Promise<void>;
  handleLocalFileChooserOpenChange: (open: boolean) => void;
  localFileLinkContext: {
    conversationId: string;
    requestOpenFile: (ref: FileLinkRef) => void;
  };
  openFileOutside: (ref: FileLinkRef, action?: LocalFileOpenAction) => Promise<OpenLocalFileResult | undefined>;
  resetLocalFileChooser: () => void;
} {
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserFileRef, setChooserFileRef] = useState<FileLinkRef | null>(null);
  const externalAction: LocalFileOpenAction = props.repoFileExternalOpenAction ?? "open";

  const openLocalFileReference = useCallback(async (
    ref: FileLinkRef,
    action: LocalFileOpenAction
  ): Promise<OpenLocalFileResult | undefined> => {
    try {
      const result = await window.consensus.openLocalFile({
        conversationId: props.conversationId,
        path: ref.path,
        line: ref.line,
        column: ref.column,
        action
      });
      if (result.fallbackMessage) {
        toast.info(result.fallbackMessage);
      }
      if (ref.line && !result.lineNavigationSupported) {
        toast.info(`Opened ${result.absolutePath}. The default app cannot jump to line ${ref.line}.`);
      }
      return result;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the file.");
      return undefined;
    }
  }, [props.conversationId]);

  const openFileOutside = useCallback(
    (ref: FileLinkRef, action?: LocalFileOpenAction) => openLocalFileReference(ref, action ?? externalAction),
    [externalAction, openLocalFileReference]
  );

  const requestOpenFile = useCallback((ref: FileLinkRef) => {
    void window.consensus.inspectLocalFile({
      conversationId: props.conversationId,
      path: ref.path,
      line: ref.line,
      column: ref.column
    }).then((inspection) => {
      const nextRef: FileLinkRef = {
        ...ref,
        absolutePath: inspection.absolutePath,
        insideWorkspace: inspection.insideWorkspace
      };
      const preference = props.repoFileOpenAction;
      if (inspection.insideWorkspace && preference === "panel") {
        // Kinds the panel does not show (Excel, archives…) open the way they did before.
        if (filePreviewKindForPath(inspection.absolutePath) === "unsupported") {
          void openLocalFileReference(nextRef, externalAction);
        } else {
          props.openInPanel(nextRef);
        }
        return;
      }
      if (inspection.insideWorkspace && preference && preference !== "panel") {
        void openLocalFileReference(nextRef, preference);
        return;
      }
      setChooserFileRef(nextRef);
      setChooserOpen(true);
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : "Could not inspect the file.");
    });
  }, [externalAction, openLocalFileReference, props.conversationId, props.openInPanel, props.repoFileOpenAction]);

  const chooseLocalFileOpenAction = useCallback(async (action: RepoFileOpenAction): Promise<void> => {
    const ref = chooserFileRef;
    setChooserOpen(false);
    if (!ref) {
      return;
    }
    if (action === "panel") {
      props.openInPanel(ref);
      if (ref.insideWorkspace) {
        await props.setRepoFileOpenPreference("panel");
      }
      return;
    }
    const result = await openLocalFileReference(ref, action);
    if (ref.insideWorkspace && result?.action === action) {
      await props.setRepoFileOpenPreference(action);
    }
  }, [chooserFileRef, openLocalFileReference, props.openInPanel, props.setRepoFileOpenPreference]);

  const handleLocalFileChooserOpenChange = useCallback((open: boolean): void => {
    setChooserOpen(open);
  }, []);

  const resetLocalFileChooser = useCallback(() => {
    setChooserOpen(false);
    setChooserFileRef(null);
  }, []);

  const localFileLinkContext = useMemo(() => ({
    conversationId: props.conversationId,
    requestOpenFile
  }), [props.conversationId, requestOpenFile]);

  return {
    chooserFileRef,
    chooserOpen,
    chooseLocalFileOpenAction,
    handleLocalFileChooserOpenChange,
    localFileLinkContext,
    openFileOutside,
    resetLocalFileChooser
  };
}
