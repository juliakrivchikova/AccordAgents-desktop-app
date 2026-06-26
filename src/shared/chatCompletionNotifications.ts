import type { ChatCompletionNotificationSettings } from "./types";

export const CHAT_COMPLETION_NOTIFICATION_DEFAULT_THRESHOLD_MS = 5 * 60_000;
export const CHAT_COMPLETION_NOTIFICATION_MIN_THRESHOLD_MS = 60_000;
export const CHAT_COMPLETION_NOTIFICATION_MAX_THRESHOLD_MS = 24 * 60 * 60_000;

export function normalizeChatCompletionNotificationSettings(value: unknown): ChatCompletionNotificationSettings {
  const record = isRecord(value) ? value : {};
  return {
    enabled: record.enabled === true,
    thresholdMs: normalizeChatCompletionNotificationThresholdMs(record.thresholdMs),
    webhookUrl: normalizeChatCompletionNotificationWebhookUrl(record.webhookUrl)
  };
}

export function normalizeChatCompletionNotificationThresholdMs(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return CHAT_COMPLETION_NOTIFICATION_DEFAULT_THRESHOLD_MS;
  }
  return Math.min(
    CHAT_COMPLETION_NOTIFICATION_MAX_THRESHOLD_MS,
    Math.max(CHAT_COMPLETION_NOTIFICATION_MIN_THRESHOLD_MS, Math.round(numeric))
  );
}

export function chatCompletionNotificationThresholdMinutes(value: number): number {
  return Math.max(1, Math.round(normalizeChatCompletionNotificationThresholdMs(value) / 60_000));
}

function normalizeChatCompletionNotificationWebhookUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
