import { ChatIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import type { ReviewProgress } from "../../../shared/types";
import { useSessionsViewText } from "../chat/chat-sessions-links";
import { Spinner } from "@/components/ui/spinner";

export function RunStatusLine({ progress }: { progress?: ReviewProgress }): JSX.Element {
  // The status is the app's words: the sessions view names nobody by handle.
  const appText = useSessionsViewText();
  return (
    <div className="run-status-line" aria-live="polite">
      <span className="run-status-text">{progress?.message ? appText(progress.message) : "Thinking"}</span>
      <Spinner size={14} label="In progress" />
    </div>
  );
}

export function TimelineLoadMoreRow(props: {
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <div className="timeline-load-more-row">
      <Button variant="outline" size="sm" disabled={props.disabled} onClick={props.onClick}>
        {props.loading ? <Spinner size={15} /> : <ChatIcon size={15} />}
        {props.loading ? "Loading older messages..." : "Load older messages"}
      </Button>
    </div>
  );
}
