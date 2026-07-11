import assert from "node:assert/strict";
import test from "node:test";
import { matchingChatSavedPrompts } from "../../shared/chatSavedPrompts";
import { rankSlashSuggestions } from "../../shared/slashSuggestions";
import type { ChatSavedPromptConfig } from "../../shared/types";

test("rankSlashSuggestions promotes primary plugin matches above skill description matches", () => {
  const groups = {
    commands: [],
    prompts: [],
    skills: [
      { name: "design-html", description: "Design and build production HTML" },
      { name: "document-release", description: "Build release documentation" }
    ],
    plugins: [
      { name: "build-macos-apps", displayName: "Build macOS Apps", description: "Build native apps" },
      { name: "build-web-apps", displayName: "Build Web Apps", description: "Build frontend apps" }
    ]
  };

  const ranked = rankSlashSuggestions(groups, "build", (selection) => ({
    primary: [selection.item.name, "displayName" in selection.item ? selection.item.displayName : ""],
    secondary: [selection.item.description]
  }));

  assert.deepEqual(ranked.map((selection) => selection.item.name), [
    "build-macos-apps",
    "build-web-apps",
    "design-html",
    "document-release"
  ]);
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
