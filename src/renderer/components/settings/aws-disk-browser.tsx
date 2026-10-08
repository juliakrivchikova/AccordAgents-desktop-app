import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AwsDiskEntry, AwsDiskEntryRole } from "../../../shared/types";
import { AwsDialog, AwsWaiting } from "./aws-dialog";
import { cleanError } from "./aws-shared";
import { formatBytes, keptText, LOCK_TEXT, type AwsDiskControl } from "./use-aws-disk";

export type AwsDiskBrowseStart = "" | "@runs" | "@mirrors";

const TITLE: Record<AwsDiskBrowseStart, string> = { "": "Files on the instance", "@runs": "Cloud run working files", "@mirrors": "Project copies" };

/** What a folder is to the User, when its name alone does not say. */
const ROLE_TEXT: Record<AwsDiskEntryRole, string> = {
  "program": "This computer's program",
  "other-program": "Another computer's program",
  "idle-program": "Older install of the program",
  "program-data": "Program data and cloud run files",
  "cloud-runs": "Cloud run working files",
  "project-copies": "Project copies",
  "versions": "Program versions",
  "agent-tools": "Agent tools",
  "sign-ins": "Agents' sign-ins and settings",
  "logs": "Program logs",
  "cache": "Cache",
  "mailbox-runners": "Mailbox runners"
};
/** The instance takes at most this many paths in one delete. */
const MAX_SELECTED = 500;

interface FolderState { entries?: AwsDiskEntry[]; loading: boolean; error?: string; truncated?: number }

const indent = (depth: number): { paddingLeft: number } => ({ paddingLeft: 12 + depth * 22 });

/**
 * The instance's files, largest first, with a checkbox on what may go and a
 * lock with the reason on what may not. The instance checks every path again
 * when asked to delete, so a folder that became busy meanwhile stays.
 */
