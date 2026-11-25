import { randomUUID } from "node:crypto";
import { describeScriptSchedule } from "../../../../shared/scriptSchedule";
import {
  SCRIPT_DEFAULT_MAX_WAKEUPS_PER_HOUR, SCRIPT_DEFAULT_TIMEOUT_SECONDS, SCRIPT_MAX_CHATS, SCRIPT_MAX_TIMEOUT_SECONDS,
  SCRIPT_MAX_WAKEUPS_PER_HOUR, SCRIPT_MIN_TIMEOUT_SECONDS, type ChatScriptChangeRequest, type ScriptChangeToolRequest,
  type ScriptFile, type ScriptPermissions
} from "../../../../shared/scripts";
import { newScriptId, scriptContentHash, validateScriptFiles, type ScriptRecord, type ScriptRevision } from "../../scriptStore";
import { DESCRIPTION_MAX_CHARS, NAME_MAX_CHARS, REASON_MAX_CHARS } from "../constants";
import { boundedInteger, iso, normalizeSchedule, normalizeSecretNames, trimmedString } from "../scriptText";
import type { ProposeScriptChangeInput, ProposeScriptChangeResult, ScriptChatInfo } from "../types";
import type { ScriptModules } from "../modules";
import type { ScriptDependencies } from "../dependencies";

/** Scripts members propose. */
export class Proposals {
  constructor(
    private readonly scripts: Pick<ScriptModules, "scriptHost" | "scriptRecords" | "scriptRuns">,
    private readonly deps: Pick<ScriptDependencies, "now" | "options">
  ) {}

  async proposeChange(input: ProposeScriptChangeInput): Promise<ProposeScriptChangeResult> {
    const request = (input.request ?? {}) as Partial<ScriptChangeToolRequest>;
    const op = request.op;
    const reason = trimmedString(request.reason, "reason", REASON_MAX_CHARS, false);
    if (op === "run_now") {
      const record = await this.scripts.scriptRecords.requireChatScript(String(request.scriptId ?? ""), input.conversationId);
      if (!record.enabled) throw new Error("The task is switched off; ask the User to switch it on first.");
      await this.scripts.scriptRuns.runNow(record.id);
      return { kind: "ran", scriptId: record.id, name: record.name };
    }
    if (op === "create" || op === "update") return this.proposeRevision(input, request, op, reason);
    if (op === "delete" || op === "enable" || op === "disable") {
      const record = await this.scripts.scriptRecords.requireChatScript(String(request.scriptId ?? ""), input.conversationId);
      if (!record.approvedHash && op !== "delete") throw new Error("The task has not been approved yet.");
      const changeRequest = this.changeRequestFromRecord(record, op, reason);
      const verb = op === "delete" ? "Delete" : op === "enable" ? "Switch on" : "Switch off";
      return { kind: "approval", request: changeRequest, summary: `${verb} the scheduled task "${record.name}"`, missingSecretNames: [] };
    }
    throw new Error("op must be create, update, delete, enable, disable or run_now.");
  }

