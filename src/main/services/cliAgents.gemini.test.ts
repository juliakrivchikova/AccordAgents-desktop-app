import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ParticipantConfig } from "../../shared/types";
import {
  buildGeminiExecInvocation,
  extractGeminiLogConversationId,
  geminiTranscriptPathForConversation,
  isGeminiResumeMissText,
  parseGeminiExecResult,
  parseGeminiTranscriptActivity
} from "./geminiExec";

const participant = {
  id: "participant-gemini",
  label: "Gera",
  kind: "gemini-cli",
  model: "Gemini 3.5 Flash (Medium)"
} as unknown as ParticipantConfig;

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// Captured verbatim from a real `agy --print --output-format json` run (agy 1.1.1).
const REAL_SUCCESS_RESULT_LINE =
  "{\"conversation_id\":\"cb037093-d447-437f-ba0d-19a24a4a87f4\",\"status\":\"SUCCESS\",\"response\":\"Hello! I'm Antigravity, your AI coding assistant. \\n\\nHow can I help you today?\\n\",\"duration_seconds\":3.175147,\"num_turns\":1,\"usage\":{\"input_tokens\":16974,\"output_tokens\":245,\"thinking_tokens\":191,\"total_tokens\":17219}}";

test("buildGeminiExecInvocation: new chat run is read-only sandboxed with catalog model and log file", () => {
  const invocation = buildGeminiExecInvocation({
    participant,
    prompt: "Say hi",
    repoPath: "/repo/project",
    kind: "chat",
    logFilePath: "/tmp/run/run.log",
    options: {
      extraReadableDirs: ["/extra/history"],
      timeoutMs: 120_000
    }
  });
  assert.equal(invocation.args.includes("--conversation"), false);
  assert.equal(flagValue(invocation.args, "--output-format"), "json");
  assert.equal(flagValue(invocation.args, "--log-file"), "/tmp/run/run.log");
  assert.equal(flagValue(invocation.args, "--model"), "Gemini 3.5 Flash (Medium)");
  assert.equal(invocation.args.includes("--sandbox"), true);
  assert.equal(invocation.args.includes("--dangerously-skip-permissions"), false);
  const addDirIndexes = invocation.args
    .map((arg, index) => (arg === "--add-dir" ? invocation.args[index + 1] : undefined))
    .filter((value): value is string => Boolean(value));
  assert.deepEqual(addDirIndexes, ["/repo/project", "/extra/history"]);
  const printPrompt = flagValue(invocation.args, "--print");
  assert.ok(printPrompt?.includes("Say hi"));
  assert.ok(printPrompt?.includes("AccordAgents Chat in default mode"));
  assert.ok(printPrompt?.includes("read-only"));
  // agy's own print deadline stays behind the app-side timeout.
  assert.equal(flagValue(invocation.args, "--print-timeout"), "180s");
});

test("buildGeminiExecInvocation: resume passes --conversation and keeps the configured model off argv", () => {
  const invocation = buildGeminiExecInvocation({
    participant,
    prompt: "Continue",
    repoPath: "/repo/project",
    kind: "chat",
    options: { sessionId: "11111111-2222-4333-8444-555555555555" }
  });
  assert.equal(flagValue(invocation.args, "--conversation"), "11111111-2222-4333-8444-555555555555");
  assert.equal(invocation.args.includes("--model"), false);
});

test("buildGeminiExecInvocation: auto mode and granted write skip tool confirmations", () => {
  const auto = buildGeminiExecInvocation({
    participant,
    prompt: "Do work",
    repoPath: "/repo/project",
    kind: "chat",
    options: { agentMode: "auto" }
  });
  assert.equal(auto.args.includes("--dangerously-skip-permissions"), true);
  assert.equal(auto.args.includes("--sandbox"), false);

  const write = buildGeminiExecInvocation({
    participant,
    prompt: "Do work",
    repoPath: "/repo/project",
    kind: "chat",
    options: {
      agentMode: "default",
      permissions: {
        repoRead: true,
        workspaceWrite: true,
        webAccess: false,
        requestParticipants: "ask",
        shell: { enabled: false, rules: [] }
      }
    }
  });
  assert.equal(write.args.includes("--dangerously-skip-permissions"), true);
});

test("buildGeminiExecInvocation: app MCP url/token travel through the process environment", () => {
  const invocation = buildGeminiExecInvocation({
    participant,
    prompt: "Hi",
    kind: "chat",
    options: {
      appMcp: { url: "http://127.0.0.1:5123/mcp", token: "secret-token" }
    }
  });
  assert.equal(invocation.env?.ACCORD_AGENTS_MCP_URL, "http://127.0.0.1:5123/mcp");
  assert.equal(invocation.env?.ACCORD_AGENTS_MCP_TOKEN, "secret-token");
});

