import { createContext, useContext } from "react";
import { KeyIcon } from "@phosphor-icons/react";
import { HoverCard } from "radix-ui";

/** Members of the open chat whose background tasks keep their process on the
 *  environment variables it started with (ChatBackgroundTasksEvent). */
export const ChatEnvironmentPendingContext = createContext<ReadonlySet<string>>(new Set());

export const ENVIRONMENT_PENDING_TITLE = "New environment variables are waiting";

export function environmentPendingText(taskCount: number): string {
  const finishes = taskCount > 1 ? "When its background tasks finish" : "When its background task finishes";
  return `This member still runs with the variables it started with. ${finishes}, it restarts with the new ones and carries on the same conversation.`;
}

interface ChatEnvironmentPendingKeyProps {
  participantId: string;
  taskCount: number;
  /** Inside a button (the members list) the mark takes no focus of its own:
   *  the button's own label carries the title. */
  focusable?: boolean;
}

/** Settings → Environment's key, in the pending status colour (the User,
 *  2026-11-27), shown while the member's background tasks keep it on the
 *  values it started with; hovering or focusing it explains. It goes away by
 *  itself once the member has restarted. */
export const ChatEnvironmentPendingKey = ({ participantId, taskCount, focusable = true }: ChatEnvironmentPendingKeyProps): JSX.Element | null => {
  if (!useContext(ChatEnvironmentPendingContext).has(participantId)) {
    return null;
  }
  return (
    <HoverCard.Root openDelay={300} closeDelay={60}>
      <HoverCard.Trigger asChild>
        <span
          className="chat-environment-pending"
          tabIndex={focusable ? 0 : undefined}
          aria-label={ENVIRONMENT_PENDING_TITLE}
          role="img"
          data-testid="chat-environment-pending"
        >
          <KeyIcon size={14} aria-hidden />
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="chat-agent-card chat-environment-pending-card"
          data-testid="chat-environment-pending-card"
        >
          <span className="chat-agent-card-title">{ENVIRONMENT_PENDING_TITLE}</span>
          <span className="chat-agent-card-line">{environmentPendingText(taskCount)}</span>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
};
