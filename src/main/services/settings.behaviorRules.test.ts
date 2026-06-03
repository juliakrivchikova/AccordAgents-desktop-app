import assert from "node:assert/strict";
import test from "node:test";
import { SettingsService } from "./settings";

test("behavior rule IDs include entropy so deleted rules cannot be reattached by label reuse", () => {
  const service = Object.create(SettingsService.prototype) as Record<string, (label: string) => string>;

  const first = service.behaviorRuleIdFromLabel("Be concise");
  const second = service.behaviorRuleIdFromLabel("Be concise");

  assert.match(first, /^be-concise-[0-9a-f-]{36}$/);
  assert.match(second, /^be-concise-[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});
