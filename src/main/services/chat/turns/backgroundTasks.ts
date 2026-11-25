import type { ChatBackgroundTasksEvent } from "../../../../shared/types";
import type { CliAgentBackgroundTask } from "../../cliAgents";
import type { ChatDependencies } from "../dependencies";

/** Background work members left running, by chat. */
export class BackgroundTasks {
  /** Live background work of each member, by chat. Only as long as the CLI
   *  process that runs it: kept in memory and never stored, so it cannot
   *  outlive a restart or drift between copies of the chat. `source` is
   *  "local" for this host's members, or the machine that reported them. */
  readonly memberBackgroundTasks = new Map<string, Map<string, { source: string; labels: string[] }>>();
  private readonly backgroundTaskListeners = new Set<(event: ChatBackgroundTasksEvent) => void>();

  constructor(private readonly deps: Pick<ChatDependencies, "debugLogs">) {}

  /** Called with every change of a member's live background tasks. */
  onBackgroundTasksChanged(listener: (event: ChatBackgroundTasksEvent) => void): () => void {
    this.backgroundTaskListeners.add(listener);
    return () => {
      this.backgroundTaskListeners.delete(listener);
    };
  }

  /** The live background tasks of a chat's members, by member id. */
  backgroundTasksForConversation(conversationId: string): Record<string, string[]> {
    return Object.fromEntries(Array.from(this.memberBackgroundTasks.get(conversationId)?.entries() ?? [])
      .map(([participantId, entry]) => [participantId, [...entry.labels]]));
  }

  /** Every member with live background work here (a machine reports these to
   *  the desktop on reconnect). */
  localBackgroundTasks(): ChatBackgroundTasksEvent[] {
    const events: ChatBackgroundTasksEvent[] = [];
    for (const [conversationId, members] of this.memberBackgroundTasks) {
      for (const [participantId, entry] of members) {
        if (entry.source === "local") {
          events.push({ conversationId, participantId, labels: [...entry.labels] });
        }
      }
    }
    return events;
  }

  /** A machine reported the live background tasks of a member it hosts. */
  applyMachineBackgroundTasks(machineId: string, event: ChatBackgroundTasksEvent): void {
    this.setMemberBackgroundTasks(event.conversationId, event.participantId, event.labels, `machine:${machineId}`);
  }

  /** A machine's complete list (sent with its hello or on request): replaces
   *  everything it reported before, so work that ended while the link was
   *  down, or that died with a restarted machine, does not linger. */
  replaceMachineBackgroundTasks(machineId: string, events: ChatBackgroundTasksEvent[]): void {
    const kept = new Set(events.filter((event) => event.labels.length > 0).map((event) => `${event.conversationId}\u0000${event.participantId}`));
    for (const [conversationId, members] of Array.from(this.memberBackgroundTasks)) {
      for (const [participantId, entry] of Array.from(members)) {
        if (entry.source === `machine:${machineId}` && !kept.has(`${conversationId}\u0000${participantId}`)) {
          this.setMemberBackgroundTasks(conversationId, participantId, [], entry.source);
        }
      }
    }
    for (const event of events) {
      this.applyMachineBackgroundTasks(machineId, event);
    }
  }

  handleBackgroundTasksChanged(conversationId: string, participantId: string, tasks: CliAgentBackgroundTask[]): void {
    this.setMemberBackgroundTasks(conversationId, participantId, tasks.map((task) => task.label), "local");
  }

  private setMemberBackgroundTasks(conversationId: string, participantId: string, labels: string[], source: string): void {
    const members = this.memberBackgroundTasks.get(conversationId) ?? new Map<string, { source: string; labels: string[] }>();
    const current = members.get(participantId);
    if (labels.length === 0) {
      if (!current || current.source !== source) {
        return;
      }
      members.delete(participantId);
    } else {
      if (current && current.source === source && current.labels.length === labels.length && current.labels.every((label, index) => label === labels[index])) {
        return;
      }
      members.set(participantId, { source, labels: [...labels] });
    }
    if (members.size > 0) {
      this.memberBackgroundTasks.set(conversationId, members);
    } else {
      this.memberBackgroundTasks.delete(conversationId);
    }
    const event: ChatBackgroundTasksEvent = { conversationId, participantId, labels: [...labels] };
    for (const listener of this.backgroundTaskListeners) {
      try {
        listener(event);
      } catch (error) {
        void this.deps.debugLogs.write("chat.background-tasks.listener-error", {
          conversationId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}