export function AwsDiskBrowser(props: { open: boolean; start: AwsDiskBrowseStart; disk: AwsDiskControl; onClose: () => void }): JSX.Element {
  const [folders, setFolders] = useState<Record<string, FolderState>>({});
  const [root, setRoot] = useState<string>();
  const [rootError, setRootError] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [deleting, setDeleting] = useState(false);
  const [outcome, setOutcome] = useState<{ error?: string; kept?: string }>();

  const loadRoot = async (): Promise<void> => {
    setRootError(undefined);
    try {
      const listing = await window.consensus.listAwsInstanceFiles(props.start || undefined);
      setRoot(listing.path);
      setFolders({ [listing.path]: { entries: listing.entries, loading: false, truncated: listing.truncated } });
    } catch (cause) {
      setRootError(cleanError(cause));
    }
  };
  useEffect(() => {
    if (!props.open) return;
    setRoot(undefined); setFolders({}); setExpanded(new Set()); setSelected(new Map()); setOutcome(undefined);
    void loadRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.start]);

  const toggleFolder = async (entry: AwsDiskEntry): Promise<void> => {
    const next = new Set(expanded);
    if (next.has(entry.path)) { next.delete(entry.path); setExpanded(next); return; }
    next.add(entry.path);
    setExpanded(next);
    if (folders[entry.path]?.entries) return;
    setFolders((current) => ({ ...current, [entry.path]: { loading: true } }));
    try {
      const listing = await window.consensus.listAwsInstanceFiles(entry.path);
      setFolders((current) => ({ ...current, [entry.path]: { entries: listing.entries, loading: false, truncated: listing.truncated } }));
    } catch (cause) {
      setFolders((current) => ({ ...current, [entry.path]: { loading: false, error: cleanError(cause) } }));
    }
  };
  const covered = (path: string): boolean => [...selected.keys()].some((chosen) => path !== chosen && path.startsWith(`${chosen}/`));
  // Choosing a folder replaces whatever was chosen inside it.
  const toggleSelect = (entry: AwsDiskEntry): void => {
    const next = new Map(selected);
    if (next.has(entry.path)) next.delete(entry.path);
    else {
      for (const chosen of [...next.keys()]) if (chosen.startsWith(`${entry.path}/`)) next.delete(chosen);
      next.set(entry.path, entry.bytes);
    }
    setSelected(next);
  };
  const total = useMemo(() => [...selected.values()].reduce((sum, bytes) => sum + bytes, 0), [selected]);
  const tooMany = selected.size > MAX_SELECTED;
  const remove = async (): Promise<void> => {
    if (tooMany) return;
    setDeleting(true);
    setOutcome(undefined);
    try {
      const result = await props.disk.remove([...selected.keys()]);
      setSelected(new Map());
      setExpanded(new Set());
      setOutcome({ kept: keptText(result.failed) });
      await loadRoot();
    } catch (cause) {
      setOutcome({ error: cleanError(cause) });
    } finally {
      setDeleting(false);
    }
  };

  const rows = (path: string, depth: number): JSX.Element[] => {
    const folder = folders[path];
    if (!folder) return [];
    if (folder.loading) return [<div key={`${path}:loading`} className="gen-aws-tree-row is-note" style={indent(depth)}><AwsWaiting>Measuring…</AwsWaiting></div>];
    if (folder.error) return [<div key={`${path}:error`} className="gen-aws-tree-row is-note" style={indent(depth)}><span className="gen-row-error">{folder.error}</span></div>];
    const list = (folder.entries ?? []).map((entry) => {
      const open = expanded.has(entry.path);
      const Chevron = entry.dir ? (open ? ChevronDown : ChevronRight) : null;
      const Icon = entry.dir ? (open ? FolderOpen : Folder) : File;
      const inherited = covered(entry.path);
      const role = entry.role ? ROLE_TEXT[entry.role] : undefined;
      // A folder's role already says why it is locked when it is the program's.
      const reason = entry.lock && !(role && (entry.lock === "program" || entry.lock === "other-program" || entry.lock === "sign-ins"))
        ? LOCK_TEXT[entry.lock] : undefined;
      return (
        <Fragment key={entry.path}>
          <div className={`gen-aws-tree-row${entry.lock ? " is-locked" : ""}`} style={indent(depth)} data-path={entry.path}>
            {entry.dir ? (
              <button type="button" className="gen-aws-tree-chev" aria-label={open ? `Collapse ${entry.name}` : `Expand ${entry.name}`} aria-expanded={open} onClick={() => void toggleFolder(entry)}>
                {Chevron ? <Chevron size={14} /> : null}
              </button>
            ) : <span className="gen-aws-tree-chev" />}
            <span className="gen-aws-tree-check">
              {entry.lock ? <Lock size={13} role="img" aria-label={`Locked${reason ? `: ${reason}` : ""}`} />
                : <input type="checkbox" aria-label={`Select ${entry.name}`} checked={inherited || selected.has(entry.path)} disabled={inherited || deleting}
                  onChange={() => toggleSelect(entry)} />}
            </span>
            <Icon size={15} className="gen-aws-tree-icon" aria-hidden />
            <span className="gen-aws-tree-name" title={entry.path}>
              <code>{entry.name}</code>
              {role ? <span> · {role}</span> : null}
              {reason ? <em> · {reason}</em> : null}
            </span>
            <span className="gen-aws-tree-size">{formatBytes(entry.bytes)}</span>
          </div>
          {open ? rows(entry.path, depth + 1) : null}
        </Fragment>
      );
    });
    if (folder.truncated) {
      list.push(<div key={`${path}:more`} className="gen-aws-tree-row is-note" style={indent(depth)}><span className="gen-row-desc">{folder.truncated} smaller items not shown</span></div>);
    }
    return list;
  };

  return (
    <AwsDialog
      open={props.open}
      wide
      title={TITLE[props.start]}
      testId="aws-disk-browser"
      busy={deleting}
      onClose={props.onClose}
      description={`${root ?? "Reading the folder…"}, largest first. Locked items are in use or belong to someone's work and cannot be selected. Deleted files cannot be restored.`}
      note={selected.size ? `${selected.size} selected · ${formatBytes(total)}` : undefined}
      actions={<>
        <Button type="button" variant="outline" size="sm" disabled={deleting} onClick={props.onClose}>{selected.size ? "Cancel" : "Close"}</Button>
        <Button type="button" size="sm" data-testid="aws-disk-delete" disabled={!selected.size || deleting || tooMany} onClick={() => void remove()}>
          {deleting ? <Loader2 size={14} className="gen-aws-spinner" aria-hidden /> : null}
          {deleting ? "Deleting…" : selected.size ? `Delete ${formatBytes(total)}` : "Delete"}
        </Button>
      </>}
    >
      <div className="gen-aws-tree" data-testid="aws-disk-tree">
        {root ? rows(root, 0) : rootError ? <div className="gen-aws-tree-row is-note"><span className="gen-row-error">{rootError}</span></div>
          : <div className="gen-aws-tree-row is-note"><AwsWaiting>Measuring the folders… On a small instance this takes up to a minute.</AwsWaiting></div>}
      </div>
      {tooMany ? <div className="gen-row-error" role="alert">Choose at most {MAX_SELECTED} items at once, or the folder that holds them.</div> : null}
      {outcome?.kept ? <div className="gen-row-error" role="alert" data-testid="aws-disk-kept">{outcome.kept}</div> : null}
      {outcome?.error ? <div className="gen-row-error" role="alert">{outcome.error}</div> : null}
    </AwsDialog>
  );
}
