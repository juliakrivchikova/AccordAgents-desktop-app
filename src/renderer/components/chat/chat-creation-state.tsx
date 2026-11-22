import type { ReviewProgress } from "../../../shared/types";
import { Delayed } from "@/components/ui/delayed";
import { Spinner } from "@/components/ui/spinner";

/** What a chat being made says while New chat waits for it: its own run's
 *  latest step (copying a project for a cloud run, say), never another run's. */
export function chatCreationStatus(progressLog: readonly ReviewProgress[], runId: string | undefined, stopping: boolean): string {
  if (stopping) return "Stopping preparation…";
  const latest = runId ? [...progressLog].reverse().find((item) => item.runId === runId) : undefined;
  return latest?.message ?? "Creating your chat…";
}

/** The status line over New chat's composer while the chat is being made,
 *  where an open chat shows its run's progress; a quick start shows none. */
export const ChatCreationStatusLine = ({ text }: { text: string }): JSX.Element => (
  <Delayed>
    <div className="chat-composer-status new-chat-creation-status" role="status" data-testid="new-chat-creation-status">
      <Spinner size={14} />
      <span>{text}</span>
    </div>
  </Delayed>
);
