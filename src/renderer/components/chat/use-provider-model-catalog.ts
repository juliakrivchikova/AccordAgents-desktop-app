import { useEffect, useState } from "react";

import type { ChatProviderKind, CliProviderHost, ProviderModelCatalog } from "../../../shared/types";
import { cliProviderHostModelCatalog } from "../../../shared/cliProviderHosts";

/** The added provider a model list is for; `id` lets the CLI's list be read
 *  with that provider's key. */
export type ProviderModelCatalogHost = Pick<CliProviderHost, "vendor" | "cli"> & { id?: string };

export interface ProviderModelCatalogState {
  catalog: ProviderModelCatalog | undefined;
  loading: boolean;
  error: string | undefined;
}

/** Why no model could be listed, in the CLI's own words, when detection failed
 *  and nothing was offered instead. */
export function modelDetectionFailureText(catalog: ProviderModelCatalog | undefined): string | undefined {
  if (!catalog?.error || catalog.models.length > 0) {
    return undefined;
  }
  const reason = catalog.error.replace(/\s+/g, " ").trim().replace(/([^.!?])$/, "$1.");
  return reason ? `Model detection unavailable: ${reason} Use manual override.` : "Model detection unavailable; use manual override.";
}

/** What a model picker says under its list: detecting, failed, or offering
 *  fallback models instead of the CLI's own. */
export function modelCatalogStatus(catalog: ProviderModelCatalog | undefined, loading: boolean, error: string | undefined): string | undefined {
  if (loading) {
    return "Detecting available models...";
  }
  if (error) {
    return "Model detection failed; use manual override.";
  }
  if (catalog?.error) {
    return modelDetectionFailureText(catalog) ?? "Using fallback models; exact detection failed.";
  }
  if (catalog && catalog.models.length === 0) {
    return "No models detected; use manual override.";
  }
  return undefined;
}

/** Model catalog for a member: the vendor's fixed list for a member on an added
 *  provider whose vendor has one, otherwise the CLI's own list (first-party
 *  vendors and built-in members) — read with the provider's key when the CLI
 *  lists other models on a key (Antigravity). Keyed on the vendor and provider
 *  so name edits and model changes do not refetch. */
export function useProviderModelCatalog(kind: ChatProviderKind, host: ProviderModelCatalogHost | undefined): ProviderModelCatalogState {
  const vendor = host && host.cli === kind ? host.vendor : undefined;
  // Only Antigravity lists other models on a key than on its sign-in.
  const hostId = vendor && kind === "gemini-cli" ? host?.id : undefined;
  const [state, setState] = useState<ProviderModelCatalogState>({ catalog: undefined, loading: false, error: undefined });

  useEffect(() => {
    const fixed = vendor ? cliProviderHostModelCatalog({ vendor, cli: kind as CliProviderHost["cli"] }) : undefined;
    if (fixed) {
      setState({ catalog: fixed, loading: false, error: undefined });
      return;
    }
    let cancelled = false;
    setState({ catalog: undefined, loading: true, error: undefined });
    void window.consensus.listProviderModels(kind, hostId)
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
  }, [kind, vendor, hostId]);

  return state;
}
