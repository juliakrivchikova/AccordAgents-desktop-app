import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { runningReplyOf, waitingMessages } from "../../../shared/waitingMessages";
import type { ChatMessage } from "../../../shared/types";
import { IconButton } from "../primitives";
import type { ChatComposerSendNow } from "./chat-composer";

interface ChatWaitingMessageActionsProps {
  /** The run the message waits as: taking it back stops it. */
  runId: string;
  /** The member's reply being written now, which Send now cuts short. */
  behindRunId?: string;
  onTakeBack: (runId: string) => void;
  onSendNow?: (runId: string, waitingRunId?: string) => void;
}

/** Under a message of the User's its member has not taken yet, as the CLI's
 *  own line under a waiting message (the User, 2026-11-25): send it now, as
 *  the CLI's send-now (the member takes it at once, and its reply so far is
 *  not stopped), or take it back. Left alone, the member takes it itself. */
export const ChatWaitingMessageActions = ({ runId, behindRunId, onTakeBack, onSendNow }: ChatWaitingMessageActionsProps): JSX.Element => {
  // The run the last press acted on: what waits behind another reply later
  // can be sent now again.
  const [pressedRunId, setPressedRunId] = useState<string>();
  const pressed = pressedRunId !== undefined && (pressedRunId === runId || pressedRunId === behindRunId);
  const act = (actedRunId: string, action: () => void): void => {
    setPressedRunId(actedRunId);
    action();
  };
  return (
    <div className="chat-waiting-message" data-testid="chat-waiting-message">
      {behindRunId && onSendNow && (
        <Button
          variant="ghost"
          size="xs"
          className="text-ui-text-2"
          disabled={pressed}
          data-testid="chat-waiting-send-now"
          onClick={() => act(behindRunId, () => onSendNow(behindRunId, runId))}
        >
          Send now
        </Button>
      )}
      <IconButton
        size="xs"
        icon={XIcon}
        label="Take this message back"
        tooltip="Take back"
        disabled={pressed}
        data-testid="chat-waiting-take-back"
        onClick={() => act(runId, () => onTakeBack(runId))}
      />
    </div>
  );
};

/** The composer's "send now" for one member (ChatComposerSendNow): while it
 *  writes a reply, and whether a message already waits behind it. */
export function composerSendNow(
  messages: readonly ChatMessage[],
  participantId: string | undefined,
  onSendNow: ((runId: string, waitingRunId?: string) => void) | undefined
): ChatComposerSendNow | undefined {
  const runId = participantId && onSendNow ? runningReplyOf(messages, participantId)?.metadata?.runId : undefined;
  if (!participantId || !runId || !onSendNow) return undefined;
  return {
    runId,
    waiting: waitingMessages(messages, participantId).size > 0,
    onSendNow: () => onSendNow(runId)
  };
}
