import type { AppSettings, ChatBehaviorRuleConfigUpdate } from "../../../../shared/types";
import { CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS, CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS } from "../../../../shared/chatBehaviorRules";
import { behaviorRuleIdFromLabel, normalizeBehaviorRuleIds } from "./storedRules";
import type { SettingsModules } from "../modules";

/** Reusable rules a member can carry. */
export class BehaviorRules {
  constructor(private readonly settings: Pick<SettingsModules, "publicSettings" | "settingsStore">) {}

  async saveChatBehaviorRuleConfig(update: ChatBehaviorRuleConfigUpdate): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const label = update.label.trim();
    const instructions = update.instructions.trim();
    if (!label) {
      throw new Error("Behavior rule name is required.");
    }
    if (label.length > CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS) {
      throw new Error(`Behavior rule name must be ${CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS} characters or less.`);
    }
    if (!instructions) {
      throw new Error("Behavior rule instructions are required.");
    }
    if (instructions.length > CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS) {
      throw new Error(`Behavior rule instructions must be ${CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS} characters or less.`);
    }

    const rules = stored.chatBehaviorRules ?? [];
    const now = new Date().toISOString();
    const existing = update.id ? rules.find((rule) => rule.id === update.id) : undefined;
    if (existing) {
      stored.chatBehaviorRules = rules.map((rule) =>
        rule.id === existing.id
          ? {
              ...rule,
              label,
              instructions,
              version: rule.version + 1,
              updatedAt: now
            }
          : rule
      );
    } else {
      const baseId = behaviorRuleIdFromLabel(label);
      let id = baseId;
      let suffix = 2;
      while (rules.some((rule) => rule.id === id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      stored.chatBehaviorRules = [
        ...rules,
        {
          id,
          label,
          instructions,
          version: 1,
          updatedAt: now
        }
      ];
    }

    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }

  async deleteChatBehaviorRuleConfig(id: string): Promise<AppSettings> {
    const stored = await this.settings.settingsStore.readStored();
    const normalized = id.trim();
    stored.chatBehaviorRules = (stored.chatBehaviorRules ?? []).filter((rule) => rule.id !== normalized);
    stored.chatParticipantConfigs = (stored.chatParticipantConfigs ?? []).map((participant) => ({
      ...participant,
      behaviorRuleIds: normalizeBehaviorRuleIds(participant.behaviorRuleIds).filter((ruleId) => ruleId !== normalized)
    }));
    await this.settings.settingsStore.writeStored(stored);
    return this.settings.publicSettings.getPublicSettings();
  }
}