test("parseGeminiExecResult: parses the real success payload including usage", () => {
  const parsed = parseGeminiExecResult(`Some CLI banner\n${REAL_SUCCESS_RESULT_LINE}\n`);
  assert.ok(parsed);
  assert.equal(parsed?.conversationId, "cb037093-d447-437f-ba0d-19a24a4a87f4");
  assert.equal(parsed?.status, "SUCCESS");
  assert.ok(parsed?.response?.startsWith("Hello! I'm Antigravity"));
  assert.equal(parsed?.usage?.inputTokens, 16974);
  assert.equal(parsed?.usage?.outputTokens, 245);
  assert.equal(parsed?.usage?.thinkingTokens, 191);
  assert.equal(parsed?.usage?.totalTokens, 17219);
});

test("parseGeminiExecResult: keeps error payloads and ignores non-result noise", () => {
  const parsed = parseGeminiExecResult([
    "{\"unrelated\":true}",
    "{\"conversation_id\":\"cb037093-d447-437f-ba0d-19a24a4a87f4\",\"status\":\"ERROR\",\"error\":\"The model produced an invalid tool call.\",\"response\":\"Partial answer.\"}"
  ].join("\n"));
  assert.equal(parsed?.status, "ERROR");
  assert.equal(parsed?.error, "The model produced an invalid tool call.");
  assert.equal(parsed?.response, "Partial answer.");
  assert.equal(parseGeminiExecResult("plain text only\nno json here"), undefined);
});

test("isGeminiResumeMissText: matches lost-conversation phrasing only", () => {
  assert.equal(isGeminiResumeMissText("conversation cb037093 not found"), true);
  assert.equal(isGeminiResumeMissText("No such conversation exists"), true);
  assert.equal(isGeminiResumeMissText("unknown conversation id"), true);
  assert.equal(isGeminiResumeMissText("Individual quota reached. Please upgrade your subscription."), false);
});

test("extractGeminiLogConversationId: reads real glog print-mode lines", () => {
  const sendLine = "I0711 14:33:59.660948 98520 printmode.go:191] Print mode: conversation=C15CFA0B-424A-4A82-88D2-2D584ABFD81F, sending message";
  const resumeLine = "I0711 13:36:27.100000 98520 printmode.go:181] Print mode: resuming conversation cd590344-1d86-4c03-a74a-37893d8274f2";
  const exitLine = "I0711 14:34:01.502673 98520 server.go:910] Stream goroutine exited for c15cfa0b-424a-4a82-88d2-2d584abfd81f, sending completion signal";
  assert.equal(extractGeminiLogConversationId(sendLine), "c15cfa0b-424a-4a82-88d2-2d584abfd81f");
  assert.equal(extractGeminiLogConversationId(resumeLine), "cd590344-1d86-4c03-a74a-37893d8274f2");
  assert.equal(extractGeminiLogConversationId(exitLine), "c15cfa0b-424a-4a82-88d2-2d584abfd81f");
  assert.equal(extractGeminiLogConversationId("I0711 quota_manager.go:72] quotaRefreshLoop: starting reload"), undefined);
});

test("parseGeminiTranscriptActivity: maps executed steps and skips narration", () => {
  const runCommand = "{\"step_index\":7,\"source\":\"MODEL\",\"type\":\"RUN_COMMAND\",\"status\":\"DONE\",\"created_at\":\"2026-07-11T10:46:03Z\"}";
  const viewFile = "{\"step_index\":3,\"type\":\"VIEW_FILE\",\"status\":\"DONE\"}";
  const searchWeb = "{\"step_index\":9,\"type\":\"SEARCH_WEB\",\"status\":\"DONE\"}";
  const planner = "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"content\":\"I will check the file.\",\"tool_calls\":[{\"name\":\"view_file\"}]}";
  assert.deepEqual(parseGeminiTranscriptActivity(runCommand), { label: "Running command", kind: "command" });
  assert.deepEqual(parseGeminiTranscriptActivity(viewFile), { label: "Reading file", kind: "tool" });
  assert.deepEqual(parseGeminiTranscriptActivity(searchWeb), { label: "Using web search", kind: "web" });
  assert.equal(parseGeminiTranscriptActivity(planner), undefined);
  assert.equal(parseGeminiTranscriptActivity("{\"type\":\"USER_INPUT\"}"), undefined);
  assert.equal(parseGeminiTranscriptActivity("not json"), undefined);
});

test("geminiTranscriptPathForConversation: points into the Antigravity brain", () => {
  const transcript = geminiTranscriptPathForConversation("/home/user", "abc-123");
  assert.equal(
    transcript,
    path.join("/home/user", ".gemini", "antigravity-cli", "brain", "abc-123", ".system_generated", "logs", "transcript.jsonl")
  );
});
