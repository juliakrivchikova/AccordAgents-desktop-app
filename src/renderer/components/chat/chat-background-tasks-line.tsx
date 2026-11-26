import { useContext } from "react";
import { HoverCard } from "radix-ui";
import { Spinner } from "@/components/ui/spinner";
import { sessionsCompactDuration } from "../../../shared/mainSessionView";
import type { ChatBackgroundTask } from "../../../shared/types";
import { backgroundTasksStatusLabel, ChatBackgroundTasksContext } from "./chat-roster-status";
import { useStreamingElapsedSeconds } from "./chat-streaming";

interface ChatBackgroundTasksLineProps {
  participantId: string;
}

/** The main session's background work under the sessions view's composer,
 *  as Claude Code shows it under its prompt: only "2 background tasks";
 *  hovering lists each task with how long it runs. The names stay out of the
 *  line itself (the User, 2026-11-26). Nothing while none runs. */
export const ChatBackgroundTasksLine = ({ participantId }: ChatBackgroundTasksLineProps): JSX.Element | null => {
  const tasks = useContext(ChatBackgroundTasksContext).get(participantId) ?? [];
  if (tasks.length === 0) {
    return null;
  }
  const label = backgroundTasksStatusLabel(tasks.length);
  return (
    <div className="chat-background-tasks">
      <HoverCard.Root openDelay={500} closeDelay={60}>
        <HoverCard.Trigger asChild>
          <span className="chat-background-tasks-line" tabIndex={0} data-testid="chat-background-tasks-line">
            <Spinner size={14} />
            <span>{label}</span>
          </span>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={8}
            className="chat-background-tasks-card"
            data-testid="chat-background-tasks-card"
          >
            <span className="chat-background-tasks-card-title">Background tasks</span>
            <ul className="chat-background-tasks-list">
              {tasks.map((task, index) => <BackgroundTaskRow key={`${index}:${task.label}`} task={task} />)}
            </ul>
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
    </div>
  );
};

const BackgroundTaskRow = ({ task }: { task: ChatBackgroundTask }): JSX.Element => (
  <li className="chat-background-tasks-row">
    <span className="chat-background-tasks-name">{task.label}</span>
    <span className="chat-background-tasks-time">
      {task.startedAt ? <RunningFor since={task.startedAt} /> : "running"}
    </span>
  </li>
);

/** "running 14m", counting up; a machine on an older runtime sends no start,
 *  and its task says only "running". */
const RunningFor = ({ since }: { since: string }): JSX.Element => {
  const seconds = useStreamingElapsedSeconds(since);
  return <>{`running ${sessionsCompactDuration(seconds * 1000)}`}</>;
};
