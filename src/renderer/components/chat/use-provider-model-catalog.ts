import { useEffect, useState } from "react";

import type { ChatParticipantEndpoint, ChatProviderKind, ProviderModelCatalog } from "../../../shared/types";
import { chatParticipantEndpointFor, chatParticipantEndpointModelCatalog } from "../../../shared/chatParticipantEndpoint";

export interface ProviderModelCatalogState {
  catalog: ProviderModelCatalog | undefined;
  loading: boolean;
  error: string | undefined;
}

/** Model catalog for a member: the CLI's own list, or the endpoint's fixed list
 *  for an endpoint member (the CLI catalog would describe Anthropic models the
 *  endpoint does not serve). Keyed on the preset, so URL / variable edits and
 *  model changes do not refetch. */
export function useProviderModelCatalog(kind: ChatProviderKind, endpoint: ChatParticipantEndpoint | undefined): ProviderModelCatalogState {
  const endpointPreset = chatParticipantEndpointFor(kind, endpoint)?.preset;
  const [state, setState] = useState<ProviderModelCatalogState>({ catalog: undefined, loading: false, error: undefined });

  useEffect(() => {
    if (endpointPreset) {
      setState({ catalog: chatParticipantEndpointModelCatalog(endpointPreset), loading: false, error: undefined });
      return;
    }
    let cancelled = false;
    setState({ catalog: undefined, loading: true, error: undefined });
    void window.consensus.listProviderModels(kind)
      .then((catalog) => {
        if (!cancelled) {
          setState({ catalog, loading: false, error: undefined });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ catalog: undefined, loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [endpointPreset, kind]);

  return state;
}