  private async proposeRevision(
    input: ProposeScriptChangeInput,
    request: Partial<ScriptChangeToolRequest>,
    op: "create" | "update",
    reason: string | undefined
  ): Promise<ProposeScriptChangeResult> {
    const current = op === "update" ? await this.scripts.scriptRecords.requireChatScript(String(request.scriptId ?? ""), input.conversationId) : undefined;
    const name = trimmedString(request.name, "name", NAME_MAX_CHARS, !current) ?? current!.name;
    const description = trimmedString(request.description, "description", DESCRIPTION_MAX_CHARS, !current) ?? current!.description;
    let runtime = request.runtime ?? current?.runtime;
    let entry = request.entry ?? current?.entry;
    let files: ScriptFile[] | undefined = request.files;
    if (!files) {
      if (!current?.approvedHash) throw new Error("files are required.");
      files = await this.deps.options.store.readInstalledFiles(current.id);
      if (scriptContentHash(current.runtime, current.entry, files) !== current.approvedHash) {
        throw new Error("The installed files were changed outside the app; send the files you want to run.");
      }
      runtime = runtime ?? current.runtime;
      entry = entry ?? current.entry;
    }
    const validated = validateScriptFiles(runtime, entry, files);
    const schedule = request.schedule !== undefined ? normalizeSchedule(request.schedule) : current?.schedule ?? normalizeSchedule(undefined);
    const timeoutSeconds = boundedInteger(request.timeoutSeconds, "timeoutSeconds", SCRIPT_MIN_TIMEOUT_SECONDS, SCRIPT_MAX_TIMEOUT_SECONDS, current?.timeoutSeconds ?? SCRIPT_DEFAULT_TIMEOUT_SECONDS);
    const secretNames = request.secretNames !== undefined ? normalizeSecretNames(request.secretNames) : current?.secretNames ?? [];
    const permissions = await this.resolvePermissions(input, request, current);
    const id = current?.id ?? newScriptId();
    const contentHash = scriptContentHash(validated.runtime, validated.entry, validated.files);
    const revision: ScriptRevision = {
      version: 1,
      revisionId: randomUUID(),
      scriptId: id,
      createdAt: iso(this.deps.now()),
      name,
      description,
      runtime: validated.runtime,
      entry: validated.entry,
      schedule,
      timeoutSeconds,
      secretNames,
      permissions: permissions.permissions,
      chatLabels: permissions.chatLabels,
      participantLabels: permissions.participantLabels,
      files: validated.files,
      contentHash
    };
    await this.deps.options.store.withScript(id, async () => {
      const nowIso = iso(this.deps.now());
      const record: ScriptRecord = current
        ? { ...(await this.deps.options.store.readRecord(id))!, updatedAt: nowIso }
        : {
            version: 1,
            id,
            name,
            description,
            hostId: this.deps.options.hostId,
            runtime: validated.runtime,
            entry: validated.entry,
            schedule,
            timeoutSeconds,
            secretNames,
            permissions: permissions.permissions,
            chatLabels: permissions.chatLabels,
            participantLabels: permissions.participantLabels,
            enabled: false,
            createdByParticipantId: input.requesterParticipantId,
            createdByLabel: input.requesterLabel,
            createdInChatId: input.conversationId,
            createdAt: nowIso,
            updatedAt: nowIso
          };
      if (record.pendingRevisionId) {
        await this.deps.options.store.deleteRevision(id, record.pendingRevisionId);
      }
      record.pendingRevisionId = revision.revisionId;
      record.pendingApprovalId = undefined;
      await this.deps.options.store.writeRevision(revision);
      await this.deps.options.store.writeRecord(record);
    });
    const saved = await this.deps.options.secrets.savedNames(id);
    const missingSecretNames = secretNames.filter((item) => !saved.includes(item));
    const changeRequest: ChatScriptChangeRequest = {
      kind: "script-change",
      op,
      scriptId: id,
      revisionId: revision.revisionId,
      contentHash,
      name,
      description,
      hostId: this.deps.options.hostId,
      hostLabel: this.scripts.scriptHost.hostLabel(),
      hostPhrase: this.scripts.scriptHost.hostPhrase(),
      runtime: validated.runtime,
      entry: validated.entry,
      schedule,
      scheduleText: describeScriptSchedule(schedule),
      timeoutSeconds,
      secretNames,
      permissions: permissions.permissions,
      chatLabels: permissions.chatLabels,
      participantLabels: permissions.participantLabels,
      fileCount: validated.files.length,
      totalBytes: validated.totalBytes,
      ...(reason ? { reason } : {})
    };
    this.scripts.scriptHost.changed();
    const verb = op === "create" ? "Add" : "Update";
    const members = permissions.permissions.participantIds.map((pid) => permissions.participantLabels[pid] ?? pid);
    const summary = `${verb} the scheduled task "${name}": ${describeScriptSchedule(schedule).toLowerCase()} on ${this.scripts.scriptHost.hostPhrase()}`
      + (members.length > 0 ? `, may wake ${members.join(", ")}` : "")
      + (secretNames.length > 0 ? `; needs keys ${secretNames.join(", ")}` : "")
      + ". Review the code and approve it on the desktop";
    return { kind: "approval", request: changeRequest, summary, missingSecretNames };
  }

