import { useEffect, useState } from "react";

import type { ChatProviderKind, CliProviderHost, ProviderModelCatalog } from "../../../shared/types";
import { cliProviderHostModelCatalog } from "../../../shared/cliProviderHosts";

export interface ProviderModelCatalogState {
  catalog: ProviderModelCatalog | undefined;
  loading: boolean;
  error: string | undefined;
}

/** Model catalog for a member: the vendor's fixed list for a member on an added
 *  provider whose vendor has one, otherwise the CLI's own list (first-party
 *  vendors and built-in members). Keyed on the vendor so URL / name edits and
 *  model changes do not refetch. */
export function useProviderModelCatalog(kind: ChatProviderKind, host: Pick<CliProviderHost, "vendor" | "cli"> | undefined): ProviderModelCatalogState {
  const vendor = host && host.cli === kind ? host.vendor : undefined;
  const [state, setState] = useState<ProviderModelCatalogState>({ catalog: undefined, loading: false, error: undefined });

  useEffect(() => {
    const fixed = vendor ? cliProviderHostModelCatalog({ vendor, cli: kind as CliProviderHost["cli"] }) : undefined;
    if (fixed) {
      setState({ catalog: fixed, loading: false, error: undefined });
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
  }, [kind, vendor]);

  return state;
}
