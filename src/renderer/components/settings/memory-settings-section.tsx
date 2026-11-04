import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import type { MemoryNoteKind, MemoryNoteSummary, MemoryScope, MemorySettingsListRequest, MemorySettingsListResult } from "../../../shared/memory";
import { errorText } from "../review/review-conversation-data";
import { MemoryNoteCard } from "./memory-settings-item";
import { MemoryNoteDialog } from "./memory-note-dialog";

type KindFilter = "all" | MemoryNoteKind;
type ScopeFilter = "all" | MemoryScope;

const KIND_TABS: Array<{ key: KindFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "runbook", label: "Runbooks" },
  { key: "article", label: "Articles" },
  { key: "status", label: "Statuses" }
];

const SCOPE_TABS: Array<{ key: ScopeFilter; label: string }> = [
  { key: "all", label: "Everywhere" },
  { key: "global", label: "Global" },
  { key: "project", label: "Project" },
  { key: "role", label: "Role" },
  { key: "chat", label: "Chat" }
];

/** How long typing waits before the list is asked again. */
const SEARCH_DEBOUNCE_MS = 250;

/** Settings → Memory: the notes members keep on the User's server, to look
 *  at and delete, laid out like Roles. Members write and tidy them on their
 *  own; nothing here is needed for memory to work (the User, 2026-11-04). */
export function MemorySettingsSection(): JSX.Element {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [archived, setArchived] = useState(false);
  const [result, setResult] = useState<MemorySettingsListResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<MemoryNoteSummary | undefined>();

  useEffect(() => {
    let cancelled = false;
    const request: MemorySettingsListRequest = {
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(kind !== "all" ? { kind } : {}),
      ...(scope !== "all" ? { scope } : {}),
      ...(archived ? { archived: true } : {})
    };
    const timer = window.setTimeout(() => {
      void window.consensus.listMemoryNotes(request)
        .then((value) => {
          if (cancelled) return;
          setResult(value);
          setError(undefined);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          // Never the last list under other filters: it would read as theirs.
          setResult(undefined);
          setError(errorText(caught));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, kind, scope, archived, reload]);

  const notes = result?.notes ?? [];
  const filtered = Boolean(query.trim() || kind !== "all" || scope !== "all" || archived);
  const count = result ? `${notes.length}${result.truncated ? "+" : ""} ${notes.length === 1 ? "note" : "notes"}` : error ? "" : "Loading";
  return (
    <section className="roles-settings-screen" data-testid="memory-settings">
      <div className="roles-toolbar">
        <label className="roles-search">
          <Search size={16} aria-hidden />
          <input
            data-testid="memory-settings-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
          />
        </label>
        <span className="roles-count" data-testid="memory-settings-count">{count}</span>
        <div className="roles-toolbar-spacer" />
        <FilterTabs label="Note kinds" tabs={KIND_TABS} selected={kind} onSelect={setKind} testId="memory-settings-kind" />
      </div>
      <div className="roles-toolbar memory-settings-filters">
        <FilterTabs label="Where notes are kept" tabs={SCOPE_TABS} selected={scope} onSelect={setScope} testId="memory-settings-scope" />
        <div className="roles-toolbar-spacer" />
        <FilterTabs
          label="Archived notes"
          tabs={[{ key: "active", label: "Active" }, { key: "archived", label: "Archived" }]}
          selected={archived ? "archived" : "active"}
          onSelect={(key) => setArchived(key === "archived")}
          testId="memory-settings-state"
        />
      </div>
      {error && <div className="inline-error memory-settings-error">{error}</div>}
      {result?.status === "unavailable" ? (
        <div className="roles-empty-state" data-testid="memory-settings-unavailable">
          {result.message ?? "Your server cannot be reached right now."}
        </div>
      ) : result && notes.length === 0 ? (
        <div className="roles-empty-state" data-testid="memory-settings-empty">
          {filtered ? "No notes match." : "No notes yet. Members add them as they work."}
        </div>
      ) : (
        <div className="roles-card-grid">
          {notes.map((note) => (
            <MemoryNoteCard key={note.id} note={note} roleLabels={result?.roleLabels ?? {}} chatTitles={result?.chatTitles ?? {}}
              onOpen={() => setOpen(note)} />
          ))}
        </div>
      )}
      <MemoryNoteDialog
        note={open}
        roleLabels={result?.roleLabels ?? {}}
        chatTitles={result?.chatTitles ?? {}}
        onClose={() => setOpen(undefined)}
        onDeleted={() => {
          setOpen(undefined);
          setReload((value) => value + 1);
        }}
      />
    </section>
  );
}

function FilterTabs<T extends string>(props: {
  label: string;
  tabs: Array<{ key: T; label: string }>;
  selected: T;
  onSelect: (key: T) => void;
  testId: string;
}): JSX.Element {
  return (
    <div className="roles-filter-tabs" aria-label={props.label}>
      {props.tabs.map((tab) => (
        <button
          type="button"
          className={`roles-filter-tab ${props.selected === tab.key ? "is-selected" : ""}`}
          data-testid={`${props.testId}-${tab.key}`}
          aria-pressed={props.selected === tab.key}
          onClick={() => props.onSelect(tab.key)}
          key={tab.key}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
