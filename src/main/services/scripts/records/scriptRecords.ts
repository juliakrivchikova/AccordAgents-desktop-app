import { describeScriptSchedule } from "../../../../shared/scriptSchedule";
import type { ScheduledScriptSummary, ScriptHealth, ScriptRevisionContent, ScriptRunRow } from "../../../../shared/scripts";
import { scriptContentHash, type ScriptRecord, type ScriptRevision } from "../../scriptStore";
import { SECRET_MAX_CHARS, STOP_WAIT_MS } from "../constants";
import { belongsToChat, firstDueAt } from "./scriptRules";
import { iso } from "../scriptText";
import type { ScriptModules } from "../modules";
import type { ScriptDependencies } from "../dependencies";

/** Scripts as Settings and members see them. */
export class ScriptRecords {
  constructor(
    private readonly scripts: Pick<ScriptModules, "scheduler" | "scriptHost" | "scriptRuns">,
    private readonly deps: Pick<ScriptDependencies, "now" | "options">
  ) {}

  async requireChatScript(id: string, conversationId: string): Promise<ScriptRecord> {
    const record = await this.requireRecord(id);
    if (!belongsToChat(record, conversationId)) throw new Error("That scheduled task does not belong to this chat.");
    return record;
  }

  // ------------------------------------------------------- direct controls

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = await this.requireRecord(id);
    if (!record.approvedHash) throw new Error("Approve the task first.");
    await this.deps.options.store.withScript(id, async () => {
      const current = (await this.deps.options.store.readRecord(id))!;
      const runtime = await this.deps.options.store.readRuntime(id);
      runtime.nextDueAt = enabled ? iso(firstDueAt(current.schedule, this.deps.now())) : undefined;
      if (enabled) runtime.blockedReason = undefined;
      await this.deps.options.store.writeRuntime(id, runtime);
      await this.deps.options.store.writeRecord({ ...current, enabled, updatedAt: iso(this.deps.now()) });
      this.scripts.scheduler.noteScheduled(id, { ...current, enabled });
    });
    if (!enabled) this.scripts.scriptRuns.stopRun(id);
    this.scripts.scriptHost.changed();
    this.scripts.scheduler.schedule(0);
  }

  async deleteScript(id: string): Promise<void> {
    await this.requireRecord(id);
    this.scripts.scheduler.noteScheduled(id, undefined);
    const run = this.scripts.scriptRuns.running.get(id);
    this.scripts.scriptRuns.stopRun(id);
    if (run) await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref())]);
    await this.deps.options.store.withScript(id, () => this.deps.options.store.deleteScript(id));
    await this.deps.options.secrets.deleteScript(id);
    this.scripts.scriptHost.changed();
  }

  async setSecret(id: string, name: string, value: string): Promise<void> {
    const record = await this.requireRecord(id);
    const names = new Set(record.secretNames);
    if (record.pendingRevisionId) {
      const revision = await this.deps.options.store.readRevision(id, record.pendingRevisionId);
      revision?.secretNames.forEach((item) => names.add(item));
    }
    if (!names.has(name)) throw new Error(`The task does not use a key named ${name}.`);
    const trimmed = value.trim();
    if (!trimmed) throw new Error("A key value cannot be empty.");
    if (trimmed.length > SECRET_MAX_CHARS) throw new Error(`A key value is at most ${SECRET_MAX_CHARS} characters.`);
    await this.deps.options.secrets.set(id, name, trimmed);
    this.scripts.scriptHost.changed();
  }

  async deleteSecret(id: string, name: string): Promise<void> {
    await this.requireRecord(id);
    await this.deps.options.secrets.delete(id, name);
    this.scripts.scriptHost.changed();
  }

  // ----------------------------------------------------------------- reads

  async requireRecord(id: string): Promise<ScriptRecord> {
    let record: ScriptRecord | undefined;
    try {
      record = await this.deps.options.store.readRecord(id);
    } catch {
      record = undefined;
    }
    if (!record) throw new Error("That scheduled task does not exist.");
    return record;
  }

  async list(): Promise<ScheduledScriptSummary[]> {
    const savedByScript = await this.deps.options.secrets.savedNamesByScript();
    const summaries: ScheduledScriptSummary[] = [];
    for (const id of await this.deps.options.store.listIds()) {
      const summary = await this.summary(id, savedByScript[id] ?? []).catch(() => undefined);
      if (summary) summaries.push(summary);
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async summary(id: string, savedNames?: string[]): Promise<ScheduledScriptSummary> {
    const record = await this.requireRecord(id);
    const runtime = await this.deps.options.store.readRuntime(id);
    const saved = savedNames ?? await this.deps.options.secrets.savedNames(id);
    const held = await this.deps.options.store.readHeld(id);
    let pending: ScriptRevision | undefined;
    if (record.pendingRevisionId) pending = await this.deps.options.store.readRevision(id, record.pendingRevisionId);
    const shown = !record.approvedHash && pending ? { ...record, ...pending, id: record.id } : record;
    const neededSecrets = new Set([...record.secretNames, ...(pending?.secretNames ?? [])]);
    const missing = [...neededSecrets].filter((name) => !saved.includes(name));
    let health: ScriptHealth;
    if (!record.approvedHash) health = "needs-approval";
    else if (record.secretNames.some((name) => !saved.includes(name))) health = "waiting-for-keys";
    else if (!record.enabled) health = "off";
    else if (runtime.blockedReason) health = "blocked";
    else if (held.length > 0) health = "holding-messages";
    else if (runtime.failingSince) health = "failing";
    else if (runtime.lastRunAt) health = "ok";
    else health = "never-run";
    const lastError = runtime.blockedReason
      ?? runtime.lastError
      ?? (missing.length > 0 && record.approvedHash ? `Waiting for keys: ${missing.join(", ")}.` : undefined);
    return {
      id: record.id,
      name: shown.name,
      description: shown.description,
      hostId: record.hostId,
      hostLabel: this.scripts.scriptHost.hostLabel(),
      hostPhrase: this.scripts.scriptHost.hostPhrase(),
      runtime: shown.runtime,
      entry: shown.entry,
      schedule: shown.schedule,
      scheduleText: describeScriptSchedule(shown.schedule),
      timeoutSeconds: shown.timeoutSeconds,
      secretNames: [...neededSecrets].sort(),
      savedSecretNames: saved.filter((name) => neededSecrets.has(name)),
      permissions: shown.permissions,
      chatLabels: shown.chatLabels,
      participantLabels: shown.participantLabels,
      enabled: record.enabled,
      approved: Boolean(record.approvedHash),
      ...(record.approvedAt ? { approvedAt: record.approvedAt } : {}),
      ...(record.pendingApprovalId ? { pendingApprovalId: record.pendingApprovalId } : {}),
      createdByParticipantId: record.createdByParticipantId,
      ...(record.createdByLabel ? { createdByLabel: record.createdByLabel } : {}),
      createdInChatId: record.createdInChatId,
      health,
      ...(runtime.lastRunAt ? { lastRunAt: runtime.lastRunAt } : {}),
      ...(runtime.lastRunStatus ? { lastRunStatus: runtime.lastRunStatus } : {}),
      ...(record.enabled && record.approvedHash && runtime.nextDueAt ? { nextRunAt: runtime.nextDueAt } : {}),
      running: this.scripts.scriptRuns.running.has(id) || this.scripts.scriptRuns.starting.has(id),
      heldMessageCount: held.length,
      ...(lastError ? { lastError } : {})
    };
  }

  /** Run history, newest first. With a chat id, only that chat's scripts. */
  async runs(id: string, conversationId?: string, limit?: number): Promise<ScriptRunRow[]> {
    if (conversationId) await this.requireChatScript(id, conversationId);
    else await this.requireRecord(id);
    const rows = [...(await this.deps.options.store.readRuns(id))].reverse();
    return limit === undefined ? rows : rows.slice(0, Math.min(Math.max(limit, 1), 100));
  }

  async revisionContent(id: string, revisionId?: string): Promise<ScriptRevisionContent> {
    const record = await this.requireRecord(id);
    if (revisionId) {
      const revision = await this.deps.options.store.readRevision(id, revisionId);
      if (!revision) throw new Error("That proposal is no longer available.");
      return { scriptId: id, revisionId, runtime: revision.runtime, entry: revision.entry, files: revision.files, contentHash: revision.contentHash };
    }
    if (!record.approvedHash) throw new Error("The task has not been approved yet.");
    const files = await this.deps.options.store.readInstalledFiles(id);
    return { scriptId: id, runtime: record.runtime, entry: record.entry, files, contentHash: scriptContentHash(record.runtime, record.entry, files) };
  }

  /** Read-only view for agents in one chat: that chat's scripts only, no
   *  file contents, no key values. */
  async listForAgent(conversationId: string): Promise<Array<Record<string, unknown>>> {
    const visible: ScheduledScriptSummary[] = [];
    for (const item of await this.list()) {
      if (item.createdInChatId === conversationId || item.permissions.chatIds.includes(conversationId)) visible.push(item);
    }
    return visible.map((item) => ({
      scriptId: item.id,
      name: item.name,
      description: item.description,
      host: item.hostLabel,
      schedule: item.scheduleText,
      status: item.health,
      enabled: item.enabled,
      approved: item.approved,
      lastRunAt: item.lastRunAt,
      lastRunStatus: item.lastRunStatus,
      nextRunAt: item.nextRunAt,
      lastError: item.lastError,
      keys: item.secretNames.map((name) => ({ name, saved: item.savedSecretNames.includes(name) })),
      chats: item.permissions.chatIds.map((chatId) => ({ chatId, title: item.chatLabels[chatId] })),
      members: item.permissions.participantIds.map((pid) => item.participantLabels[pid] ?? pid),
      maxWakeupsPerHour: item.permissions.maxWakeupsPerHour,
      heldMessages: item.heldMessageCount
    }));
  }
}
