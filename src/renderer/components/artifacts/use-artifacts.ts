import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArtifactSummary } from "../../../shared/types";
import type { ArtifactsContextValue } from "./artifacts-context";

/** A local file the panel shows (a link from a local member's message). */
export interface PanelFileTarget {
  kind: "file";
  path: string;
  line?: number;
  column?: number;
  /** Opened from this thread: the panel offers to go back to it. */
  returnThreadRootId?: string;
}

/** An image attached to a message. */
export interface PanelAttachmentTarget {
  kind: "attachment";
  attachmentId: string;
  filename: string;
  dataUrl: string;
  description?: string;
  returnThreadRootId?: string;
}

/** What the side panel shows instead of artifacts. One thing at a time. */
export type PanelFileLikeTarget = PanelFileTarget | PanelAttachmentTarget;

export interface ArtifactsState {
  artifacts: ArtifactSummary[];
  context: ArtifactsContextValue;
  panelOpen: boolean;
  selectedId?: string;
  /** Set while the panel shows a file or an attachment instead of artifacts. */
  fileTarget?: PanelFileLikeTarget;
  openPanel: () => void;
  closePanel: () => void;
  openArtifact: (artifactId: string) => void;
  openFile: (target: Omit<PanelFileTarget, "kind">) => void;
  openAttachment: (target: Omit<PanelAttachmentTarget, "kind">) => void;
  selectArtifact: (artifactId: string | undefined) => void;
  refresh: () => Promise<void>;
}

export function useArtifacts(conversationId: string | undefined): ArtifactsState {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [fileTarget, setFileTarget] = useState<PanelFileLikeTarget | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setArtifacts([]);
      return;
    }
    try {
      const result = await window.consensus.listArtifacts({ conversationId });
      if (result.ok) {
        setArtifacts(result.value);
      }
    } catch (error) {
      console.error("Failed to list artifacts.", error);
    }
  }, [conversationId]);

  useEffect(() => {
    setArtifacts([]);
    setPanelOpen(false);
    setSelectedId(undefined);
    setFileTarget(undefined);
    void refresh();
  }, [conversationId, refresh]);

  useEffect(() => {
    return window.consensus.onArtifactsUpdated((event) => {
      if (event.conversationId === conversationId) {
        void refresh();
      }
    });
  }, [conversationId, refresh]);

  const openArtifact = useCallback((artifactId: string) => {
    setFileTarget(undefined);
    setSelectedId(artifactId);
    setPanelOpen(true);
  }, []);

  const openFile = useCallback((target: Omit<PanelFileTarget, "kind">) => {
    setFileTarget({ kind: "file", ...target });
    setPanelOpen(true);
  }, []);

  const openAttachment = useCallback((target: Omit<PanelAttachmentTarget, "kind">) => {
    setFileTarget({ kind: "attachment", ...target });
    setPanelOpen(true);
  }, []);

  const openPanel = useCallback(() => {
    // The top bar's Artifacts button shows artifacts, whatever was open before.
    setFileTarget(undefined);
    setPanelOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setFileTarget(undefined);
  }, []);

  const byId = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);
  const context = useMemo<ArtifactsContextValue>(() => ({ byId, openArtifact }), [byId, openArtifact]);

  return {
    artifacts,
    context,
    panelOpen,
    selectedId,
    fileTarget,
    openPanel,
    closePanel,
    openArtifact,
    openFile,
    openAttachment,
    selectArtifact: useCallback((artifactId: string | undefined) => setSelectedId(artifactId), []),
    refresh
  };
}
