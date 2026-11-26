import { createContext } from "react";
import type { ArtifactSummary } from "../../../shared/types";

/** Where an opened document lands: one of its versions, or the newest draft
 *  a member submitted to it (an Accord's card opens both). Without one it
 *  opens as it is. */
export type ArtifactFocus = { version: number } | { draftAuthor: string };

// Shared by the chat timeline (artifact link chips) and the artifacts panel.
// Links resolve the artifact's CURRENT name from byId at render time, so a
// rename updates every existing reference without rewriting messages.
export interface ArtifactsContextValue {
  byId: ReadonlyMap<string, ArtifactSummary>;
  openArtifact: (artifactId: string, focus?: ArtifactFocus) => void;
}

export const ArtifactsContext = createContext<ArtifactsContextValue | undefined>(undefined);
