import { useEffect, useState } from "react";

import type { SemanticSettingsResult } from "../../shared/memory";
import { cleanIpcError } from "../lib/ipc-error";

/** While older notes and messages are printed, the counts are read again this often. */
const CATCHING_UP_REFRESH_MS = 5_000;

function load(apply: (result: SemanticSettingsResult) => void): void {
  void window.consensus.getSemanticSearchSettings().then(apply).catch((caught: unknown) => {
    apply({ status: "unavailable", message: cleanIpcError(caught) });
  });
}

/** Search by meaning as the User's server has it (Settings → General). */
export function useSemanticSearchSettings(): {
  result: SemanticSettingsResult | undefined;
  setResult: (result: SemanticSettingsResult) => void;
} {
  const [result, setResult] = useState<SemanticSettingsResult>();
  const catchingUp = result?.status === "ok" && Boolean(result.view?.catchingUp);
  useEffect(() => {
    let current = true;
    load((value) => { if (current) setResult(value); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!catchingUp) return undefined;
    let current = true;
    const timer = setInterval(() => load((value) => { if (current) setResult(value); }), CATCHING_UP_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [catchingUp]);
  return { result, setResult };
}
