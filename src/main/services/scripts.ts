import type {
  ChatScriptChangeRequest, ScheduledScriptSummary, ScriptApiPostMessageResult, ScriptRevisionContent, ScriptRunRow
} from "../../shared/scripts";
import type { ProposeScriptChangeInput, ProposeScriptChangeResult } from "./scripts/types";
import { DEFAULT_TICK_MS } from "./scripts/constants";
import type { ScriptServiceOptions } from "./scripts/types";
import { createScriptModules, type ScriptModules } from "./scripts/modules";

export { ScriptApiError, type ScriptChatParticipant, type ScriptChatInfo, type ScriptChatGateway, type ScriptApiTokenIssuer, type ScriptServiceOptions, type ProposeScriptChangeInput, type ProposeScriptChangeResult } from "./scripts/types";
export { redactScriptOutput, redactedTail } from "./scripts/scriptText";
export { handleScriptsOperation } from "./scripts/scriptOperations";

/** Scheduled scripts on one host: proposal, approval, schedule, runs, and
 *  the script API's message path. */
export class ScriptService {
  private readonly modules: ScriptModules;

  constructor(options: ScriptServiceOptions) {
    this.modules = createScriptModules({ options, now: options.now ?? Date.now, tickMs: options.tickMs ?? DEFAULT_TICK_MS });
  }

  /** The host's name as the User knows it. A machine learns the name the
   *  desktop gave it only once the desktop greets it. */
  setHostName(label: string, phrase: string): void {
    this.modules.scriptHost.setHostName(label, phrase);
  }

  start(): Promise<void> {
    return this.modules.scheduler.start();
  }

  /** Stop the scheduler and every running script; their runs are recorded
   *  as interrupted. Bounded: quitting never waits on a slow tick. */
  stop(): Promise<void> {
    return this.modules.scheduler.stop();
  }

  /** Run whatever is due now. Also called on wake from sleep. */
  tick(): Promise<void> {
    return this.modules.scheduler.tick();
  }

  /** True while a switched-on script needs this host awake for its next
   *  run, or a script is running. A cloud machine does not stop when idle then. */
  keepsHostAwake(): boolean {
    return this.modules.scheduler.keepsHostAwake();
  }

  /** How many switched-on scripts keep the host awake, for "Kept on by …". */
  scheduledCount(): number {
    return this.modules.scheduler.scheduledCount();
  }

  // ---------------------------------------------------------------- runs

  /** Start one run now. Throws when it cannot start. */
  runNow(id: string): Promise<void> {
    return this.modules.scriptRuns.runNow(id);
  }

  // ------------------------------------------------------------ script API

  /** `POST /script-api/messages` from a running script. */
  postFromScript(context: { scriptId: string; runId: string }, body: unknown): Promise<ScriptApiPostMessageResult> {
    return this.modules.scriptPosts.postFromScript(context, body);
  }

  /** Post the held messages in order. Each leaves the held list only once it
   *  is posted; one that cannot be posted (its member left the chat) stays
   *  held, the rest still go out, and the failures are reported. */
  releaseHeld(id: string): Promise<void> {
    return this.modules.scriptPosts.releaseHeld(id);
  }

  discardHeld(id: string): Promise<void> {
    return this.modules.scriptPosts.discardHeld(id);
  }

  proposeChange(input: ProposeScriptChangeInput): Promise<ProposeScriptChangeResult> {
    return this.modules.proposals.proposeChange(input);
  }

  attachApproval(scriptId: string, approvalId: string, revisionId: string | undefined): Promise<void> {
    return this.modules.proposals.attachApproval(scriptId, approvalId, revisionId);
  }

  /** Throws a person-readable reason when this proposal cannot be approved
   *  now; the approval stays pending. */
  assertApprovable(request: ChatScriptChangeRequest): Promise<void> {
    return this.modules.approvals.assertApprovable(request);
  }

  applyApproved(request: ChatScriptChangeRequest): Promise<string> {
    return this.modules.approvals.applyApproved(request);
  }

  /** The User declined the card: drop the proposal; a script that was never
   *  approved is removed with its keys. If the proposal had in fact been
   *  applied (its card could not be saved), declining undoes it as far as
   *  possible: a new script is removed, a changed one is switched off. */
  rejectPending(request: ChatScriptChangeRequest): Promise<void> {
    return this.modules.approvals.rejectPending(request);
  }

  // ------------------------------------------------------- direct controls

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.modules.scriptRecords.setEnabled(id, enabled);
  }

  deleteScript(id: string): Promise<void> {
    return this.modules.scriptRecords.deleteScript(id);
  }

  setSecret(id: string, name: string, value: string): Promise<void> {
    return this.modules.scriptRecords.setSecret(id, name, value);
  }

  deleteSecret(id: string, name: string): Promise<void> {
    return this.modules.scriptRecords.deleteSecret(id, name);
  }

  list(): Promise<ScheduledScriptSummary[]> {
    return this.modules.scriptRecords.list();
  }

  summary(id: string, savedNames?: string[]): Promise<ScheduledScriptSummary> {
    return this.modules.scriptRecords.summary(id, savedNames);
  }

  /** Run history, newest first. With a chat id, only that chat's scripts. */
  runs(id: string, conversationId?: string, limit?: number): Promise<ScriptRunRow[]> {
    return this.modules.scriptRecords.runs(id, conversationId, limit);
  }

  revisionContent(id: string, revisionId?: string): Promise<ScriptRevisionContent> {
    return this.modules.scriptRecords.revisionContent(id, revisionId);
  }

  /** Read-only view for agents in one chat: that chat's scripts only, no
   *  file contents, no key values. */
  listForAgent(conversationId: string): Promise<Array<Record<string, unknown>>> {
    return this.modules.scriptRecords.listForAgent(conversationId);
  }
}
