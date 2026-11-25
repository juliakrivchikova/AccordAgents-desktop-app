import type { ChatScriptChangeRequest } from "../../../shared/scripts";
import type { MachineHostAdmission } from "../machineHostPower";
import type { ScriptSecretStore, ScriptStore } from "../scriptStore";

export class ScriptApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ScriptApiError";
  }
}

export interface ScriptChatParticipant {
  id: string;
  handle: string;
  /** False when the member runs on another host than this one. */
  runsHere?: boolean;
}

export interface ScriptChatInfo {
  id: string;
  title: string;
  archived: boolean;
  participants: ScriptChatParticipant[];
}

/** What the script service needs from the chat side. */
export interface ScriptChatGateway {
  describeChat(chatId: string): Promise<ScriptChatInfo | undefined>;
  postScriptMessage(input: {
    conversationId: string;
    scriptId: string;
    scriptName: string;
    content: string;
    participantIds: string[];
  }): Promise<{ messageId: string }>;
}

/** The local script API's tokens, served by AppMcpService. */
export interface ScriptApiTokenIssuer {
  scriptApiUrl(): string | undefined;
  issueScriptToken(context: { scriptId: string; runId: string }): string;
  revokeScriptToken(token: string): void;
}

export interface ScriptServiceOptions {
  store: ScriptStore;
  secrets: ScriptSecretStore;
  hostId: string;
  hostLabel: string;
  /** The host inside a sentence, e.g. "this Mac". */
  hostPhrase: string;
  tokens: ScriptApiTokenIssuer;
  chat: ScriptChatGateway;
  /** How to start a `node` script: `node` from the User's PATH on the
   *  desktop (the packaged app cannot run as Node), the Node running the
   *  machine runtime on a machine. */
  node: { command: string; env: Record<string, string> };
  bash?: string;
  now?: () => number;
  tickMs?: number;
  bootAt?: () => number;
  /** Start time of a live process, for checking a recorded pid before a kill. */
  processStartedAt?: (pid: number) => Promise<number | undefined>;
  /** Host-wide admission (a cloud machine): refuses new work while the
   *  instance is committed to stopping. */
  admit?: (what: string) => Promise<MachineHostAdmission> | MachineHostAdmission;
  /** A machine can start only its own members; a script there may mention
   *  only members that run on that machine. */
  localMembersOnly?: boolean;
  debugLog?: (event: string, payload: Record<string, unknown>) => void;
  onChanged?: () => void;
}

export interface ProposeScriptChangeInput {
  conversationId: string;
  requesterParticipantId: string;
  requesterLabel: string;
  request: unknown;
}

export type ProposeScriptChangeResult =
  | { kind: "approval"; request: ChatScriptChangeRequest; summary: string; missingSecretNames: string[] }
  | { kind: "ran"; scriptId: string; name: string };

export interface RunningScript {
  runId: string;
  controller: AbortController;
  token: string;
  messagesSent: number;
  /** Posts accepted by the per-run check but not finished yet. */
  messagesInFlight: number;
  secretValues: string[];
  stopReason?: "stopped" | "interrupted";
  done: Promise<void>;
}
