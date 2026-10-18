import { useState } from "react";
import { History, Play, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { scriptHealthLabel, type ScheduledScriptSummary, type ScriptRunRow } from "../../../shared/scripts";
import { errorText } from "../review/review-conversation-data";

function when(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function runLabel(row: ScriptRunRow): string {
  const status = row.status === "ok" ? "OK" : row.status.charAt(0).toUpperCase() + row.status.slice(1);
  const count = row.count > 1 ? ` ×${row.count}` : "";
  const sent = row.messagesSent > 0 ? ` · ${row.messagesSent} sent` : "";
  const range = row.count > 1 ? `${when(row.firstAt)} – ${when(row.lastAt)}` : when(row.lastAt);
  return `${status}${count}${sent} · ${range}`;
}

export function ScriptSettingsItem(props: {
  script: ScheduledScriptSummary;
  onError: (message: string | undefined) => void;
}): JSX.Element {
  const { script } = props;
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<ScriptRunRow[] | undefined>();
  const [showRuns, setShowRuns] = useState(false);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    props.onError(undefined);
    try {
      await action();
    } catch (caught) {
      props.onError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleRuns(): Promise<void> {
    if (showRuns) {
      setShowRuns(false);
      return;
    }
    await act(async () => {
      setRuns(await window.consensus.getScriptRuns({ scriptId: script.id }));
      setShowRuns(true);
    });
  }

  const chats = script.permissions.chatIds.map((chatId) => script.chatLabels[chatId] ?? chatId).join(", ");
  const members = script.permissions.participantIds.map((id) => script.participantLabels[id] ?? id).join(", ");

  return (
    <div className="gen-card scripts-settings-item" data-testid={`script-${script.id}`}>
      <div className="gen-row">
        <div className="gen-row-text scripts-settings-item-title">
          <strong>{script.name}</strong>
          <span>{script.description}</span>
        </div>
        <div className="scripts-settings-head-controls">
          <span className={`scripts-settings-status is-${script.running ? "running" : script.health}`} data-testid="script-health">
            {script.running ? "Running" : scriptHealthLabel(script.health)}
          </span>
          {script.approved && (
            <label className="toggle" title={script.enabled ? "Switch off" : "Switch on"}>
              <input
                type="checkbox"
                aria-label={`Switch ${script.name} ${script.enabled ? "off" : "on"}`}
                checked={script.enabled}
                disabled={busy}
                onChange={(event) => void act(() => window.consensus.setScriptEnabled({ scriptId: script.id, enabled: event.target.checked }))}
              />
              <span />
            </label>
          )}
        </div>
      </div>
      <div className="gen-row">
        <div className="gen-row-text">
          <div className="gen-row-desc">
            {script.hostLabel} · {script.scheduleText} · next run {when(script.nextRunAt)} · last run {when(script.lastRunAt)}
            {script.lastRunStatus ? ` (${script.lastRunStatus})` : ""}
          </div>
          <div className="gen-row-desc">
            Posts to {chats || "—"} · may wake {members || "nobody"} · at most {script.permissions.maxWakeupsPerHour} wake-ups per hour
            {script.createdByLabel ? ` · created by ${script.createdByLabel}` : ""}
          </div>
          {script.lastError && <div className="scripts-settings-error">{script.lastError}</div>}
        </div>
      </div>
      {script.secretNames.length > 0 && (
        <div className="gen-row">
          <div className="gen-row-text">
            {script.secretNames.map((name) => {
              const saved = script.savedSecretNames.includes(name);
              const draft = keyDrafts[name];
              return (
                <div className="chat-script-approval-key" key={name}>
                  <code>{name}</code>
                  {draft === undefined ? (
                    <span className="chat-script-approval-key-saved">
                      {saved ? "Saved" : "Missing"}
                      <button type="button" className="chat-script-approval-link" onClick={() => setKeyDrafts((current) => ({ ...current, [name]: "" }))}>
                        {saved ? "Replace" : "Enter"}
                      </button>
                      {saved && (
                        <button type="button" className="chat-script-approval-link" disabled={busy}
                          onClick={() => void act(() => window.consensus.deleteScriptSecret({ scriptId: script.id, name }))}>
                          Remove
                        </button>
                      )}
                    </span>
                  ) : (
                    <span className="chat-script-approval-key-entry">
                      <input type="password" autoComplete="off" spellCheck={false} aria-label={`Value for ${name}`} placeholder="Paste value"
                        value={draft} onChange={(event) => setKeyDrafts((current) => ({ ...current, [name]: event.target.value }))} />
                      <button type="button" className="chat-script-approval-save-key" disabled={busy || !draft.trim()}
                        onClick={() => void act(async () => {
                          await window.consensus.setScriptSecret({ scriptId: script.id, name, value: draft });
                          setKeyDrafts((current) => {
                            const next = { ...current };
                            delete next[name];
                            return next;
                          });
                        })}>
                        Save
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {script.heldMessageCount > 0 && (
        <div className="gen-row">
          <div className="gen-row-text">
            <div className="gen-row-title">{script.heldMessageCount} held {script.heldMessageCount === 1 ? "message" : "messages"}</div>
            <div className="gen-row-desc">Over the hourly wake-up limit. Held messages are dropped after 24 hours.</div>
          </div>
          <div className="scripts-settings-actions">
            <Button type="button" variant="outline" size="sm" disabled={busy}
              onClick={() => void act(() => window.consensus.releaseHeldScriptMessages({ scriptId: script.id }))}>Release</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy}
              onClick={() => void act(() => window.consensus.discardHeldScriptMessages({ scriptId: script.id }))}>Discard</Button>
          </div>
        </div>
      )}
      <div className="gen-row">
        <div className="scripts-settings-actions">
          {script.approved && script.enabled && (
            <Button type="button" variant="outline" size="sm" disabled={busy || script.running}
              onClick={() => void act(() => window.consensus.runScriptNow({ scriptId: script.id }))}>
              <Play size={14} aria-hidden /> Run now
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void toggleRuns()}>
            <History size={14} aria-hidden /> {showRuns ? "Hide history" : "History"}
          </Button>
          {confirmDelete ? (
            <>
              <span className="gen-row-desc">Delete the script, its keys and history?</span>
              <Button type="button" variant="destructive" size="sm" disabled={busy}
                onClick={() => void act(() => window.consensus.deleteScript({ scriptId: script.id }))}>Delete</Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</Button>
            </>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} aria-hidden /> Delete
            </Button>
          )}
        </div>
      </div>
      {showRuns && (
        <ul className="scripts-settings-runs" data-testid="script-runs">
          {(runs ?? []).length === 0 && <li className="scripts-settings-meta">No runs yet.</li>}
          {(runs ?? []).map((row) => (
            <li className="scripts-settings-run" key={row.id}>
              <span>{runLabel(row)}{row.exitCode !== undefined && row.exitCode !== null ? ` · exit ${row.exitCode}` : ""}</span>
              {row.detail && <span className="scripts-settings-meta">{row.detail}</span>}
              {row.outputTail && <pre>{row.outputTail}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
