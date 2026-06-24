import assert from "node:assert/strict";
import test from "node:test";
import { matchingChatSavedPrompts } from "../../shared/chatSavedPrompts";
import {
  slashSuggestionAtIndex,
  slashSuggestionCount
} from "../../shared/slashSuggestions";
import type { ChatSavedPromptConfig } from "../../shared/types";

test("slashSuggestionAtIndex uses command, prompt, skill ordering", () => {
  const command = { id: "compact", label: "Compact", description: "Summarize context" };
  const prompt = { id: "prompt-1", trigger: "bug", label: "Bug report" };
  const skill = { skillId: "skill-1", displayName: "Office hours" };
  const groups = {
    commands: [command],
    prompts: [prompt],
    skills: [skill]
  };

  assert.equal(slashSuggestionCount(groups), 3);
  assert.deepEqual(slashSuggestionAtIndex(groups, 0), { kind: "command", item: command });
  assert.deepEqual(slashSuggestionAtIndex(groups, 1), { kind: "prompt", item: prompt });
  assert.deepEqual(slashSuggestionAtIndex(groups, 2), { kind: "skill", item: skill });
  assert.equal(slashSuggestionAtIndex(groups, -1), undefined);
  assert.equal(slashSuggestionAtIndex(groups, 3), undefined);
});

test("matchingChatSavedPrompts ranks exact and prefix trigger matches before broad trigger or label matches", () => {
  const prompts: ChatSavedPromptConfig[] = [
    savedPrompt({ id: "body", label: "General note", trigger: "note", body: "bug investigation" }),
    savedPrompt({ id: "label", label: "Bug report", trigger: "report" }),
    savedPrompt({ id: "prefix", label: "Steps", trigger: "bug-repro" }),
    savedPrompt({ id: "exact", label: "Bug", trigger: "bug" })
  ];

  assert.deepEqual(
    matchingChatSavedPrompts(prompts, "bug").map((prompt) => prompt.id),
    ["exact", "prefix", "label"]
  );
});

test("matchingChatSavedPrompts can include body matches outside the composer picker", () => {
  const prompts: ChatSavedPromptConfig[] = [
    savedPrompt({ id: "body", label: "General note", trigger: "note", body: "bug investigation" }),
    savedPrompt({ id: "exact", label: "Bug", trigger: "bug" })
  ];

  assert.deepEqual(
    matchingChatSavedPrompts(prompts, "bug", { includeBody: true }).map((prompt) => prompt.id),
    ["exact", "body"]
  );
});

function savedPrompt(overrides: Partial<ChatSavedPromptConfig> = {}): ChatSavedPromptConfig {
  return {
    id: "saved-prompt",
    label: "Saved prompt",
    trigger: "saved",
    body: "Prompt body",
    version: 1,
    updatedAt: "2026-06-24T00:00:00.000Z",
    ...overrides
  };
}
