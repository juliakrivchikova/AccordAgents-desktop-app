import { MessageSquare, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ReviewProgress } from "../../../shared/types";
import { LoadingDot } from "../primitives";
import { useSessionsViewText } from "../chat/chat-sessions-links";

export function RunStatusLine({ progress }: { progress?: ReviewProgress }): JSX.Element {
  // The status is the app's words: the sessions view names nobody by handle.
  const appText = useSessionsViewText();
  return (
    <div className="run-status-line" aria-live="polite">
      <span className="run-status-text">{progress?.message ? appText(progress.message) : "Thinking"}</span>
      <LoadingDot label="In progress" />
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
        {props.loading ? <RefreshCw size={15} className="spin" /> : <MessageSquare size={15} />}
        {props.loading ? "Loading older messages..." : "Load older messages"}
      </Button>
    </div>
  );
}
