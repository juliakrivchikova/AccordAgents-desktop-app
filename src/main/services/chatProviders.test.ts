import assert from "node:assert/strict";
import test from "node:test";
import { chatProviderKind, preferredChatProviderSetting } from "../../shared/chatProviders";

test("preferredChatProviderSetting selects Gemini when it is the only enabled chat provider", () => {
  const provider = preferredChatProviderSetting([
    { kind: "codex-cli", label: "Codex CLI", enabled: false },
    { kind: "claude-code", label: "Claude Code", enabled: false },
    { kind: "gemini-cli", label: "Gemini CLI", enabled: true, model: "gemini-model" }
  ]);
  assert.equal(provider?.kind, "gemini-cli");
  assert.equal(provider?.model, "gemini-model");
});

test("chatProviderKind preserves Gemini across settings normalization", () => {
  assert.equal(chatProviderKind("gemini-cli", "codex-cli"), "gemini-cli");
  assert.equal(chatProviderKind("openai", "gemini-cli"), "gemini-cli");
});
