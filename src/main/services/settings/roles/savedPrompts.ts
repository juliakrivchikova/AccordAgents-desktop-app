import type { AppSettings, ChatSavedPromptConfigUpdate } from "../../../../shared/types";
import {
  CHAT_SAVED_PROMPT_BODY_MAX_CHARS, CHAT_SAVED_PROMPT_LABEL_MAX_CHARS, CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS,
  isValidChatSavedPromptTrigger, normalizeChatSavedPromptTrigger
} from "../../../../shared/chatSavedPrompts";
import { savedPromptIdFromLabel } from "./storedRules";
import type { SettingsModules } from "../modules";

/** Saved prompts. */
export class SavedPrompts {
  constructor(private readonly settings: Pick<SettingsModules, "publicSettings" | "settingsStore">) {}

  async saveChatSavedPromptConfig(update: ChatSavedPromptConfigUpdate): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const label = update.label.trim();
    const trigger = normalizeChatSavedPromptTrigger(update.trigger);
    const body = update.body.trim();
    if (!label) {
      throw new Error("Saved prompt name is required.");
    }
    if (label.length > CHAT_SAVED_PROMPT_LABEL_MAX_CHARS) {
      throw new Error(`Saved prompt name must be ${CHAT_SAVED_PROMPT_LABEL_MAX_CHARS} characters or less.`);
    }
    if (!trigger) {
      throw new Error("Saved prompt slash trigger is required.");
    }
    if (trigger.length > CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS) {
      throw new Error(`Saved prompt slash trigger must be ${CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS} characters or less.`);
    }
    if (!isValidChatSavedPromptTrigger(trigger)) {
      throw new Error("Saved prompt slash trigger may use letters, numbers, underscores, and hyphens only.");
    }
    if (!body) {
      throw new Error("Saved prompt body is required.");
    }
    if (body.length > CHAT_SAVED_PROMPT_BODY_MAX_CHARS) {
      throw new Error(`Saved prompt body must be ${CHAT_SAVED_PROMPT_BODY_MAX_CHARS} characters or less.`);
    }

    const prompts = stored.chatSavedPrompts ?? [];
    const normalizedId = update.id?.trim();
    const duplicate = prompts.find((prompt) =>
      prompt.id !== normalizedId && prompt.trigger.toLowerCase() === trigger.toLowerCase()
    );
    if (duplicate) {
      throw new Error(`Saved prompt /${trigger} already exists.`);
    }

    const now = new Date().toISOString();
    const existing = normalizedId ? prompts.find((prompt) => prompt.id === normalizedId) : undefined;
    if (existing) {
      stored.chatSavedPrompts = prompts.map((prompt) =>
        prompt.id === existing.id
          ? {
              ...prompt,
              label,
              trigger,
              body,
              version: prompt.version + 1,
              updatedAt: now
            }
          : prompt
      );
    } else {
      stored.chatSavedPrompts = [
        ...prompts,
        {
          id: savedPromptIdFromLabel(label),
          label,
          trigger,
          body,
          version: 1,
          updatedAt: now
        }
      ];
    }

    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async deleteChatSavedPromptConfig(id: string): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const normalized = id.trim();
    stored.chatSavedPrompts = (stored.chatSavedPrompts ?? []).filter((prompt) => prompt.id !== normalized);
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }
}
