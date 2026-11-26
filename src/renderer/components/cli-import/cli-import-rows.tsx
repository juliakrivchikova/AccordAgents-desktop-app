import { FolderDashedIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CliImportThread } from "../../../shared/types";
import { formatCompactRelativeTime } from "../../app/compact-relative-time";
import { ChatProviderMark } from "../chat/chat-member-mark";
import { isImportable, isRecentlyUpdated, threadKey, type CliImportProject } from "./cli-import-groups";

const ROW = "flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-ui-8 px-2 text-left text-ui-13 transition-colors duration-120 ease-ui-out hover:bg-ui-row-hover";
const ACTIVE = "bg-ui-row-active text-ui-select-fg hover:bg-ui-row-active";

interface ProjectRowProps {
  project: CliImportProject;
  selected: boolean;
  chosen: number;
  onSelect: (key: string) => void;
  onToggleAll: (project: CliImportProject, on: boolean) => void;
}

/** A project in the left column, on one line: its box chooses all its
 *  threads not yet in a chat, its full path is in the tooltip. */
export const CliImportProjectRow = ({ project, selected, chosen, onSelect, onToggleAll }: ProjectRowProps): JSX.Element => {
  const importable = project.threads.filter(isImportable).length;
  return (
    <div className={cn(ROW, selected && ACTIVE)} data-testid="cli-import-folder">
      <Checkbox
        checked={importable > 0 && chosen === importable}
        indeterminate={chosen > 0 && chosen < importable}
        disabled={importable === 0}
        aria-label={`Choose every thread in ${project.label}`}
        onChange={(event) => onToggleAll(project, event.target.checked)}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none" onClick={() => onSelect(project.key)}>
            {!project.exists && <FolderDashedIcon className="size-3.5 shrink-0 text-ui-text-3" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{project.label}</span>
            <span className="shrink-0 text-ui-12 tabular-nums text-ui-text-3">{project.threads.length}</span>
          </button>
        </TooltipTrigger>
        {project.path && <TooltipContent side="right">{project.path}</TooltipContent>}
      </Tooltip>
    </div>
  );
};

interface ThreadRowProps {
  thread: CliImportThread;
  nested: boolean;
  checked: boolean;
  now: number;
  onToggle: (thread: CliImportThread, on: boolean) => void;
  onOpen: (conversationId: string) => void;
}

/** A thread: its box, its CLI, its title, its state, and its time. A side
 *  session sits one step in, under the thread it was started from. */
export const CliImportThreadRow = ({ thread, nested, checked, now, onToggle, onOpen }: ThreadRowProps): JSX.Element => {
  const imported = thread.conversationId;
  return (
    <div className={cn(ROW, nested && "pl-6", checked && ACTIVE)} data-testid="cli-import-thread" data-thread-key={threadKey(thread)}>
      <Checkbox
        checked={checked}
        disabled={!isImportable(thread)}
        aria-label={`Import ${thread.title}`}
        onChange={(event) => onToggle(thread, event.target.checked)}
      />
      <ChatProviderMark member={{ kind: thread.kind }} className="is-mini shrink-0" />
      <span className={cn("min-w-0 flex-1 truncate", imported ? "text-ui-text-3" : "text-ui-text")}>{thread.title}</span>
      {imported ? (
        <span className="flex shrink-0 items-center gap-1 text-ui-12 text-ui-text-3">
          Imported
          <Button variant="ghost" size="xs" onClick={() => onOpen(imported)}>Open</Button>
        </span>
      ) : isRecentlyUpdated(thread, now) ? (
        <span className="flex shrink-0 items-center gap-1.5 text-ui-12 text-ui-warning">
          <span className="size-1.5 rounded-full bg-ui-warning-dot" aria-hidden />
          Updated {formatCompactRelativeTime(thread.updatedAt)} ago
        </span>
      ) : null}
      <span className="w-8 shrink-0 text-right text-ui-12 tabular-nums text-ui-text-3">{formatCompactRelativeTime(thread.updatedAt)}</span>
    </div>
  );
};
