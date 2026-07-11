import { createContext } from "react";
import type { ArtifactSummary } from "../../../shared/types";

// Shared by the chat timeline (artifact link chips) and the artifacts panel.
// Links resolve the artifact's CURRENT name from byId at render time, so a
// rename updates every existing reference without rewriting messages.
export interface ArtifactsContextValue {
  byId: ReadonlyMap<string, ArtifactSummary>;
  openArtifact: (artifactId: string) => void;
}

export const ArtifactsContext = createContext<ArtifactsContextValue | undefined>(undefined);
