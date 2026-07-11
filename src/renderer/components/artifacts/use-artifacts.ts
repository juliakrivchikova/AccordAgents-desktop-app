import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArtifactSummary } from "../../../shared/types";
import type { ArtifactsContextValue } from "./artifacts-context";

export interface ArtifactsState {
  artifacts: ArtifactSummary[];
  context: ArtifactsContextValue;
  panelOpen: boolean;
  selectedId?: string;
  openPanel: () => void;
  closePanel: () => void;
  openArtifact: (artifactId: string) => void;
  selectArtifact: (artifactId: string | undefined) => void;
  refresh: () => Promise<void>;
}

export function useArtifacts(conversationId: string | undefined): ArtifactsState {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

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
    setSelectedId(artifactId);
    setPanelOpen(true);
  }, []);

  const byId = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);
  const context = useMemo<ArtifactsContextValue>(() => ({ byId, openArtifact }), [byId, openArtifact]);

  return {
    artifacts,
    context,
    panelOpen,
    selectedId,
    openPanel: useCallback(() => setPanelOpen(true), []),
    closePanel: useCallback(() => setPanelOpen(false), []),
    openArtifact,
    selectArtifact: useCallback((artifactId: string | undefined) => setSelectedId(artifactId), []),
    refresh
  };
}
