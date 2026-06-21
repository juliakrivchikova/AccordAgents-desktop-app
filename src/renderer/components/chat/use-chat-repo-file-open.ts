import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import type { RepoFileOpenAction } from "../../../shared/types";
import type { FileLinkRef } from "../content/repo-file-link";

export function useChatRepoFileOpen(props: {
  conversationId: string;
  repoFileOpenAction: RepoFileOpenAction | null | undefined;
  setRepoFileOpenPreference: (action: RepoFileOpenAction | null) => Promise<void>;
}): {
  chooserFileRef: FileLinkRef | null;
  chooserOpen: boolean;
  chooseRepoFileOpenAction: (action: RepoFileOpenAction) => Promise<void>;
  handleRepoFileChooserOpenChange: (open: boolean) => void;
  repoFileLinkContext: {
    conversationId: string;
    requestOpenFile: (ref: FileLinkRef) => void;
  };
  resetRepoFileChooser: () => void;
} {
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserFileRef, setChooserFileRef] = useState<FileLinkRef | null>(null);

  const openRepoFileReference = useCallback(async (ref: FileLinkRef, action: RepoFileOpenAction): Promise<void> => {
    try {
      const result = await window.consensus.openRepoFile({
        conversationId: props.conversationId,
        path: ref.path,
        line: ref.line,
        column: ref.column,
        action
      });
      if (ref.line && !result.lineNavigationSupported) {
        toast.info(`Opened ${ref.path}. The default app cannot jump to line ${ref.line}.`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the file.");
    }
  }, [props.conversationId]);

  const requestOpenFile = useCallback((ref: FileLinkRef) => {
    const preference = props.repoFileOpenAction;
    if (preference) {
      void openRepoFileReference(ref, preference);
      return;
    }
    setChooserFileRef(ref);
    setChooserOpen(true);
  }, [openRepoFileReference, props.repoFileOpenAction]);

  const chooseRepoFileOpenAction = useCallback(async (action: RepoFileOpenAction): Promise<void> => {
    const ref = chooserFileRef;
    setChooserOpen(false);
    if (!ref) {
      return;
    }
    await props.setRepoFileOpenPreference(action);
    await openRepoFileReference(ref, action);
  }, [chooserFileRef, openRepoFileReference, props.setRepoFileOpenPreference]);

  const handleRepoFileChooserOpenChange = useCallback((open: boolean): void => {
    setChooserOpen(open);
  }, []);

  const resetRepoFileChooser = useCallback(() => {
    setChooserOpen(false);
    setChooserFileRef(null);
  }, []);

  const repoFileLinkContext = useMemo(() => ({
    conversationId: props.conversationId,
    requestOpenFile
  }), [props.conversationId, requestOpenFile]);

  return {
    chooserFileRef,
    chooserOpen,
    chooseRepoFileOpenAction,
    handleRepoFileChooserOpenChange,
    repoFileLinkContext,
    resetRepoFileChooser
  };
}
