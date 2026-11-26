import { FolderDashedIcon, FolderSimpleIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { CliImportThread } from "../../../shared/types";
import { formatCompactRelativeTime } from "../../app/compact-relative-time";
import { ChatProviderMark } from "../chat/chat-member-mark";
import { isImportable, isRecentlyUpdated, threadKey, type CliImportFolder } from "./cli-import-groups";

const ROW = "flex min-w-0 items-center gap-2 rounded-ui-8 px-2 text-left text-ui-13 transition-colors duration-120 ease-ui-out hover:bg-ui-row-hover";

interface FolderRowProps {
  folder: CliImportFolder;
  selected: boolean;
  chosen: number;
  onSelect: (key: string) => void;
  onToggleAll: (folder: CliImportFolder, on: boolean) => void;
}

/** A folder the CLIs ran in: its box chooses all its threads not yet in a chat. */
export const CliImportFolderRow = ({ folder, selected, chosen, onSelect, onToggleAll }: FolderRowProps): JSX.Element => {
  const importable = folder.threads.filter(isImportable).length;
  const Icon = folder.exists ? FolderSimpleIcon : FolderDashedIcon;
  return (
    <div className={cn(ROW, "min-h-10 py-1", selected && "bg-ui-row-active hover:bg-ui-row-active")} data-testid="cli-import-folder">
      <Checkbox
        checked={importable > 0 && chosen === importable}
        indeterminate={chosen > 0 && chosen < importable}
        disabled={importable === 0}
        aria-label={`Choose every thread in ${folder.label}`}
        onChange={(event) => onToggleAll(folder, event.target.checked)}
      />
      <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => onSelect(folder.key)}>
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-ui-text">
          {!folder.exists && <Icon className="size-3.5 shrink-0 text-ui-text-3" aria-hidden />}
          <span className="truncate">{folder.label}</span>
        </span>
        <span className="truncate text-ui-12 text-ui-text-3">{folder.folder || "No folder"}</span>
      </button>
      <span className="shrink-0 text-ui-12 tabular-nums text-ui-text-3">{folder.threads.length}</span>
    </div>
  );
};

interface ThreadRowProps {
  thread: CliImportThread;
  checked: boolean;
  now: number;
  onToggle: (thread: CliImportThread, on: boolean) => void;
  onOpen: (conversationId: string) => void;
}

/** A thread: its box, its CLI, its title, and its state on the right. */
export const CliImportThreadRow = ({ thread, checked, now, onToggle, onOpen }: ThreadRowProps): JSX.Element => {
  const imported = thread.conversationId;
  return (
    <div className={cn(ROW, "h-8", checked && "bg-ui-row-active hover:bg-ui-row-active")} data-testid="cli-import-thread" data-thread-key={threadKey(thread)}>
      <Checkbox
        checked={checked}
        disabled={!isImportable(thread)}
        aria-label={`Import ${thread.title}`}
        onChange={(event) => onToggle(thread, event.target.checked)}
      />
      <ChatProviderMark member={{ kind: thread.kind }} className="is-mini shrink-0" />
      <span className={cn("min-w-0 flex-1 truncate", imported ? "text-ui-text-3" : "text-ui-text")}>{thread.title}</span>
      {imported ? (
        <Button variant="ghost" size="xs" className="text-ui-link" onClick={() => onOpen(imported)}>In AccordAgents, Open</Button>
      ) : isRecentlyUpdated(thread, now) ? (
        <span className="flex shrink-0 items-center gap-1.5 text-ui-12 text-ui-warning">
          <span className="size-1.5 rounded-full bg-ui-warning-dot" aria-hidden />
          Updated {formatCompactRelativeTime(thread.updatedAt)} ago
        </span>
      ) : thread.automated ? (
        <span className="shrink-0 text-ui-12 text-ui-text-3">Automated</span>
      ) : null}
      <span className="w-10 shrink-0 text-right text-ui-12 tabular-nums text-ui-text-3">{formatCompactRelativeTime(thread.updatedAt)}</span>
    </div>
  );
};
