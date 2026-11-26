import { createContext, useContext } from "react";

import type { AgentHealth, ProviderSettings, SubagentProviderChange, SubagentProviderScope } from "../../../shared/types";

/** What the side panel's Agents need from the app: the CLIs found here (for
 *  Add), how to change the chat's or its project's list, and where a CLI is
 *  set up. Rarely changes, so a context rather than props through the view. */
export interface SubagentProvidersActions {
  agents: readonly AgentHealth[];
  providers: readonly ProviderSettings[];
  update: (scope: SubagentProviderScope, change: SubagentProviderChange) => Promise<boolean>;
  /** Settings → General, where a CLI is installed and signed in. */
  openSetup: () => void;
}

export const SubagentProvidersContext = createContext<SubagentProvidersActions | undefined>(undefined);

export function useSubagentProvidersActions(): SubagentProvidersActions | undefined {
  return useContext(SubagentProvidersContext);
}
