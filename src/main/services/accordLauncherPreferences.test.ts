import assert from "node:assert/strict";
import test from "node:test";
import {
  nextAccordSubjectHistory,
  normalizeAccordLauncherPreferences,
  normalizeAccordSubjectHistory,
  parseAccordLauncherPreferencesJson,
  preferredAccordFacilitator,
  reconcileAccordTargetIds
} from "../../shared/accordLauncherPreferences";

test("accord launcher preferences default malformed or invalid payloads", () => {
  assert.deepEqual(parseAccordLauncherPreferencesJson("{"), { subjects: [] });
  assert.deepEqual(normalizeAccordLauncherPreferences(undefined), { subjects: [] });
  assert.deepEqual(normalizeAccordLauncherPreferences(["subject"]), { subjects: [] });
  assert.deepEqual(normalizeAccordLauncherPreferences({ subjects: "not-an-array" }), { subjects: [] });
});

test("accord launcher preferences normalize facilitator identity", () => {
  assert.deepEqual(normalizeAccordLauncherPreferences({
    lastFacilitatorParticipantId: " participant-1 ",
    lastFacilitatorHandle: " @Drew ",
    subjects: []
  }), {
    lastFacilitatorParticipantId: "participant-1",
    lastFacilitatorHandle: "drew",
    subjects: []
  });
});

test("accord subject history trims, drops empty values, dedupes, and caps at five", () => {
  assert.deepEqual(normalizeAccordSubjectHistory([
    "  First subject  ",
    "",
    "second   subject",
    "FIRST SUBJECT",
    "Third",
    "Fourth",
    "Fifth",
    "Sixth"
  ]), [
    "First subject",
    "second   subject",
    "Third",
    "Fourth",
    "Fifth"
  ]);
});

test("nextAccordSubjectHistory promotes resubmitted subjects to newest", () => {
  assert.deepEqual(
    nextAccordSubjectHistory(["One", "Two  words", "Three"], " two words "),
    ["two words", "One", "Three"]
  );
});

test("nextAccordSubjectHistory ignores empty new subjects without losing normalization", () => {
  assert.deepEqual(
    nextAccordSubjectHistory([" One ", "one", "Two"], "   "),
    ["One", "Two"]
  );
});

test("preferredAccordFacilitator resolves id, then handle, then first participant", () => {
  const participants = [
    { id: "first", handle: "casey" },
    { id: "second", handle: "drew" },
    { id: "third", handle: "taylor" }
  ];
  assert.equal(preferredAccordFacilitator(participants, {
    lastFacilitatorParticipantId: "third",
    lastFacilitatorHandle: "drew",
    subjects: []
  })?.id, "third");
  assert.equal(preferredAccordFacilitator(participants, {
    lastFacilitatorParticipantId: "missing",
    lastFacilitatorHandle: "@DREW",
    subjects: []
  })?.id, "second");
  assert.equal(preferredAccordFacilitator(participants, { subjects: [] })?.id, "first");
});

test("reconcileAccordTargetIds preserves deliberately empty target selection", () => {
  const participants = [
    { id: "facilitator" },
    { id: "target" }
  ];
  assert.deepEqual(reconcileAccordTargetIds([], "target", participants), []);
});

test("reconcileAccordTargetIds auto-fills when selected target becomes facilitator", () => {
  const participants = [
    { id: "codex" },
    { id: "claude" },
    { id: "taylor" }
  ];
  assert.deepEqual(reconcileAccordTargetIds(["taylor"], "taylor", participants), ["codex", "claude"]);
  assert.deepEqual(reconcileAccordTargetIds(["claude", "taylor"], "taylor", participants), ["claude"]);
});
