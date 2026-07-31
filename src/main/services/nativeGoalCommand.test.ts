import assert from "node:assert/strict";
import test from "node:test";

import { nativeGoalObjective, parseNativeGoalCommand } from "../../shared/nativeGoalCommand";

test("parseNativeGoalCommand accepts leading and trailing native goal commands", () => {
  assert.deepEqual(parseNativeGoalCommand("/goal finish the implementation"), {
    kind: "valid",
    contentWithoutCommand: "finish the implementation"
  });
  assert.deepEqual(parseNativeGoalCommand("@drew /goal finish the implementation"), {
    kind: "valid",
    contentWithoutCommand: "@drew finish the implementation"
  });
  assert.deepEqual(parseNativeGoalCommand("finish the implementation /goal"), {
    kind: "valid",
    contentWithoutCommand: "finish the implementation"
  });
});

test("parseNativeGoalCommand ignores inline and fenced code", () => {
  assert.deepEqual(parseNativeGoalCommand("Explain `/goal` without activating it."), { kind: "none" });
  assert.deepEqual(parseNativeGoalCommand("```text\n/goal do not run\n```"), { kind: "none" });
});

test("parseNativeGoalCommand rejects empty edge commands but keeps repeated and middle tokens as prose", () => {
  assert.match(parseError("/goal"), /Add a goal/);
  assert.match(parseError("@drew /goal"), /Add a goal/);
  assert.deepEqual(parseNativeGoalCommand("/goal first /goal"), { kind: "none" });
  assert.deepEqual(parseNativeGoalCommand("finish /goal this task"), { kind: "none" });
});

test("parseNativeGoalCommand keeps non-command substrings as ordinary text", () => {
  assert.deepEqual(parseNativeGoalCommand("Review /goalkeeper behavior."), { kind: "none" });
  assert.deepEqual(parseNativeGoalCommand("See https://example.test/goal docs."), { kind: "none" });
});

test("nativeGoalObjective removes only the resolved routing mention", () => {
  assert.equal(nativeGoalObjective("@drew finish with @taylor's review", "drew"), "finish with @taylor's review");
  assert.equal(nativeGoalObjective("finish with @drewish", "drew"), "finish with @drewish");
  assert.equal(nativeGoalObjective("finish without an explicit mention", "drew"), "finish without an explicit mention");
});

function parseError(content: string): string {
  const parsed = parseNativeGoalCommand(content);
  assert.equal(parsed.kind, "invalid");
  return parsed.kind === "invalid" ? parsed.error : "";
}
