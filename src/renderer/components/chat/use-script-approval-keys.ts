import { useEffect, useState } from "react";

import type { ChatScriptChangeRequest } from "../../../shared/scripts";

export interface ScriptApprovalKeys {
  names: string[];
  isSaved: (name: string) => boolean;
  valueOf: (name: string) => string;
  onChange: (name: string, value: string) => void;
  /** A saved key typed again. */
  replace: (name: string) => void;
  /** Every key is saved or typed. */
  complete: boolean;
  saving: boolean;
  error?: string;
  /** Saves what was typed; false when a key could not be saved. */
  save: () => Promise<boolean>;
}

/** The keys a scheduled task asks for on its card: typed here, saved straight
 *  to the computer that runs the task; they never travel with the decision. */
export function useScriptApprovalKeys(request: ChatScriptChangeRequest, hostId: string | undefined, asks: boolean): ScriptApprovalKeys {
  const [savedNames, setSavedNames] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const { scriptId } = request;

  useEffect(() => {
    if (!asks || typeof window.consensus?.listScripts !== "function") return undefined;
    let cancelled = false;
    const apply = (scripts: Array<{ id: string; savedSecretNames: string[] }>): void => {
      const summary = scripts.find((item) => item.id === scriptId);
      if (!cancelled && summary) setSavedNames(summary.savedSecretNames);
    };
    void window.consensus.listScripts().then(apply).catch(() => undefined);
    const off = window.consensus.onScriptsUpdated((event) => apply(event.scripts));
    return () => {
      cancelled = true;
      off();
    };
  }, [asks, scriptId]);

  const names = asks ? request.secretNames : [];
  const typed = (name: string): boolean => Boolean(drafts[name]?.trim());
  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(undefined);
    try {
      for (const name of names.filter(typed)) {
        const summary = await window.consensus.setScriptSecret({ scriptId, ...(hostId ? { hostId } : {}), name, value: drafts[name]! });
        setSavedNames(summary.savedSecretNames);
        setDrafts((current) => ({ ...current, [name]: undefined }));
      }
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return {
    names,
    isSaved: (name) => savedNames.includes(name) && drafts[name] === undefined,
    valueOf: (name) => drafts[name] ?? "",
    onChange: (name, value) => setDrafts((current) => ({ ...current, [name]: value })),
    replace: (name) => setDrafts((current) => ({ ...current, [name]: "" })),
    complete: names.every((name) => savedNames.includes(name) || typed(name)),
    saving,
    error,
    save
  };
}
