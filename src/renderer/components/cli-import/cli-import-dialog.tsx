import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LoadingBar } from "@/components/ui/loading-bar";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { CliImportListResult, CliImportThread } from "../../../shared/types";
import { cliProviderMetadata } from "../../../shared/cliReadiness";
import { normalizeProjectPath } from "../../../shared/newChat";
import { SegmentedTabs } from "../segmented-tabs";
import {
  cliImportFolderSections, filterCliThreads, isImportable, isRecentlyUpdated, threadKey,
  type CliImportFolder, type CliImportKindFilter
} from "./cli-import-groups";
import { CliImportFolderRow, CliImportThreadRow } from "./cli-import-rows";
import { closeCliImport, refreshCliImportList, useCliImportDialog, useCliImportList } from "./cli-import-store";

interface CliImportDialogProps {
  onOpenConversation: (conversationId: string) => void;
}

const KINDS = ["claude-code", "codex-cli", "gemini-cli"] as const;

/**
 * Import from your CLIs (docs/design/cli-import/plan.md, variant A): the
 * folders the User's CLIs ran in on the left, a folder's threads on the
 * right; a chosen thread becomes a chat that goes on in its CLI session.
 */
export const CliImportDialog = ({ onOpenConversation }: CliImportDialogProps): JSX.Element => {
  const request = useCliImportDialog();
  const remembered = useCliImportList();
  const [automated, setAutomated] = useState(false);
  const [withAutomated, setWithAutomated] = useState<CliImportListResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<CliImportKindFilter>("all");
  const [query, setQuery] = useState("");
  const [folderKey, setFolderKey] = useState<string>();
  const [chosen, setChosen] = useState<Map<string, CliImportThread>>(new Map());
  const [folderFor, setFolderFor] = useState<Map<string, string>>(new Map());
  const [importing, setImporting] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const open = Boolean(request);

  // Read the CLIs' stores each time it opens (a thread may be new since).
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError(undefined);
    refreshCliImportList(automated)
      .then((list) => { if (current && automated) setWithAutomated(list); })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, automated]);

  const list = automated ? withAutomated : remembered;
  const threads = useMemo(() => filterCliThreads(list?.threads ?? [], kind, query), [list, kind, query]);
  const sections = useMemo(() => cliImportFolderSections(threads), [threads]);
  const allFolders = [...sections.folders, ...sections.gone, ...sections.single];
  const wanted = normalizeProjectPath(request?.folder);
  const folder = allFolders.find((item) => item.key === folderKey) ?? allFolders.find((item) => item.key === wanted) ?? allFolders[0];
  const now = Date.now();
  const picked = [...chosen.values()];
  const needsFolder = picked.filter((thread) => !thread.folderExists && !folderFor.get(normalizeProjectPath(thread.folder) ?? ""));
  const recent = picked.filter((thread) => isRecentlyUpdated(thread, now)).length;

  const toggle = (thread: CliImportThread, on: boolean): void => setChosen((current) => {
    const next = new Map(current);
    if (on) next.set(threadKey(thread), thread); else next.delete(threadKey(thread));
    return next;
  });
  const toggleAll = (target: CliImportFolder, on: boolean): void => setChosen((current) => {
    const next = new Map(current);
    for (const thread of target.threads.filter(isImportable)) {
      if (on) next.set(threadKey(thread), thread); else next.delete(threadKey(thread));
    }
    return next;
  });
  const chooseFolder = async (target: CliImportFolder): Promise<void> => {
    const selected = await window.consensus.selectRepoDirectory();
    if (selected) setFolderFor((current) => new Map(current).set(target.key, selected));
  };
  const close = (): void => {
    closeCliImport();
    setChosen(new Map());
    setFailures([]);
  };
  const runImport = async (): Promise<void> => {
    setImporting(true);
    setFailures([]);
    try {
      const result = await window.consensus.importCliThreads({
        threads: picked.map((thread) => {
          const folderPath = thread.folderExists ? undefined : folderFor.get(normalizeProjectPath(thread.folder) ?? "");
          return { kind: thread.kind, sessionId: thread.sessionId, ...(folderPath ? { folder: folderPath } : {}) };
        })
      });
      void refreshCliImportList().catch(() => undefined);
      if (result.failed.length > 0) {
        setFailures(result.failed.map((item) => item.reason));
        setChosen((current) => new Map([...current].filter(([, thread]) => result.failed.some((item) => item.sessionId === thread.sessionId))));
        return;
      }
      close();
      const first = result.imported[0];
      if (first) onOpenConversation(first.conversationId);
    } catch (reason) {
      setFailures([reason instanceof Error ? reason.message : String(reason)]);
    } finally {
      setImporting(false);
    }
  };

  const counts = (value: CliImportKindFilter): number => (list?.threads ?? []).filter((thread) => value === "all" || thread.kind === value).length;
  const tabs = [
    { value: "all" as const, label: `All ${counts("all")}` },
    ...KINDS.map((value) => ({ value, label: `${cliProviderMetadata(value).label} ${counts(value)}` }))
  ];
  const chosenIn = (target: CliImportFolder): number => target.threads.filter((thread) => chosen.has(threadKey(thread))).length;
  const folderRows = (items: CliImportFolder[]) => items.map((item) => (
    <CliImportFolderRow key={item.key} folder={item} selected={item.key === folder?.key} chosen={chosenIn(item)} onSelect={setFolderKey} onToggleAll={toggleAll} />
  ));
  const section = (title: string, items: CliImportFolder[]) => items.length > 0 && (
    <>
      <div className="flex h-6 items-center px-2 pt-1.5 text-ui-11 font-medium text-ui-text-3">{title}</div>
      {folderRows(items)}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="flex h-[600px] max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]" data-testid="cli-import-dialog">
        <div className="relative flex h-[46px] shrink-0 items-center px-4">
          <DialogTitle className="text-ui-14 font-semibold">Import from your CLIs</DialogTitle>
          {loading && <LoadingBar className="absolute inset-x-0 bottom-0" label="Reading your CLI threads" />}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-ui-border-subtle px-4 pb-2.5">
          <SegmentedTabs value={kind} items={tabs} ariaLabel="CLI" onValueChange={setKind} />
          <div className="relative ml-auto w-56">
            <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ui-text-3" aria-hidden />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search threads" className="h-7 pl-7" aria-label="Search threads" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-[300px] shrink-0 overflow-auto border-r border-ui-border-subtle p-1.5" data-testid="cli-import-folders">
            {section("FOLDERS ON THIS COMPUTER", sections.folders)}
            {section("FOLDER IS GONE", sections.gone)}
            {section("ONE THREAD EACH", sections.single)}
          </div>
          <div className="flex min-w-0 flex-1 flex-col overflow-auto p-1.5" data-testid="cli-import-threads">
            {(list?.unavailable ?? []).map((item) => (
              <p key={item.kind} className="px-2 py-1 text-ui-12 text-ui-text-3">{cliProviderMetadata(item.kind).label}: {item.reason}</p>
            ))}
            {error && <p className="px-2 py-1 text-ui-12 text-ui-danger">{error}</p>}
            {folder && (
              <div className="flex h-9 shrink-0 items-center gap-2 px-2">
                <span className="truncate text-ui-14 font-semibold">{folder.label}</span>
                {!folder.exists && (
                  <>
                    <span className="flex items-center gap-1.5 text-ui-12 text-ui-warning">
                      <span className="size-1.5 rounded-full bg-ui-warning-dot" aria-hidden />
                      {folderFor.get(folder.key) ? `Goes on in ${folderFor.get(folder.key)}` : "Folder is gone"}
                    </span>
                    <Button variant="secondary" size="xs" onClick={() => void chooseFolder(folder)}>Choose folder</Button>
                  </>
                )}
              </div>
            )}
            {folder && !folder.exists && folder.threads.some((thread) => thread.kind === "gemini-cli") && (
              <p className="px-2 pb-1 text-ui-12 text-ui-text-3">Antigravity keeps a thread in its old folder: its commands will fail there.</p>
            )}
            {folder?.threads.map((thread) => (
              <CliImportThreadRow
                key={threadKey(thread)}
                thread={thread}
                checked={chosen.has(threadKey(thread))}
                now={now}
                onToggle={toggle}
                onOpen={(id) => { close(); onOpenConversation(id); }}
              />
            ))}
          </div>
        </div>
        <div className="flex min-h-14 shrink-0 items-center gap-3 border-t border-ui-border-subtle px-4 py-2">
          <label className="flex items-center gap-2 text-ui-12 text-ui-text-2">
            <Switch checked={automated} onChange={(event) => setAutomated(event.target.checked)} />
            Show automated runs
          </label>
          <span className="text-ui-12 text-ui-text-3">{picked.length} thread{picked.length === 1 ? "" : "s"}</span>
          {recent > 0 && (
            <span className="flex items-center gap-1.5 text-ui-12 text-ui-warning">
              <span className="size-1.5 rounded-full bg-ui-warning-dot" aria-hidden />
              {recent} updated in its CLI minutes ago: going on in both places mixes their turns
            </span>
          )}
          {failures.length > 0 && <span className="min-w-0 truncate text-ui-12 text-ui-danger" title={failures.join("\n")}>{failures[0]}</span>}
          <div className="ml-auto flex shrink-0 gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button disabled={picked.length === 0 || needsFolder.length > 0 || importing} onClick={() => void runImport()} data-testid="cli-import-submit">
              {importing && <Spinner size={14} />}
              {needsFolder.length > 0 ? "Choose a folder first" : `Import ${picked.length} thread${picked.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
