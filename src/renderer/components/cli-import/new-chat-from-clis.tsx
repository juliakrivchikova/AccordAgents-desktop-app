import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { CliImportThread } from "../../../shared/types";
import { formatCompactRelativeTime } from "../../app/compact-relative-time";
import { ChatProviderMark } from "../chat/chat-member-mark";
import { newestCliThreadsInFolder, threadKey } from "./cli-import-groups";
import { openCliImport, refreshCliImportList, useCliImportList, warmCliImportList } from "./cli-import-store";

const OFFERED = 3;

interface NewChatFromClisProps {
  repoPath: string;
  onOpen: (conversationId: string) => void;
}

/**
 * Under New chat's heading (variant B, the User, 2026-11-26): the chosen
 * folder's newest threads of the User's CLIs that no chat holds yet, each
 * continued in one click, and a way to browse them all. The threads shown are
 * those known when the screen opened: a list that arrived later would move
 * the screen (src/components/ui/AGENTS.md), so it waits for the next visit.
 */
export const NewChatFromClis = ({ repoPath, onOpen }: NewChatFromClisProps): JSX.Element => {
  const known = useCliImportList();
  const [shown] = useState(() => newestCliThreadsInFolder(known?.threads ?? [], repoPath, OFFERED));
  const [continuing, setContinuing] = useState<string>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => { warmCliImportList(); }, []);

  const continueThread = async (thread: CliImportThread): Promise<void> => {
    setContinuing(threadKey(thread));
    setFailure(undefined);
    try {
      const result = await window.consensus.importCliThreads({ threads: [{ kind: thread.kind, sessionId: thread.sessionId }] });
      void refreshCliImportList().catch(() => undefined);
      const imported = result.imported[0];
      if (imported) onOpen(imported.conversationId);
      else setFailure(result.failed[0]?.reason ?? "The thread could not be imported.");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setContinuing(undefined);
    }
  };

  return (
    <div className="new-chat-recent" data-testid="new-chat-from-clis">
      <div className="flex h-6 items-center justify-between px-2 text-ui-12 font-medium text-ui-text-3">
        {shown.length > 0 ? <span>From your apps</span> : <span />}
        <Button variant="ghost" size="xs" className="text-ui-link" onClick={() => openCliImport({ folder: repoPath })} data-testid="new-chat-browse-clis">
          Browse threads
        </Button>
      </div>
      {shown.map((thread) => (
        <div key={threadKey(thread)} role="listitem" className="new-chat-recent-row group">
          <ChatProviderMark member={{ kind: thread.kind }} className="is-mini shrink-0" />
          <span className="new-chat-recent-title">{thread.title}</span>
          <Button
            variant="secondary"
            size="xs"
            className="opacity-0 transition-opacity duration-120 group-hover:opacity-100 focus-visible:opacity-100"
            disabled={Boolean(continuing)}
            onClick={() => void continueThread(thread)}
          >
            {continuing === threadKey(thread) && <Spinner size={12} />}
            Continue
          </Button>
          <span className="new-chat-recent-time">{formatCompactRelativeTime(thread.updatedAt)}</span>
        </div>
      ))}
      {failure && <p className="px-2 text-ui-12 text-ui-danger">{failure}</p>}
    </div>
  );
};
