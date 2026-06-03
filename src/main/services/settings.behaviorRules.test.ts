import assert from "node:assert/strict";
import test from "node:test";
import { SettingsService } from "./settings";
import {
  CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS,
  CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS
} from "../../shared/chatBehaviorRules";

test("behavior rule IDs include entropy so deleted rules cannot be reattached by label reuse", () => {
  const service = Object.create(SettingsService.prototype) as Record<string, (label: string) => string>;

  const first = service.behaviorRuleIdFromLabel("Be concise");
  const second = service.behaviorRuleIdFromLabel("Be concise");

  assert.match(first, /^be-concise-[0-9a-f-]{36}$/);
  assert.match(second, /^be-concise-[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test("saveChatBehaviorRuleConfig rejects oversized behavior rules", async () => {
  const service = Object.create(SettingsService.prototype) as any;
  let wroteSettings = false;
  service.readStored = async () => ({
    settingsVersion: 1,
    roundLimitDefault: 1,
    providers: [],
    chatRoleConfigs: [],
    chatBehaviorRules: [],
    chatParticipantConfigs: []
  });
  service.writeStored = async () => {
    wroteSettings = true;
  };
  service.getPublicSettings = async () => ({
    roundLimitDefault: 1,
    providers: [],
    chatRoleConfigs: [],
    chatBehaviorRules: [],
    chatParticipantConfigs: []
  });

  await assert.rejects(
    () => service.saveChatBehaviorRuleConfig({
      label: "x".repeat(CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS + 1),
      instructions: "Keep replies short."
    }),
    new RegExp(`${CHAT_BEHAVIOR_RULE_LABEL_MAX_CHARS} characters or less`)
  );
  await assert.rejects(
    () => service.saveChatBehaviorRuleConfig({
      label: "Be concise",
      instructions: "x".repeat(CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS + 1)
    }),
    new RegExp(`${CHAT_BEHAVIOR_RULE_INSTRUCTIONS_MAX_CHARS} characters or less`)
  );
  assert.equal(wroteSettings, false);
});
