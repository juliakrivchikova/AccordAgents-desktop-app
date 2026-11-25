import { HubArtifacts } from "../hubArtifacts";
import type { StorageService } from "../../main/services/storage";

/** What operations are given by the server. */
export interface HubOpsDependencies {
  readonly storage: StorageService;
  readonly log: (event: string, payload: Record<string, unknown>) => void;
  readonly now: () => Date;
  /** Every chat's documents, which the server owns too (Д9). */
  readonly artifacts: HubArtifacts;
}
