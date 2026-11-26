import { createContext, useContext } from "react";

import type { AgentHealth, CliProviderHost, ProviderSettings, SubagentProviderChange } from "../../../shared/types";

/** What the side panel's Agents need from the app: the CLIs found here (the
 *  list is those that are ready), how to change the chat's list, and where a
 *  CLI is set up. Rarely changes, so a context rather than props through the view. */
export interface SubagentProvidersActions {
  agents: readonly AgentHealth[];
  providers: readonly ProviderSettings[];
  /** Added providers: a main session on one has its own CLI ready through it. */
  hosts: readonly CliProviderHost[];
  update: (change: SubagentProviderChange) => Promise<boolean>;
  /** Settings → General, where a CLI is installed and signed in. */
  openSetup: () => void;
}

export const SubagentProvidersContext = createContext<SubagentProvidersActions | undefined>(undefined);

export function useSubagentProvidersActions(): SubagentProvidersActions | undefined {
  return useContext(SubagentProvidersContext);
}
