import { useEffect, useState } from "react";

import type { ScheduledScriptSummary } from "../../../shared/scripts";
import { errorText } from "../review/review-conversation-data";
import { ScriptSettingsItem } from "./scripts-settings-item";

/** Settings → Scripts: every scheduled script, on this computer and on its
 *  machines, its state, history and keys, with the direct controls (on/off,
 *  Run now, Delete). Each item names the host it runs on. */
export function ScriptsSettingsSection(): JSX.Element {
  const [scripts, setScripts] = useState<ScheduledScriptSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void window.consensus.listScripts()
      .then((items) => {
        if (!cancelled) setScripts(items);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorText(caught));
      });
    const off = window.consensus.onScriptsUpdated((event) => {
      if (!cancelled) setScripts(event.scripts);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return (
    <section className="gen-section" data-testid="scripts-settings">
      <div className="gen-section-head">
        <h2 className="gen-section-title">Scheduled scripts</h2>
        <span className="gen-section-meta">
          {scripts ? `${scripts.length} ${scripts.length === 1 ? "script" : "scripts"}` : "Loading"}
        </span>
      </div>
      <p className="scripts-settings-meta">
        Small programs a chat member wrote for you and you approved. They run on a schedule and wake members only when they find
        something. To add one, ask a member in a chat, for example: “check #alerts every minute and wake @taylor when something fires”.
      </p>
      {error && <div className="scripts-settings-error">{error}</div>}
      {scripts && scripts.length === 0 && (
        <div className="gen-card">
          <div className="gen-row">
            <div className="gen-row-text">
              <div className="gen-row-desc">No scheduled scripts yet.</div>
            </div>
          </div>
        </div>
      )}
      <div className="scripts-settings-list">
        {scripts?.map((script) => (
          <ScriptSettingsItem key={script.id} script={script} onError={setError} />
        ))}
      </div>
    </section>
  );
}
