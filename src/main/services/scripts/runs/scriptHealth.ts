import type { ScriptRunStatus } from "../../../../shared/scripts";
import type { ScriptRecord } from "../../scriptStore";
import { FAILING_NOTICE_MIN_GAP_MS, INTERVAL_FAILURES_BEFORE_NOTICE } from "../constants";
import { errorMessage, iso } from "../scriptText";
import type { ScriptModules } from "../modules";
import type { ScriptDependencies } from "../dependencies";

/** Says when a script starts or stops failing, and blocks one that cannot run. */
export class ScriptHealth {
  constructor(
    private readonly scripts: Pick<ScriptModules, "scriptHost">,
    private readonly deps: Pick<ScriptDependencies, "now" | "options">
  ) {}

  async block(id: string, reason: string): Promise<void> {
    const notify = await this.deps.options.store.withScript(id, async () => {
      if (!await this.deps.options.store.readRecord(id)) return false;
      const runtime = await this.deps.options.store.readRuntime(id);
      const first = runtime.blockedReason !== reason;
      runtime.blockedReason = reason;
      await this.deps.options.store.writeRuntime(id, runtime);
      return first;
    });
    if (notify) await this.notice(id, `Blocked: ${reason}`);
  }

  /** Failing and recovered notices, debounced: an interval script must fail
   *  twice in a row, a new "is failing" notice goes out at most once an hour
   *  however the script flaps, and a recovery is announced only when the
   *  failure was. */
  async applyHealthTransition(id: string, record: ScriptRecord, status: ScriptRunStatus, failure: string | undefined): Promise<void> {
    if (status !== "ok" && status !== "failed" && status !== "timeout") return;
    const transition = await this.deps.options.store.withScript(id, async () => {
      // Deleted while it ran: nothing to record, and writing would recreate its directory.
      if (!await this.deps.options.store.readRecord(id)) return undefined;
      const runtime = await this.deps.options.store.readRuntime(id);
      const now = this.deps.now();
      if (status === "ok") {
        if (!runtime.failingSince && !runtime.failingAnnounced) return undefined;
        const announced = runtime.failingAnnounced === true;
        runtime.failingSince = undefined;
        runtime.failureCount = 0;
        runtime.lastError = undefined;
        runtime.failingAnnounced = false;
        await this.deps.options.store.writeRuntime(id, runtime);
        return announced ? "recovered" as const : undefined;
      }
      runtime.lastError = failure;
      runtime.failingSince = runtime.failingSince ?? iso(now);
      runtime.failureCount = (runtime.failureCount ?? 0) + 1;
      const threshold = record.schedule.kind === "interval" ? INTERVAL_FAILURES_BEFORE_NOTICE : 1;
      const lastNotice = runtime.lastFailingNoticeAt ? Date.parse(runtime.lastFailingNoticeAt) : undefined;
      const announce = runtime.failingAnnounced !== true
        && runtime.failureCount >= threshold
        && (lastNotice === undefined || now - lastNotice >= FAILING_NOTICE_MIN_GAP_MS);
      if (announce) {
        runtime.failingAnnounced = true;
        runtime.lastFailingNoticeAt = iso(now);
      }
      await this.deps.options.store.writeRuntime(id, runtime);
      return announce ? "failing" as const : undefined;
    });
    if (transition === "failing") {
      await this.notice(id, `Failing: ${failure ?? "its last run did not succeed"}. Its history is in Settings → Scheduled Tasks.`);
    } else if (transition === "recovered") {
      await this.notice(id, "Working again.");
    }
  }

  /** A message from the script itself about its own state, posted into the
   *  chat it was set up in. It mentions nobody, so it starts nobody. The
   *  script's name is already the author, so the text does not repeat it. */
  async notice(id: string, text: string): Promise<void> {
    const record = await this.deps.options.store.readRecord(id);
    if (!record) return;
    const chatId = record.permissions.chatIds.includes(record.createdInChatId)
      ? record.createdInChatId
      : record.permissions.chatIds[0] ?? record.createdInChatId;
    try {
      await this.deps.options.chat.postScriptMessage({
        conversationId: chatId,
        scriptId: id,
        scriptName: record.name,
        content: text,
        participantIds: []
      });
    } catch (error) {
      this.scripts.scriptHost.log("scripts.notice.error", { scriptId: id, message: errorMessage(error) });
    }
  }
}
