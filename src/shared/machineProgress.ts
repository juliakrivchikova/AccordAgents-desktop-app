import type { AgentRunProgress, ChatAgentActivityEvent, ReviewProgress } from "./types";

export interface MachineProgressFrame {
  type: "machine.turn.progress.delta";
  conversationId: string;
  runId: string;
  streamId: string;
  sequence: number;
  previousEventId?: string;
  progress: Omit<ReviewProgress, "agentProgress"> & {
    agentProgress?: Omit<AgentRunProgress, "partialContent" | "activityEvents">;
  };
  hasContent: boolean;
  hasActivityEvents: boolean;
  content: { retain: number; append: string };
  activity: { upserts: ChatAgentActivityEvent[]; removedIds: string[]; order?: string[] };
}

export function machineProgressEventId(frame: Pick<MachineProgressFrame, "runId" | "streamId" | "sequence">): string {
  return `machine-progress:${frame.runId}:${frame.streamId}:${frame.sequence}`;
}

/** Only text-only snapshots may be coalesced. Every observed tool/status change
 * keeps its own frame, even when it occurs between two text flushes. */
export function progressStructure(progress: ReviewProgress): string {
  const { createdAt: _createdAt, agentProgress, ...rest } = progress;
  if (!agentProgress) return JSON.stringify(rest);
  const { partialContent: _content, ...agent } = agentProgress;
  return JSON.stringify({ ...rest, agentProgress: agent });
}

export function encodeMachineProgress(
  previous: ReviewProgress | undefined,
  next: ReviewProgress,
  identity: Pick<MachineProgressFrame, "conversationId" | "streamId" | "sequence" | "previousEventId">
): MachineProgressFrame {
  const before = previous?.agentProgress?.partialContent ?? "";
  const after = next.agentProgress?.partialContent ?? "";
  let retain = 0;
  while (retain < before.length && retain < after.length && before.charCodeAt(retain) === after.charCodeAt(retain)) retain++;
  const oldActivities = new Map((previous?.agentProgress?.activityEvents ?? []).map(event => [event.id, JSON.stringify(event)]));
  const activities = next.agentProgress?.activityEvents ?? [];
  const ids = new Set(activities.map(event => event.id));
  const order = activities.map(event => event.id);
  const previousOrder = previous?.agentProgress?.activityEvents?.map(event => event.id) ?? [];
  const { agentProgress, ...header } = next;
  const { partialContent: _content, activityEvents: _activities, ...agent } = agentProgress ?? {};
  return {
    type: "machine.turn.progress.delta", ...identity, runId: next.runId,
    progress: { ...header, ...(agentProgress ? { agentProgress: agent as Omit<AgentRunProgress, "partialContent" | "activityEvents"> } : {}) },
    hasContent: agentProgress?.partialContent !== undefined,
    hasActivityEvents: agentProgress?.activityEvents !== undefined,
    content: { retain, append: after.slice(retain) },
    activity: { upserts: activities.filter(event => oldActivities.get(event.id) !== JSON.stringify(event)),
      removedIds: [...oldActivities.keys()].filter(id => !ids.has(id)),
      ...(JSON.stringify(previousOrder) !== JSON.stringify(order) ? { order } : {}) }
  };
}

export function decodeMachineProgress(previous: ReviewProgress | undefined, frame: MachineProgressFrame): ReviewProgress {
  if (!frame || frame.type !== "machine.turn.progress.delta" || typeof frame.conversationId !== "string" || !frame.conversationId ||
      typeof frame.runId !== "string" || !frame.runId || typeof frame.streamId !== "string" || !frame.streamId ||
      !Number.isSafeInteger(frame.sequence) || frame.sequence < 1 || frame.progress?.runId !== frame.runId ||
      typeof frame.progress.message !== "string" || typeof frame.progress.createdAt !== "string" ||
      !["initial", "extract", "arbiter", "decisions", "debate", "summary", "done", "cancelled", "error"].includes(frame.progress.phase) ||
      typeof frame.hasContent !== "boolean" || typeof frame.hasActivityEvents !== "boolean" ||
      !Number.isSafeInteger(frame.content?.retain) || frame.content.retain < 0 || typeof frame.content.append !== "string" ||
      !Array.isArray(frame.activity?.upserts) || !Array.isArray(frame.activity.removedIds) ||
      (frame.activity.order !== undefined && !Array.isArray(frame.activity.order))) {
    throw new Error("Invalid machine progress frame.");
  }
  const before = previous?.agentProgress?.partialContent ?? "";
  if (frame.content.retain > before.length) throw new Error("Machine progress is missing its text base.");
  if (previous && previous.runId !== frame.runId) throw new Error("Machine progress changed run identity.");
  const activities = new Map((previous?.agentProgress?.activityEvents ?? []).map(event => [event.id, event]));
  for (const id of frame.activity.removedIds) {
    if (typeof id !== "string") throw new Error("Invalid removed machine activity identity.");
    activities.delete(id);
  }
  for (const event of frame.activity.upserts) {
    if (!event || typeof event.id !== "string" || !event.id || typeof event.label !== "string" ||
        typeof event.createdAt !== "string" || !Number.isSafeInteger(event.sequence) ||
        !["tool", "command", "file-edit", "web", "approval", "status"].includes(event.kind) ||
        (event.status !== undefined && !["started", "completed", "failed"].includes(event.status))) {
      throw new Error("Invalid machine activity event.");
    }
    activities.set(event.id, event);
  }
  const order = frame.activity.order ?? previous?.agentProgress?.activityEvents?.map(event => event.id) ?? [];
  if (new Set(order).size !== order.length ||
      order.some(id => typeof id !== "string" || !activities.has(id)) || activities.size !== order.length) {
    throw new Error("Machine progress is missing its activity base.");
  }
  const agent = frame.progress.agentProgress;
  if (agent && ("partialContent" in agent || "activityEvents" in agent)) throw new Error("Machine progress must encode changing bodies as deltas.");
  if ((frame.hasContent || frame.hasActivityEvents) && !agent) throw new Error("Machine progress has no participant state.");
  if (agent && (typeof agent.participantLabel !== "string" || !["running", "finished"].includes(agent.state))) throw new Error("Invalid machine participant progress.");
  return { ...frame.progress, ...(agent ? { agentProgress: { ...agent,
    ...(frame.hasContent ? { partialContent: before.slice(0, frame.content.retain) + frame.content.append } : {}),
    ...(frame.hasActivityEvents ? { activityEvents: order.map(id => activities.get(id)!) } : {})
  } } : {}) };
}
