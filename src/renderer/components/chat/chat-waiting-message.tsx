import { useState } from "react";
import { XIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import { runningReplyOf, waitingMessages } from "../../../shared/waitingMessages";
import type { ChatMessage } from "../../../shared/types";
import { IconButton } from "../primitives";
import type { ChatComposerSendNow } from "./chat-composer";

interface ChatWaitingMessageActionsProps {
  runId: string;
  behindRunId?: string;
  onStopRun: (runId: string) => void;
}

/** Under a message of the User's its member has not taken yet, as the CLI's
 *  own line under a waiting message (the User, 2026-11-25): send it now, which
 *  interrupts the step the member is in, or take it back. Left alone, the
 *  member takes it itself. */
export const ChatWaitingMessageActions = ({ runId, behindRunId, onStopRun }: ChatWaitingMessageActionsProps): JSX.Element => {
  const [pressed, setPressed] = useState<"now" | "back">();
  return (
    <div className="chat-waiting-message" data-testid="chat-waiting-message">
      {behindRunId && (
        <Button
          variant="ghost"
          size="xs"
          disabled={Boolean(pressed)}
          data-testid="chat-waiting-send-now"
          onClick={() => {
            setPressed("now");
            onStopRun(behindRunId);
          }}
        >
          Send now
        </Button>
      )}
      <IconButton
        size="xs"
        icon={XIcon}
        label="Take this message back"
        tooltip="Take back"
        disabled={Boolean(pressed)}
        data-testid="chat-waiting-take-back"
        onClick={() => {
          setPressed("back");
          onStopRun(runId);
        }}
      />
    </div>
  );
};

/** The composer's "send now" for one member (ChatComposerSendNow): while it
 *  writes a reply, and whether a message already waits behind it. */
export function composerSendNow(
  messages: readonly ChatMessage[],
  participantId: string | undefined,
  onStopRun: ((runId: string) => void) | undefined
): ChatComposerSendNow | undefined {
  const runId = participantId && onStopRun ? runningReplyOf(messages, participantId)?.metadata?.runId : undefined;
  if (!runId || !onStopRun) return undefined;
  return {
    waiting: [...waitingMessages(messages).values()].some((waiting) => waiting.behind?.runId === runId),
    onSendNow: () => onStopRun(runId)
  };
}
