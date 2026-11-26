import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SemanticSettingsView } from "../../../shared/memory";
import { useSemanticSearchSettings } from "../../app/use-semantic-search-settings";
import { cleanIpcError } from "../../lib/ipc-error";

/** What the row says about the server's prints (never the key). */
export function semanticStatusLine(view: SemanticSettingsView): string | undefined {
  if (!view.keySet || view.keyError) return undefined;
  const counted = `${view.notesPrinted ?? 0} notes and ${view.messagesPrinted ?? 0} messages`;
  const state = view.catchingUp ? `Key entered. Preparing older notes and messages: ${counted} so far.` : `Key entered. ${counted} can be found by meaning.`;
  return view.lastError ? `${state} Last try: ${view.lastError}` : state;
}

/**
 * Search by meaning in General (the User, 2026-11-26): her OpenAI key goes
 * to her server, which searches; the row shows only that a key is entered.
 */
export const SemanticSearchRow = (): JSX.Element => {
  const { result, setResult } = useSemanticSearchSettings();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const view = result?.status === "ok" ? result.view : undefined;
  const unavailable = result?.status === "unavailable" ? result.message ?? "Your server could not be reached." : undefined;
  const entering = !view?.keySet || Boolean(view.keyError);

  const act = async (action: () => ReturnType<typeof window.consensus.removeSemanticSearchKey>): Promise<void> => {
    setPending(true);
    setError(undefined);
    try {
      const answer = await action();
      if (answer.ok) {
        setResult({ status: "ok", view: answer.value });
        setDraft("");
      } else {
        setError(answer.error.message);
      }
    } catch (caught) {
      setError(cleanIpcError(caught));
    } finally {
      setPending(false);
    }
  };

  const status = view ? semanticStatusLine(view) : undefined;
  return (
    <>
      <div className="gen-card-divider" />
      <div className="gen-row" data-testid="semantic-search-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Search by meaning</div>
          <div className="gen-row-desc">
            Members find memory notes and messages of the project’s chats by meaning, in any language, and get the notes that fit each message.
            Your server keeps your OpenAI API key and sends your memory notes and chat messages to OpenAI (text-embedding-3-small) for this:
            about 8 cents once for all your chats, then under a cent a month.
          </div>
          {status ? <div className="gen-row-desc mt-1" data-testid="semantic-search-status">{status}</div> : null}
          {view?.keyError ? <div className="gen-row-error" role="alert">OpenAI stopped accepting the key: {view.keyError} Enter a new one.</div> : null}
          {unavailable ? <div className="gen-row-error" role="alert">{unavailable}</div> : null}
          {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
        </div>
        <div className="gen-row-control gap-2">
          {entering ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.trim()) void act(() => window.consensus.setSemanticSearchKey({ key: draft.trim() }));
              }}
            >
              <Input
                type="password"
                className="w-52"
                value={draft}
                aria-label="OpenAI API key"
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
                disabled={pending || !result || Boolean(unavailable)}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={pending || !draft.trim() || Boolean(unavailable)} data-testid="semantic-search-save">
                Save
              </Button>
            </form>
          ) : null}
          {/* A key OpenAI stopped accepting can be removed too, not only replaced. */}
          {view?.keySet ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              data-testid="semantic-search-remove"
              onClick={() => void act(() => window.consensus.removeSemanticSearchKey())}
            >
              Remove key
            </Button>
          ) : null}
        </div>
      </div>
    </>
  );
};
