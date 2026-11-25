import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PlusIcon, ArrowsClockwiseIcon, MagnifyingGlassIcon, TrashIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { agentEnvironmentKeyValidationError, normalizeAgentEnvironmentKey } from "../../../shared/agentEnvironment";
import type {
  AgentEnvironmentSnapshot,
  AgentEnvironmentVariable,
  DeleteAgentEnvironmentVariableRequest,
  SaveAgentEnvironmentVariableRequest
} from "../../../shared/types";
import { errorText } from "../review/review-conversation-data";
import { IconButton } from "../primitives";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { Delayed } from "@/components/ui/delayed";

type EnvironmentFilter = "all" | "custom" | "automatic";

const FILTER_TABS: Array<{ key: EnvironmentFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "custom", label: "Custom" },
  { key: "automatic", label: "Automatic" }
];

/** Settings → Environment: one list of every variable members get. Each row
 *  is the same: paste a new value and Save, or delete it. */
export function EnvironmentSettingsSection(props: {
  getAgentEnvironment: () => Promise<AgentEnvironmentSnapshot>;
  saveAgentEnvironmentVariable: (request: SaveAgentEnvironmentVariableRequest) => Promise<AgentEnvironmentSnapshot>;
  deleteAgentEnvironmentVariable: (request: DeleteAgentEnvironmentVariableRequest) => Promise<AgentEnvironmentSnapshot>;
  refreshAgentEnvironment: () => Promise<AgentEnvironmentSnapshot>;
  onHeaderActionChange?: (action: ReactNode) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<AgentEnvironmentSnapshot | undefined>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<EnvironmentFilter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AgentEnvironmentVariable | undefined>();
  const [deletePending, setDeletePending] = useState(false);
  const { onHeaderActionChange } = props;
  // The actions are new functions on every render of the app; the page reads
  // the latest through a ref so it loads once, not on every render.
  const actions = useRef(props);
  actions.current = props;
  // Only the newest request may set the list: an older answer that arrives
  // late would otherwise put back what a save just changed.
  const latestRequest = useRef(0);

  const load = useCallback(async (readComputerAgain: boolean): Promise<void> => {
    const request = ++latestRequest.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await (readComputerAgain ? actions.current.refreshAgentEnvironment() : actions.current.getAgentEnvironment());
      if (request === latestRequest.current) setSnapshot(next);
    } catch (caught) {
      if (request === latestRequest.current) setError(errorText(caught));
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    onHeaderActionChange?.(
      <IconButton
        size="sm"
        icon={ArrowsClockwiseIcon}
        label="Read this computer's variables again"
        tooltip="Read this computer's variables again"
        disabled={loading}
        data-testid="env-refresh"
        onClick={() => void load(true)}
      />
    );
    return () => onHeaderActionChange?.(undefined);
  }, [load, loading, onHeaderActionChange]);

  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(() => (snapshot?.variables ?? []).filter((variable) =>
    (filter === "all" || variable.source === filter)
    && (!normalizedQuery || variable.key.toLowerCase().includes(normalizedQuery))
  ), [filter, normalizedQuery, snapshot?.variables]);

  /** Throws on failure: the row or the dialog that saved shows the reason. */
  async function save(key: string, value: string): Promise<void> {
    const request = ++latestRequest.current;
    const next = await actions.current.saveAgentEnvironmentVariable({ key, value });
    setError(undefined);
    if (request === latestRequest.current) setSnapshot(next);
  }

  async function saveFromRow(key: string, value: string): Promise<void> {
    try {
      await save(key, value);
    } catch (caught) {
      setError(errorText(caught));
      throw caught;
    }
  }

  /** A failed delete closes the question and says why on the page. */
  async function confirmDelete(): Promise<void> {
    if (!deleting) return;
    setDeletePending(true);
    setError(undefined);
    const request = ++latestRequest.current;
    try {
      const next = await actions.current.deleteAgentEnvironmentVariable({ key: deleting.key });
      if (request === latestRequest.current) setSnapshot(next);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <section className="environment-settings-screen" data-testid="settings-environment-screen">
      <p className="env-intro">
        Variables every member gets when it runs, on this computer and on your cloud machines. Automatic ones are read from this computer.
      </p>
      <div className="roles-toolbar">
        <label className="roles-search">
          <MagnifyingGlassIcon size={16} aria-hidden />
          <input
            data-testid="env-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search variables"
            aria-label="Search variables"
          />
        </label>
        <span className="roles-count" data-testid="env-count">{snapshot ? `${visible.length} shown` : loading ? <Delayed>Loading</Delayed> : ""}</span>
        <div className="roles-toolbar-spacer" />
        <div className="roles-filter-tabs" aria-label="Variable filters">
          {FILTER_TABS.map((tab) => (
            <button
              type="button"
              className={`roles-filter-tab ${filter === tab.key ? "is-selected" : ""}`}
              data-testid={`env-filter-${tab.key}`}
              onClick={() => setFilter(tab.key)}
              key={tab.key}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button type="button" className="roles-new-button" data-testid="env-new" onClick={() => setCreating(true)}>
          <PlusIcon size={15} aria-hidden />
          New variable
        </Button>
      </div>

      {error && <div className="env-error" role="alert">{error}</div>}

      {visible.length > 0 && (
        <div className="gen-card env-list" data-testid="env-list">
          {visible.map((variable, index) => (
            <div key={variable.key}>
              {index > 0 && <div className="gen-card-divider" />}
              <EnvironmentRow variable={variable} onSave={saveFromRow} onDelete={() => setDeleting(variable)} />
            </div>
          ))}
        </div>
      )}
      {snapshot && visible.length === 0 && normalizedQuery && (
        <div className="roles-empty-state">No variables match your search.</div>
      )}

      <NewVariableDialog
        open={creating}
        existingKeys={new Set((snapshot?.variables ?? []).map((variable) => variable.key))}
        onOpenChange={setCreating}
        onSave={save}
      />
      <DeleteConfirmationDialog
        open={Boolean(deleting)}
        title={deleting ? `Delete ${deleting.key}?` : "Delete variable?"}
        description={deleting?.source === "automatic"
          ? "Members stop getting it. It stays on this computer, and reading the computer again will not bring it back."
          : "Members stop getting it. Its value can't be shown again, so you would have to enter it anew."}
        confirmLabel="Delete"
        pending={deletePending}
        onOpenChange={(open) => { if (!open) setDeleting(undefined); }}
        onConfirm={confirmDelete}
      />
    </section>
  );
}

function EnvironmentRow(props: {
  variable: AgentEnvironmentVariable;
  onSave: (key: string, value: string) => Promise<void>;
  onDelete: () => void;
}): JSX.Element {
  const { variable } = props;
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const canSave = Boolean(draft) && !saving;

  async function save(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    try {
      await props.onSave(variable.key, draft);
      setDraft("");
    } catch {
      // The section shows the error; the pasted value stays to try again.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="gen-row env-row" data-testid={`env-row-${variable.key}`}>
      <div className="gen-row-text">
        <div className="gen-row-title env-key">{variable.key}</div>
        <div className="gen-row-desc">{variableOrigin(variable)}</div>
      </div>
      <div className="env-row-controls">
        <Input
          type="password"
          className="env-value-input"
          value={draft}
          placeholder={focused || draft ? "Paste a new value" : variable.preview}
          aria-label={`New value for ${variable.key}`}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-testid={`env-value-${variable.key}`}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              setDraft("");
              event.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className={`gen-timeout-save ${canSave ? "is-dirty" : ""}`}
          disabled={!canSave}
          data-testid={`env-save-${variable.key}`}
          onClick={() => void save()}
        >
          {saving ? "Saving" : "Save"}
        </button>
        <IconButton
          size="sm"
          icon={TrashIcon}
          label={`Delete ${variable.key}`}
          tooltip="Delete"
          data-testid={`env-delete-${variable.key}`}
          onClick={props.onDelete}
        />
      </div>
    </div>
  );
}

function variableOrigin(variable: AgentEnvironmentVariable): string {
  if (variable.source === "automatic") {
    return variable.thisComputerOnly ? "Automatic · this computer only" : "Automatic · from this computer";
  }
  return variable.enabled ? `Custom · changed ${shortDate(variable.updatedAt)}` : "Custom · off until a new value is saved";
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

function NewVariableDialog(props: {
  open: boolean;
  existingKeys: Set<string>;
  onOpenChange: (open: boolean) => void;
  onSave: (key: string, value: string) => Promise<void>;
}): JSX.Element {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const normalizedKey = normalizeAgentEnvironmentKey(key);
  const validation = normalizedKey ? agentEnvironmentKeyValidationError(normalizedKey) : undefined;
  const exists = Boolean(normalizedKey) && props.existingKeys.has(normalizedKey);
  const canAdd = Boolean(normalizedKey) && !validation && Boolean(value) && !saving;

  useEffect(() => {
    if (!props.open) {
      setKey("");
      setValue("");
      setFailure(undefined);
    }
  }, [props.open]);

  async function add(): Promise<void> {
    if (!canAdd) return;
    setSaving(true);
    setFailure(undefined);
    try {
      await props.onSave(normalizedKey, value);
      props.onOpenChange(false);
    } catch (caught) {
      // Said here, where the User is looking; what was typed stays.
      setFailure(errorText(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!saving) props.onOpenChange(open); }}>
      <DialogContent className="env-new-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>New variable</DialogTitle>
        </DialogHeader>
        <form
          className="env-new-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="env-new-field">
            <span>Name</span>
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="GITHUB_TOKEN"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(validation)}
              data-testid="env-new-key"
            />
          </label>
          {validation && <div className="env-new-error" data-testid="env-new-error">{validation}</div>}
          {!validation && exists && <div className="env-new-hint">{normalizedKey} is already in the list; Add replaces its value.</div>}
          <label className="env-new-field">
            <span>Value</span>
            <Input
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Paste the value"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-testid="env-new-value"
            />
          </label>
          {failure && <div className="env-new-error" role="alert">{failure}</div>}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" disabled={saving}>Cancel</Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!canAdd} data-testid="env-new-add">
              {saving ? "Adding" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
