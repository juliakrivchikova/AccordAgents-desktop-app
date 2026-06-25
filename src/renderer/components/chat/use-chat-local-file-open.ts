import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import type { LocalFileOpenAction, OpenLocalFileResult, RepoFileOpenAction } from "../../../shared/types";
import type { FileLinkRef } from "../content/local-file-link";

export function useChatLocalFileOpen(props: {
  conversationId: string;
  repoFileOpenAction: RepoFileOpenAction | null | undefined;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
}): {
  chooserFileRef: FileLinkRef | null;
  chooserOpen: boolean;
  chooseLocalFileOpenAction: (action: LocalFileOpenAction) => Promise<void>;
  handleLocalFileChooserOpenChange: (open: boolean) => void;
  localFileLinkContext: {
    conversationId: string;
    requestOpenFile: (ref: FileLinkRef) => void;
  };
  resetLocalFileChooser: () => void;
} {
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserFileRef, setChooserFileRef] = useState<FileLinkRef | null>(null);

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
      if (inspection.insideWorkspace && preference) {
        void openLocalFileReference(nextRef, preference);
        return;
      }
      setChooserFileRef(nextRef);
      setChooserOpen(true);
    }).catch((error) => {
      toast.error(error instanceof Error ? error.message : "Could not inspect the file.");
    });
  }, [openLocalFileReference, props.conversationId, props.repoFileOpenAction]);

  const chooseLocalFileOpenAction = useCallback(async (action: LocalFileOpenAction): Promise<void> => {
    const ref = chooserFileRef;
    setChooserOpen(false);
    if (!ref) {
      return;
    }
    const result = await openLocalFileReference(ref, action);
    if (ref.insideWorkspace && result?.action === action) {
      await props.setRepoFileOpenPreference(action);
    }
  }, [chooserFileRef, openLocalFileReference, props.setRepoFileOpenPreference]);

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
    resetLocalFileChooser
  };
}
