import { randomUUID } from "node:crypto";
import type { ChatBehaviorRuleConfig, ChatSavedPromptConfig } from "../../../../shared/types";
import {
  CHAT_SAVED_PROMPT_BODY_MAX_CHARS, CHAT_SAVED_PROMPT_LABEL_MAX_CHARS, CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS,
  isValidChatSavedPromptTrigger, normalizeChatSavedPromptTrigger
} from "../../../../shared/chatSavedPrompts";

export function normalizeBehaviorRules(rules: ChatBehaviorRuleConfig[] | undefined): ChatBehaviorRuleConfig[] {
  const seen = new Set<string>();
  return (Array.isArray(rules) ? rules : [])
    .filter((rule): rule is ChatBehaviorRuleConfig => {
      const id = typeof rule.id === "string" ? rule.id.trim() : "";
      const label = typeof rule.label === "string" ? rule.label.trim() : "";
      const instructions = typeof rule.instructions === "string" ? rule.instructions.trim() : "";
      if (!id || !label || !instructions || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    })
    .map((rule) => ({
      id: rule.id.trim(),
      label: rule.label.trim(),
      instructions: rule.instructions.trim(),
      version: Number.isFinite(rule.version) && rule.version > 0 ? Math.floor(rule.version) : 1,
      updatedAt: rule.updatedAt || new Date().toISOString()
    }));
}

export function normalizeSavedPrompts(prompts: ChatSavedPromptConfig[] | undefined): ChatSavedPromptConfig[] {
  const seenIds = new Set<string>();
  const seenTriggers = new Set<string>();
  return (Array.isArray(prompts) ? prompts : [])
    .filter((prompt): prompt is ChatSavedPromptConfig => {
      const id = typeof prompt.id === "string" ? prompt.id.trim() : "";
      const label = typeof prompt.label === "string" ? prompt.label.trim() : "";
      const trigger = typeof prompt.trigger === "string" ? normalizeChatSavedPromptTrigger(prompt.trigger) : "";
      const body = typeof prompt.body === "string" ? prompt.body.trim() : "";
      const normalizedTrigger = trigger.toLowerCase();
      if (
        !id ||
        !label ||
        !isValidChatSavedPromptTrigger(trigger) ||
        !body ||
        seenIds.has(id) ||
        seenTriggers.has(normalizedTrigger)
      ) {
        return false;
      }
      seenIds.add(id);
      seenTriggers.add(normalizedTrigger);
      return true;
    })
    .map((prompt) => ({
      id: prompt.id.trim(),
      label: prompt.label.trim().slice(0, CHAT_SAVED_PROMPT_LABEL_MAX_CHARS),
      trigger: normalizeChatSavedPromptTrigger(prompt.trigger).slice(0, CHAT_SAVED_PROMPT_TRIGGER_MAX_CHARS),
      body: prompt.body.trim().slice(0, CHAT_SAVED_PROMPT_BODY_MAX_CHARS),
      version: Number.isFinite(prompt.version) && prompt.version > 0 ? Math.floor(prompt.version) : 1,
      updatedAt: prompt.updatedAt || new Date().toISOString()
    }));
}

export function normalizeBehaviorRuleIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const id = item.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function behaviorRuleIdFromLabel(label: string): string {
  const slug = (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "behavior-rule"
  );
  return (
    `${slug}-${randomUUID()}`
  );
}

export function savedPromptIdFromLabel(label: string): string {
  const slug = (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "saved-prompt"
  );
  return `${slug}-${randomUUID()}`;
}
