import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Delayed } from "@/components/ui/delayed";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LoadingBar } from "@/components/ui/loading-bar";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CliImportThread } from "../../../shared/types";
import { cliProviderMetadata } from "../../../shared/cliReadiness";
import { normalizeProjectPath } from "../../../shared/newChat";
import {
  cliImportProjectKey, cliImportProjectSections, cliImportThreadRows, filterCliThreads, isImportable, isRecentlyUpdated, threadKey,
  type CliImportKindFilter, type CliImportProject
} from "./cli-import-groups";
import { CliImportProjectRow, CliImportThreadRow } from "./cli-import-rows";
import { closeCliImport, refreshCliImportList, useCliImportDialog, useCliImportList } from "./cli-import-store";

interface CliImportDialogProps {
  onOpenConversation: (conversationId: string) => void;
}

const KIND_TABS: Array<{ value: CliImportKindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "claude-code", label: "Claude" },
  { value: "codex-cli", label: "Codex" },
  { value: "gemini-cli", label: "Antigravity" }
];

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Import threads (docs/design/cli-import/plan.md, variant A): the projects
 * the User's CLIs ran in on the left, a project's threads on the right; a
 * chosen thread becomes a chat that goes on in its CLI session. It lists only
 * the threads each vendor's app shows (the User, 2026-11-26).
 */
