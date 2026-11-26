import assert from "node:assert/strict";
import test from "node:test";
import { matchingChatSavedPrompts } from "../../shared/chatSavedPrompts";
import type { ChatSavedPromptConfig } from "../../shared/types";

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
