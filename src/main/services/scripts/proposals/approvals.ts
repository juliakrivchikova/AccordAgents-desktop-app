import { describeScriptSchedule } from "../../../../shared/scriptSchedule";
import type { ChatScriptChangeRequest } from "../../../../shared/scripts";
import type { ScriptRecord } from "../../scriptStore";
import { alreadyApplied, firstDueAt } from "../records/scriptRules";
import { humanTime, iso } from "../scriptText";
import type { ScriptModules } from "../modules";
import type { ScriptDependencies } from "../dependencies";

/** What the User decided about a proposal. */
export class Approvals {
  constructor(
    private readonly scripts: Pick<ScriptModules, "scheduler" | "scriptHost" | "scriptRecords">,
    private readonly deps: Pick<ScriptDependencies, "now" | "options">
  ) {}

  /** Throws a person-readable reason when this proposal cannot be approved
   *  now; the approval stays pending. */
  async assertApprovable(request: ChatScriptChangeRequest): Promise<void> {
    const record = await this.scripts.scriptRecords.requireRecord(request.scriptId);
    if (request.op !== "create" && request.op !== "update") return;
    if (alreadyApplied(record, request)) return;
    if (!request.revisionId || record.pendingRevisionId !== request.revisionId) {
      throw new Error("This proposal was replaced by a newer one or already handled.");
    }
    const revision = await this.deps.options.store.readRevision(record.id, request.revisionId);
    if (!revision || revision.contentHash !== request.contentHash) {
      throw new Error("The proposed files are no longer what the card shows; ask the member to propose it again.");
    }
    const saved = await this.deps.options.secrets.savedNames(record.id);
    const missing = revision.secretNames.filter((name) => !saved.includes(name));
    if (missing.length > 0) {
      throw new Error(`Enter the ${missing.length === 1 ? "key" : "keys"} ${missing.join(", ")} on the desktop first.`);
    }
  }

  async applyApproved(request: ChatScriptChangeRequest): Promise<string> {
    await this.assertApprovable(request);
    const id = request.scriptId;
    if (request.op === "delete") {
      await this.scripts.scriptRecords.deleteScript(id);
      return `Deleted the scheduled task "${request.name}".`;
    }
    if (request.op === "disable") {
      await this.scripts.scriptRecords.setEnabled(id, false);
      return `Switched off the scheduled task "${request.name}".`;
    }
    if (request.op === "enable") {
      await this.scripts.scriptRecords.setEnabled(id, true);
      return `Switched on the scheduled task "${request.name}". ${request.scheduleText}.`;
    }
    await this.deps.options.store.withScript(id, async () => {
      const record = await this.deps.options.store.readRecord(id);
      if (!record) throw new Error("That scheduled task does not exist.");
      if (alreadyApplied(record, request)) return;
      // Re-checked under the lock: a newer proposal may have replaced this one.
      if (record.pendingRevisionId !== request.revisionId) throw new Error("This proposal was replaced by a newer one or already handled.");
      const revision = await this.deps.options.store.readRevision(id, request.revisionId!);
      if (!revision || revision.contentHash !== request.contentHash) throw new Error("The proposed files are no longer what the card shows; ask the member to propose it again.");
      const nowMs = this.deps.now();
      // Computed before anything is written: a schedule that cannot fire
      // must not leave a half-approved script behind.
      const firstDue = firstDueAt(revision.schedule, nowMs);
      await this.deps.options.store.installFiles(id, revision.files);
      const next: ScriptRecord = {
        ...record,
        name: revision.name,
        description: revision.description,
        runtime: revision.runtime,
        entry: revision.entry,
        schedule: revision.schedule,
        timeoutSeconds: revision.timeoutSeconds,
        secretNames: revision.secretNames,
        permissions: revision.permissions,
        chatLabels: revision.chatLabels,
        participantLabels: revision.participantLabels,
        enabled: true,
        approvedHash: revision.contentHash,
        approvedAt: iso(nowMs),
        appliedRevisionId: revision.revisionId,
        pendingRevisionId: undefined,
        pendingApprovalId: undefined,
        updatedAt: iso(nowMs)
      };
      const runtime = await this.deps.options.store.readRuntime(id);
      runtime.nextDueAt = iso(firstDue);
      runtime.blockedReason = undefined;
      runtime.failingSince = undefined;
      runtime.failureCount = 0;
      runtime.failingAnnounced = false;
      runtime.lastError = undefined;
      await this.deps.options.store.writeRuntime(id, runtime);
      await this.deps.options.store.writeRecord(next);
      await this.deps.options.store.deleteRevision(id, revision.revisionId);
      this.scripts.scheduler.noteScheduled(id, next);
    });
    this.scripts.scriptHost.changed();
    this.scripts.scheduler.schedule(0);
    const record = (await this.deps.options.store.readRecord(id))!;
    const runtime = await this.deps.options.store.readRuntime(id);
    const nextRun = runtime.nextDueAt ? Date.parse(runtime.nextDueAt) : undefined;
    const when = nextRun === undefined ? "soon" : nextRun <= this.deps.now() + 1000 ? "now" : humanTime(nextRun, record.schedule.kind === "cron" ? record.schedule.timeZone : undefined);
    return `${request.op === "create" ? "Added" : "Updated"} the scheduled task "${record.name}": ${describeScriptSchedule(record.schedule).toLowerCase()}, first run ${when}.`;
  }

  /** The User declined the card: drop the proposal; a script that was never
   *  approved is removed with its keys. If the proposal had in fact been
   *  applied (its card could not be saved), declining undoes it as far as
   *  possible: a new script is removed, a changed one is switched off. */
  async rejectPending(request: ChatScriptChangeRequest): Promise<void> {
    if (request.op !== "create" && request.op !== "update") return;
    const record = await this.deps.options.store.readRecord(request.scriptId).catch(() => undefined);
    if (!record) return;
    if (alreadyApplied(record, request)) {
      if (request.op === "create") await this.scripts.scriptRecords.deleteScript(record.id);
      else await this.scripts.scriptRecords.setEnabled(record.id, false);
      return;
    }
    if (record.pendingRevisionId !== request.revisionId) return;
    if (!record.approvedHash) {
      await this.scripts.scriptRecords.deleteScript(record.id);
      return;
    }
    await this.deps.options.store.withScript(record.id, async () => {
      await this.deps.options.store.deleteRevision(record.id, request.revisionId!);
      const current = await this.deps.options.store.readRecord(record.id);
      if (current) await this.deps.options.store.writeRecord({ ...current, pendingRevisionId: undefined, pendingApprovalId: undefined });
    });
    this.scripts.scriptHost.changed();
  }
}