export const CliImportDialog = ({ onOpenConversation }: CliImportDialogProps): JSX.Element => {
  const request = useCliImportDialog();
  const list = useCliImportList();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<CliImportKindFilter>("all");
  const [query, setQuery] = useState("");
  const [projectKey, setProjectKey] = useState<string>();
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
    refreshCliImportList()
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open]);

  const threads = useMemo(() => filterCliThreads(list?.threads ?? [], kind, query), [list, kind, query]);
  const sections = useMemo(() => cliImportProjectSections(threads), [threads]);
  const counts = useMemo(() => {
    const all = list?.threads ?? [];
    return new Map(KIND_TABS.map(({ value }) => [value, all.filter((thread) => value === "all" || thread.kind === value).length]));
  }, [list]);
  const allProjects = [...sections.projects, ...sections.gone];
  const wanted = normalizeProjectPath(request?.folder);
  const project = allProjects.find((item) => item.key === projectKey) ?? allProjects.find((item) => item.key === wanted) ?? allProjects[0];
  const rows = useMemo(() => cliImportThreadRows(project?.threads ?? []), [project]);
  const now = Date.now();
  const picked = [...chosen.values()];
  const folderOf = (thread: CliImportThread): string | undefined => thread.folderExists ? undefined : folderFor.get(cliImportProjectKey(thread));
  const needsFolder = picked.filter((thread) => !thread.folderExists && !folderOf(thread)).length;
  const recent = picked.filter((thread) => isRecentlyUpdated(thread, now)).length;
  const goneHere = project?.threads.filter((thread) => !thread.folderExists).length ?? 0;
  const chosenFolder = project && folderFor.get(project.key);

  const toggle = (thread: CliImportThread, on: boolean): void => setChosen((current) => {
    const next = new Map(current);
    if (on) next.set(threadKey(thread), thread); else next.delete(threadKey(thread));
    return next;
  });
  const toggleAll = (target: CliImportProject, on: boolean): void => setChosen((current) => {
    const next = new Map(current);
    for (const thread of target.threads.filter(isImportable)) {
      if (on) next.set(threadKey(thread), thread); else next.delete(threadKey(thread));
    }
    return next;
  });
  const chooseFolder = async (target: CliImportProject): Promise<void> => {
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
          const folder = folderOf(thread);
          return { kind: thread.kind, sessionId: thread.sessionId, ...(folder ? { folder } : {}) };
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

  const section = (title: string, items: CliImportProject[]) => items.length > 0 && (
    <>
      <div className="flex h-7 shrink-0 items-center px-2 text-ui-12 font-medium text-ui-text-3">{title}</div>
      {items.map((item) => (
        <CliImportProjectRow
          key={item.key}
          project={item}
          selected={item.key === project?.key}
          chosen={item.threads.filter((thread) => chosen.has(threadKey(thread))).length}
          onSelect={setProjectKey}
          onToggleAll={toggleAll}
        />
      ))}
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="flex h-[600px] max-h-[calc(100vh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[900px]" data-testid="cli-import-dialog">
        <div className="relative flex h-[46px] shrink-0 items-center px-4">
          <DialogTitle className="text-ui-14 font-semibold">Import threads</DialogTitle>
          {loading && <LoadingBar className="absolute inset-x-0 bottom-0" label="Reading your CLI threads" />}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-b border-ui-border-subtle px-4 pb-3">
          <Tabs value={kind} onValueChange={(value) => setKind(value as CliImportKindFilter)}>
            <TabsList aria-label="CLI">
              {KIND_TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="px-2.5">
                  {tab.label}
                  <span className="text-ui-12 tabular-nums text-ui-text-3">{counts.get(tab.value) ?? 0}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="relative ml-auto w-56">
            <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ui-text-3" aria-hidden />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search threads" className="h-8 pl-8" aria-label="Search threads" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[260px] shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r border-ui-border-subtle p-1.5" data-testid="cli-import-folders">
            {section("Projects", sections.projects)}
            {section("Folder is gone", sections.gone)}
          </div>
          <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-1.5" data-testid="cli-import-threads">
            {(list?.unavailable ?? []).map((item) => (
              <p key={item.kind} className="px-2 py-1 text-ui-12 text-ui-text-3">{cliProviderMetadata(item.kind).label}: {item.reason}</p>
            ))}
            {error && <p className="px-2 py-1 text-ui-12 text-ui-danger">{error}</p>}
            {project && (
              <div className="flex min-h-11 shrink-0 items-center gap-3 px-2 pb-1.5" data-testid="cli-import-project-head">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui-14 font-semibold">{project.label}</span>
                  {project.path && <span className="truncate text-ui-12 text-ui-text-3">{project.path}</span>}
                </div>
                {goneHere > 0 && (
                  <>
                    <span className="flex min-w-0 shrink items-center gap-1.5 text-ui-12 text-ui-warning">
                      <span className="size-1.5 shrink-0 rounded-full bg-ui-warning-dot" aria-hidden />
                      <span className="truncate">
                        {chosenFolder ? `Goes on in ${chosenFolder}` : project.exists ? `Folder is gone for ${plural(goneHere, "thread")}` : "Folder is gone"}
                      </span>
                    </span>
                    <Button variant="secondary" size="xs" onClick={() => void chooseFolder(project)}>Choose folder</Button>
                  </>
                )}
              </div>
            )}
            {goneHere > 0 && project?.threads.some((thread) => thread.kind === "gemini-cli" && !thread.folderExists) && (
              <p className="px-2 pb-1 text-ui-12 text-ui-text-3">Antigravity keeps a thread in its old folder: its commands will fail there.</p>
            )}
            {rows.map(({ thread, nested }) => (
              <CliImportThreadRow
                key={threadKey(thread)}
                thread={thread}
                nested={nested}
                checked={chosen.has(threadKey(thread))}
                now={now}
                onToggle={toggle}
                onOpen={(id) => { close(); onOpenConversation(id); }}
              />
            ))}
          </div>
        </div>
        <div className="flex min-h-14 shrink-0 items-center gap-3 border-t border-ui-border-subtle px-4 py-2">
          <span className="shrink-0 text-ui-12 tabular-nums text-ui-text-3">{picked.length} selected</span>
          {recent > 0 && (
            <span className="flex min-w-0 items-center gap-1.5 text-ui-12 text-ui-warning">
              <span className="size-1.5 shrink-0 rounded-full bg-ui-warning-dot" aria-hidden />
              <span className="truncate">{recent} updated in its CLI minutes ago: going on in both places mixes their turns</span>
            </span>
          )}
          {failures.length > 0 && <span className="min-w-0 truncate text-ui-12 text-ui-danger" title={failures.join("\n")}>{failures[0]}</span>}
          <div className="ml-auto flex shrink-0 gap-2">
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button disabled={picked.length === 0 || needsFolder > 0 || importing} onClick={() => void runImport()} data-testid="cli-import-submit">
              {importing && <Delayed><Spinner size={14} /></Delayed>}
              {needsFolder > 0 ? "Choose a folder first" : "Import"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
