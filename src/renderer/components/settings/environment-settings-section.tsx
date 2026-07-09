import { useEffect, useMemo, useState } from "react";
import { KeyRound, Plus, RefreshCw, Search, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentEnvironmentKeyValidationError, normalizeAgentEnvironmentKey } from "../../../shared/agentEnvironment";
import type {
  AgentEnvironmentKey,
  AgentEnvironmentSnapshot,
  DeleteAgentEnvironmentVariableRequest,
  ManualAgentEnvironmentVariable,
  SaveAgentEnvironmentVariableRequest
} from "../../../shared/types";
import { errorText } from "../review/review-conversation-data";

export function EnvironmentSettingsSection(props: {
  getAgentEnvironment: () => Promise<AgentEnvironmentSnapshot>;
  saveAgentEnvironmentVariable: (request: SaveAgentEnvironmentVariableRequest) => Promise<AgentEnvironmentSnapshot>;
  deleteAgentEnvironmentVariable: (request: DeleteAgentEnvironmentVariableRequest) => Promise<AgentEnvironmentSnapshot>;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<AgentEnvironmentSnapshot | undefined>();
  const [search, setSearch] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyKey, setBusyKey] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const normalizedSearch = search.trim().toLowerCase();
  const visibleKeys = useMemo(() => {
    const keys = snapshot?.keys ?? [];
    if (!normalizedSearch) {
      return keys;
    }
    return keys.filter((item) => item.key.toLowerCase().includes(normalizedSearch));
  }, [normalizedSearch, snapshot?.keys]);

  useEffect(() => {
    void refresh();
  }, []);

  const validation = agentEnvironmentKeyValidationError(key);
  const canSave = !saving && !validation && Boolean(normalizeAgentEnvironmentKey(key));

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await props.getAgentEnvironment());
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }

  async function saveVariable(): Promise<void> {
    if (!canSave) {
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      setSnapshot(await props.saveAgentEnvironmentVariable({
        key: normalizeAgentEnvironmentKey(key),
        value,
        enabled: true
      }));
      setKey("");
      setValue("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }

  async function setVariableEnabled(variable: ManualAgentEnvironmentVariable, enabled: boolean): Promise<void> {
    setBusyKey(variable.key);
    setError(undefined);
    try {
      setSnapshot(await props.saveAgentEnvironmentVariable({
        key: variable.key,
        enabled
      }));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyKey(undefined);
    }
  }

  async function deleteVariable(variable: ManualAgentEnvironmentVariable): Promise<void> {
    setBusyKey(variable.key);
    setError(undefined);
    try {
      setSnapshot(await props.deleteAgentEnvironmentVariable({ key: variable.key }));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyKey(undefined);
    }
  }

  return (
    <section className="environment-settings-screen">
      <section className="gen-section">
        <div className="gen-section-head">
          <h2 className="gen-section-title">Manual variables</h2>
          <span className="gen-section-meta">
            {snapshot ? `${snapshot.manualEnabledCount} enabled` : loading ? "Loading" : "Not loaded"}
          </span>
        </div>
        <div className="gen-card env-card">
          <div className="env-form">
            <label className="env-field">
              <span>Key</span>
              <Input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="GITHUB_TOKEN"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                data-testid="agent-env-key-input"
              />
            </label>
            <label className="env-field env-field-value">
              <span>Value</span>
              <Input
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Stored value"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                data-testid="agent-env-value-input"
              />
            </label>
            <Button type="button" onClick={() => void saveVariable()} disabled={!canSave} data-testid="agent-env-save">
              <Plus size={16} aria-hidden />
              Save
            </Button>
          </div>
          {validation && key.trim() && <div className="env-inline-error">{validation}</div>}
          <div className="env-storage-note">
            Values are {snapshot?.valueProtection === "os-encrypted" ? "OS-encrypted" : "locally obfuscated"} and are not shown after saving.
          </div>
          {error && <div className="env-error">{error}</div>}
          <ManualVariableList
            variables={snapshot?.manualVariables ?? []}
            busyKey={busyKey}
            onToggle={setVariableEnabled}
            onDelete={deleteVariable}
          />
        </div>
      </section>

      <section className="gen-section">
        <div className="gen-section-head">
          <h2 className="gen-section-title">Propagated keys</h2>
          <span className="gen-section-meta">
            {snapshot ? `${snapshot.keys.length} visible` : loading ? "Loading" : "Not loaded"}
          </span>
        </div>
        <div className="env-toolbar">
          <label className="rules-search env-search" aria-label="Search environment keys">
            <Search size={16} aria-hidden />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search keys"
              data-testid="agent-env-search"
            />
          </label>
          <Button type="button" variant="outline" onClick={() => void refresh()} disabled={loading} data-testid="agent-env-refresh">
            <RefreshCw size={16} aria-hidden />
            Refresh
          </Button>
        </div>
        <div className="env-disclosure">{snapshot?.localInheritanceDisclosure}</div>
        <div className="gen-card env-key-card">
          {visibleKeys.length === 0 ? (
            <div className="env-empty-state">{snapshot ? "No keys match your search." : "Load environment keys to inspect them."}</div>
          ) : (
            <div className="env-key-list">
              {visibleKeys.map((item) => <EnvironmentKeyRow item={item} key={item.key} />)}
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

function ManualVariableList(props: {
  variables: ManualAgentEnvironmentVariable[];
  busyKey: string | undefined;
  onToggle: (variable: ManualAgentEnvironmentVariable, enabled: boolean) => Promise<void>;
  onDelete: (variable: ManualAgentEnvironmentVariable) => Promise<void>;
}): JSX.Element {
  if (props.variables.length === 0) {
    return <div className="env-empty-state">No manual variables.</div>;
  }
  return (
    <div className="env-manual-list">
      {props.variables.map((variable) => (
        <div className="env-manual-row" key={variable.key}>
          <KeyRound size={16} aria-hidden />
          <div className="env-manual-main">
            <strong>{variable.key}</strong>
            {variable.overridesDetected && <span>Overrides propagated key</span>}
          </div>
          <label className="toggle env-toggle">
            <input
              type="checkbox"
              aria-label={`Enable ${variable.key}`}
              checked={variable.enabled}
              disabled={props.busyKey === variable.key}
              onChange={(event) => void props.onToggle(variable, event.target.checked)}
            />
            <span />
          </label>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            title={`Delete ${variable.key}`}
            aria-label={`Delete ${variable.key}`}
            disabled={props.busyKey === variable.key}
            onClick={() => void props.onDelete(variable)}
          >
            <Trash2 size={15} aria-hidden />
          </Button>
        </div>
      ))}
    </div>
  );
}

function EnvironmentKeyRow(props: { item: AgentEnvironmentKey }): JSX.Element {
  return (
    <div className="env-key-row">
      <code>{props.item.key}</code>
      <span className={`env-source-chip env-source-${props.item.source}`}>
        {props.item.source === "manual" ? "Manual" : "Forwarded"}
      </span>
      {props.item.overridesDetected && <span className="env-source-chip">Override</span>}
    </div>
  );
}
