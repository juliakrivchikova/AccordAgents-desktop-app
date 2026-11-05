import { useEffect, useState } from "react";

import type { ClaudeChromeSetting } from "../../../shared/types";
import { cleanIpcError } from "../../lib/ipc-error";

/**
 * Claude in Chrome for members on Claude on this computer: the same
 * "Enabled by default" as `/chrome` in Claude Code, read from and written
 * through the CLI itself. A member picks a change up with its next message
 * once it is not busy.
 */
export function ClaudeChromeRow(): JSX.Element {
  const [setting, setSetting] = useState<ClaudeChromeSetting>();
  const [requested, setRequested] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    void window.consensus.getClaudeChromeSetting().then((value) => {
      if (current) setSetting(value);
    }).catch((caught: unknown) => {
      if (current) setError(`Could not read the setting from Claude Code: ${cleanIpcError(caught)}`);
    });
    return () => { current = false; };
  }, []);

  async function change(enabled: boolean): Promise<void> {
    setRequested(enabled);
    setError(undefined);
    try {
      setSetting(await window.consensus.setClaudeChromeEnabledByDefault(enabled));
    } catch (caught) {
      setError(cleanIpcError(caught));
    } finally {
      setRequested(undefined);
    }
  }

  const checked = requested ?? setting?.enabledByDefault ?? false;
  return (
    <>
      <div className="gen-card-divider" />
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-title">Claude in Chrome</div>
          <div className="gen-row-desc">
            Lets members on Claude on this computer use your Chrome, as “Enabled by default” in /chrome does in Claude Code (the same setting).
            Members get it with their next message; a member still answering or running background tasks gets it once those finish.
            {setting?.environmentDecides ? " CLAUDE_CODE_ENABLE_CFC in your environment decides it instead." : ""}
          </div>
          {error ? <div className="gen-row-error" role="alert">{error}</div> : null}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            data-testid="claude-chrome-toggle"
            aria-label="Claude in Chrome"
            checked={checked}
            disabled={!setting || requested !== undefined}
            onChange={(event) => void change(event.target.checked)}
          />
          <span />
        </label>
      </div>
    </>
  );
}
