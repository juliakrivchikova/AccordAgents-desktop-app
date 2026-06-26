import { Notification } from "electron";
import type { ChatMessage, Conversation } from "../../shared/types";
import type { DebugLogService } from "./debugLogs";
import type { SettingsService } from "./settings";

const WEBHOOK_TIMEOUT_MS = 5_000;
const MAX_TRACKED_MESSAGE_IDS = 1_000;

export class ChatCompletionNotificationService {
  private readonly pendingMessageIds = new Set<string>();
  private readonly notifiedMessageIds = new Set<string>();

  constructor(
    private readonly settings: SettingsService,
    private readonly debugLogs: DebugLogService
  ) {}

  handleConversationSnapshot(conversation: Conversation): void {
    for (const message of conversation.messages) {
      if (message.role !== "participant") {
        continue;
      }
      if (message.status === "pending") {
        this.pendingMessageIds.add(message.id);
        // A pending bubble whose run is stopped/discarded is spliced out and never
        // reappears here in a terminal state, so its id would orphan in the set.
        // Cap+evict bounds the set (same policy as notifiedMessageIds).
        this.trimTrackedIds(this.pendingMessageIds);
        continue;
      }
      if (!this.pendingMessageIds.delete(message.id) || this.notifiedMessageIds.has(message.id)) {
        continue;
      }
      this.notifiedMessageIds.add(message.id);
      this.trimTrackedIds(this.notifiedMessageIds);
      void this.notifyIfEligible(conversation, message);
    }
  }

  private async notifyIfEligible(conversation: Conversation, message: ChatMessage): Promise<void> {
    const settings = await this.settings.getChatCompletionNotificationSettings();
    if (!settings.enabled) {
      return;
    }
    const workedMs = typeof message.metadata?.workedMs === "number" ? message.metadata.workedMs : undefined;
    if (!workedMs || workedMs < settings.thresholdMs || message.metadata?.terminalReason === "user-stopped") {
      return;
    }
    const title = `${message.participantLabel ?? "Participant"} finished`;
    const duration = this.formatDuration(workedMs);
    const body = `${conversation.title}\nCompleted after ${duration}.`;
    this.showDesktopNotification(title, body);
    if (settings.webhookUrl) {
      await this.postWebhook(settings.webhookUrl, {
        event: "participant_turn_finished",
        app: "AccordAgents",
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        participantId: message.participantId,
        participantLabel: message.participantLabel,
        messageId: message.id,
        status: message.status,
        durationMs: workedMs,
        duration,
        createdAt: message.createdAt
      });
    }
  }

  private showDesktopNotification(title: string, body: string): void {
    if (!Notification.isSupported()) {
      return;
    }
    try {
      new Notification({ title, body }).show();
    } catch (error) {
      void this.debugLogs.write("chat-completion-notification.desktop-error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async postWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        await this.debugLogs.write("chat-completion-notification.webhook-error", {
          status: response.status,
          statusText: response.statusText
        });
      }
    } catch (error) {
      await this.debugLogs.write("chat-completion-notification.webhook-error", {
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(1, Math.round(ms / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  private trimTrackedIds(ids: Set<string>): void {
    while (ids.size > MAX_TRACKED_MESSAGE_IDS) {
      const oldest = ids.values().next().value as string | undefined;
      if (!oldest) {
        return;
      }
      ids.delete(oldest);
    }
  }
}