  private async resolvePermissions(
    input: ProposeScriptChangeInput,
    request: Partial<ScriptChangeToolRequest>,
    current: ScriptRecord | undefined
  ): Promise<{ permissions: ScriptPermissions; chatLabels: Record<string, string>; participantLabels: Record<string, string> }> {
    const chatIds = request.chatIds !== undefined
      ? (Array.isArray(request.chatIds) ? request.chatIds.map((item) => String(item).trim()).filter(Boolean) : [])
      : current?.permissions.chatIds ?? [input.conversationId];
    if (chatIds.length === 0 || chatIds.length > SCRIPT_MAX_CHATS) throw new Error(`chatIds lists from 1 to ${SCRIPT_MAX_CHATS} existing chats.`);
    const chats: ScriptChatInfo[] = [];
    for (const chatId of [...new Set(chatIds)]) {
      const chat = await this.deps.options.chat.describeChat(chatId);
      if (!chat) throw new Error(`Chat ${chatId} does not exist. In this version a script can post only into existing chats.`);
      chats.push(chat);
    }
    const chatLabels = Object.fromEntries(chats.map((chat) => [chat.id, chat.title]));
    const memberRefs = request.members !== undefined
      ? (Array.isArray(request.members) ? request.members.map((item) => String(item).trim()).filter(Boolean) : [])
      : undefined;
    const participantLabels: Record<string, string> = {};
    let participantIds: string[];
    if (memberRefs === undefined) {
      participantIds = current?.permissions.participantIds ?? [];
      for (const pid of participantIds) participantLabels[pid] = current?.participantLabels[pid] ?? pid;
    } else {
      participantIds = [];
      for (const ref of memberRefs) {
        const key = ref.replace(/^@/, "").toLowerCase();
        const found = chats.flatMap((chat) => chat.participants).find((item) => item.id === ref || item.handle.toLowerCase() === key);
        if (!found) throw new Error(`@${key} is not a member of the script's chats.`);
        if (this.deps.options.localMembersOnly && found.runsHere === false) {
          throw new Error(`@${found.handle} does not run on ${this.scripts.scriptHost.hostPhrase()}. A script here can wake only members that run here; ask a member on the right host to set it up there.`);
        }
        if (!participantIds.includes(found.id)) participantIds.push(found.id);
        participantLabels[found.id] = `@${found.handle}`;
      }
    }
    const maxWakeupsPerHour = boundedInteger(
      request.maxWakeupsPerHour,
      "maxWakeupsPerHour",
      1,
      SCRIPT_MAX_WAKEUPS_PER_HOUR,
      current?.permissions.maxWakeupsPerHour ?? SCRIPT_DEFAULT_MAX_WAKEUPS_PER_HOUR
    );
    return { permissions: { chatIds: chats.map((chat) => chat.id), participantIds, maxWakeupsPerHour }, chatLabels, participantLabels };
  }

  private changeRequestFromRecord(record: ScriptRecord, op: ChatScriptChangeRequest["op"], reason: string | undefined): ChatScriptChangeRequest {
    return {
      kind: "script-change",
      op,
      scriptId: record.id,
      name: record.name,
      description: record.description,
      hostId: record.hostId,
      hostLabel: this.scripts.scriptHost.hostLabel(),
      hostPhrase: this.scripts.scriptHost.hostPhrase(),
      runtime: record.runtime,
      entry: record.entry,
      schedule: record.schedule,
      scheduleText: describeScriptSchedule(record.schedule),
      timeoutSeconds: record.timeoutSeconds,
      secretNames: record.secretNames,
      permissions: record.permissions,
      chatLabels: record.chatLabels,
      participantLabels: record.participantLabels,
      fileCount: 0,
      totalBytes: 0,
      ...(reason ? { reason } : {})
    };
  }

  async attachApproval(scriptId: string, approvalId: string, revisionId: string | undefined): Promise<void> {
    await this.deps.options.store.withScript(scriptId, async () => {
      const record = await this.deps.options.store.readRecord(scriptId);
      if (!record) return;
      if (revisionId && record.pendingRevisionId !== revisionId) return;
      record.pendingApprovalId = approvalId;
      await this.deps.options.store.writeRecord(record);
    });
    this.scripts.scriptHost.changed();
  }
}
