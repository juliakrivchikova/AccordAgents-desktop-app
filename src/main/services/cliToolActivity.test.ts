import assert from "node:assert/strict";
import test from "node:test";
import { claudeRunningTitle } from "./claudeRunningTitle";
import {
  CLAUDE_TOOLS_WITHOUT_ROW,
  CLI_ACTIVITY_DETAIL_MAX_CHARS,
  CLI_ACTIVITY_LABEL_MAX_CHARS,
  claudeToolActivity,
  cliTruncate,
  codexCommandActivity,
  codexDisplayCommand,
  codexFileChangeActivity,
  codexMcpActivity,
  codexWebSearchActivity,
  mcpServerToolPrefix
} from "./cliToolActivity";
import { phoneSessionsActivity, sessionsActivityRow } from "../../shared/sessionsActivity";

const CWD = "/private/tmp/sandbox";

// Lines quoted below were captured from Claude Code 2.1.330 and Codex 0.155.1
// running interactively (2026-11-22).

test("a Claude shell command without a description reads as the CLI's running line, cut at 50 characters", () => {
  assert.deepEqual(claudeToolActivity("Bash", { command: "sleep 8; echo one" }, { cwd: CWD }), {
    label: "Running sleep 8; echo one",
    kind: "command",
    detail: "sleep 8; echo one"
  });
  const long = `sleep 4 && for f in a.ts b.md lib/util.ts lib/readme.md; do wc -l "$f"; done && echo "${"word ".repeat(60)}"`;
  assert.equal(claudeToolActivity("Bash", { command: long }).label, "Running sleep 4 && for f in a.ts b.md lib/util.ts lib/rea…");
  const multiline = "sleep 3\necho line-2\necho line-3\necho line-4\necho line-5\necho line-6";
  assert.equal(claudeToolActivity("Bash", { command: multiline }).label, "Running sleep 3 echo line-2 echo line-3 echo line-4 echo line…");
  assert.equal(claudeToolActivity("Bash", { command: multiline }).detail, multiline, "the row opens to the whole command");
});

test("a Claude shell command's description is its title in the -ing form the CLI gives it", () => {
  assert.equal(claudeToolActivity("Bash", { command: "for i in 1 2 3; do echo $i; done", description: "Run loop, list files, print long line" }).label,
    "Running loop, listing files, printing long line");
  assert.equal(claudeToolActivity("Bash", { command: "git status --short", description: "Show short git status" }).label, "Showing short git status");
  assert.equal(claudeToolActivity("Bash", { command: "git status", description: "Git status of the repo" }).label, "Git status of the repo",
    "a description that does not start with a verb the CLI knows is shown as written");
});

test("Claude Code's -ing rule: known verbs, later clauses, doubling, prefixes, and what it leaves alone", () => {
  assert.equal(claudeRunningTitle("Run tests and then commit"), "Running tests and then committing");
  assert.equal(claudeRunningTitle("Install deps, then build"), "Installing deps, then building");
  assert.equal(claudeRunningTitle("Stop server"), "Stopping server");
  assert.equal(claudeRunningTitle("Create file"), "Creating file");
  assert.equal(claudeRunningTitle("Re-run the build"), "Re-running the build");
  assert.equal(claudeRunningTitle("Check that test passes"), "Checking that test passes");
  assert.equal(claudeRunningTitle("Count files, check passes"), "Counting files, check passes", "a later word followed by a verb is a subject, left alone");
  assert.equal(claudeRunningTitle("Ran tests"), undefined);
  assert.equal(claudeRunningTitle("npm test"), undefined);
});

test("Claude reads, searches and MCP calls: the CLI's words, paths relative to the session's folder", () => {
  assert.deepEqual(claudeToolActivity("Read", { file_path: `${CWD}/src/a.ts` }, { cwd: CWD }), { label: "Reading src/a.ts", kind: "tool" });
  assert.equal(claudeToolActivity("Read", { file_path: "/etc/hosts" }, { cwd: CWD }).label, "Reading /etc/hosts");
  assert.equal(claudeToolActivity("Grep", { pattern: "export function", path: "src" }).label, "Searching for export function");
  assert.equal(claudeToolActivity("Glob", { pattern: "**/*.md" }).label, "Finding **/*.md");
  assert.equal(claudeToolActivity("Edit", { file_path: `${CWD}/a.ts`, old_string: "a", new_string: "b" }, { cwd: CWD }).label, "Update(a.ts)");
  assert.equal(claudeToolActivity("Write", { file_path: `${CWD}/c.txt`, content: "hello" }, { cwd: CWD }).label, "Write(c.txt)");
  assert.equal(claudeToolActivity("WebFetch", { url: "https://example.com", prompt: "title?" }).label, "Fetch(https://example.com)");
  assert.equal(claudeToolActivity("WebSearch", { query: "codex cli" }).label, 'Web Search("codex cli")');
  assert.equal(claudeToolActivity("Agent", { description: "Count lines of a.ts", prompt: "count" }).label, "Agent(Count lines of a.ts)");
  const names = new Map([[mcpServerToolPrefix("claude.ai Context7"), "claude.ai Context7"]]);
  assert.equal(mcpServerToolPrefix("claude.ai Context7"), "claude_ai_Context7");
  assert.deepEqual(claudeToolActivity("mcp__claude_ai_Context7__resolve-library-id", { libraryName: "react" }, { mcpServerNames: names }), {
    label: "claude.ai Context7 - resolve-library-id (MCP)",
    kind: "tool",
    detail: "{\"libraryName\":\"react\"}"
  });
  assert.equal(claudeToolActivity("mcp__accord_agents__app_chat_get_context", {}).label, "accord_agents - app_chat_get_context (MCP)");
  assert.equal(claudeToolActivity("ToolSearch", { query: "select:x" }).label, "ToolSearch", "a tool the app knows no words for is named as the CLI names it");
});

test("a step keeps its arguments compact, and none of a body the app keeps itself (size check)", () => {
  const todos = { todos: [{ content: "Fix the login", status: "pending", activeForm: "Fixing the login" }] };
  assert.equal(claudeToolActivity("TodoWrite", todos).detail, JSON.stringify(todos), "compact JSON, no indentation");
  const post = "word ".repeat(400);
  assert.equal(claudeToolActivity("mcp__accord_agents__app_chat_send_message", { content: post }).detail, undefined,
    "a message the chat already shows is not kept again with the step");
  assert.equal(claudeToolActivity("mcp__accord_agents__app_chat_request_participants", { requests: [{ target: "drew", prompt: post }] }).detail, undefined,
    "nor a request its card keeps");
  assert.equal(claudeToolActivity("mcp__accord_agents__app_chat_read_messages", { limit: 60 }).detail, '{"limit":60}', "short arguments stay");
  assert.equal(claudeToolActivity("mcp__other__send", { content: post }).detail?.startsWith('{"content":"word word'), true, "another server's arguments stay");
  assert.equal(codexMcpActivity("accord_agents", "app_chat_send_message", { content: post }, true).detail, undefined);
  assert.equal(codexMcpActivity("context7", "query-docs", { query: "react" }, true).detail, '{"query":"react"}');
});

test("ExitPlanMode and EnterPlanMode get no row: the CLI draws nothing at the call; the plan card is its dialog", () => {
  assert.equal(CLAUDE_TOOLS_WITHOUT_ROW.has("ExitPlanMode"), true);
  assert.equal(CLAUDE_TOOLS_WITHOUT_ROW.has("EnterPlanMode"), true);
  assert.equal(CLAUDE_TOOLS_WITHOUT_ROW.has("Bash"), false);
});

test("a row stays one bounded line and its detail is capped, however big the call (size check)", () => {
  const huge = `cat > big.txt <<'EOF'\n${"x".repeat(200_000)}\nEOF`;
  const row = claudeToolActivity("Bash", { command: huge, description: "Write a big file ".repeat(40) });
  assert.ok(row.label.length <= CLI_ACTIVITY_LABEL_MAX_CHARS);
  assert.ok(!row.label.includes("\n"));
  assert.ok((row.detail ?? "").length <= CLI_ACTIVITY_DETAIL_MAX_CHARS);
  assert.match(row.detail ?? "", /chars omitted\]$/);
  const mcp = claudeToolActivity("mcp__s__t", { blob: "y".repeat(100_000) });
  assert.ok((mcp.detail ?? "").length <= CLI_ACTIVITY_DETAIL_MAX_CHARS);
  assert.equal(cliTruncate("a\n\n b", 50), "a b");
});

test("Codex commands read as its TUI: Running, then Ran; reading and searching as Read/Search/List", () => {
  assert.equal(codexCommandActivity("sleep 5; echo one", undefined, false).label, "Running sleep 5; echo one");
  assert.equal(codexCommandActivity("sleep 5; echo one", undefined, true).label, "Ran sleep 5; echo one");
  assert.equal(codexCommandActivity("/bin/zsh -lc 'git status --short'", undefined, true).label, "Ran git status --short");
  assert.equal(codexDisplayCommand("bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(codexCommandActivity("cat a.ts", [{ type: "read", command: "cat a.ts", name: "a.ts", path: "/x/a.ts" }], true).label, "Read a.ts");
  assert.equal(codexCommandActivity("rg TODO", [{ type: "search", command: "rg TODO", query: "TODO", path: null }], false).label, "Search TODO");
  assert.equal(codexCommandActivity("rg --files -g '*.md'", [{ type: "listFiles", command: "rg --files -g '*.md'", path: null }], true).label, "List rg --files -g '*.md'");
  assert.equal(codexCommandActivity("cat a.ts | wc -l", [{ type: "read", command: "cat a.ts", name: "a.ts" }, { type: "unknown", command: "wc -l" }], true).label,
    "Ran cat a.ts | wc -l", "a command that does more than read is a command");
});

test("Codex MCP calls, web searches and edits read as its TUI", () => {
  assert.equal(codexMcpActivity("context7", "resolve-library-id", { libraryName: "react", query: "React" }, true).label,
    'Called context7.resolve-library-id({"libraryName":"react","query":"React"})');
  assert.equal(codexMcpActivity("accord_agents", "app_chat_get_context", {}, false).label, "Calling accord_agents.app_chat_get_context({})");
  assert.equal(codexWebSearchActivity(undefined, false).label, "Searching the web");
  assert.equal(codexWebSearchActivity("example.com IANA reserved domain", true).label, "Searched the web for example.com IANA reserved domain");
  const diff = "@@ -24 +24 @@\n-export const VERSION = \"1.0.0\";\n+export const VERSION = \"1.0.1\";\n";
  assert.equal(codexFileChangeActivity([{ path: "/repo/a.ts", kind: "update", diff }], "/repo", undefined).label, "Edited a.ts (+1 -1)");
  assert.equal(codexFileChangeActivity([{ path: "/repo/d.txt", kind: "add", diff: "+hello\n" }], "/repo", undefined).label, "Added d.txt (+1 -0)");
  assert.equal(codexFileChangeActivity([{ path: "/repo/old.ts", kind: "delete" }], "/repo", undefined).label, "Deleted old.ts");
  assert.equal(codexFileChangeActivity([{ path: "a.ts", kind: "update", diff }, { path: "b.ts", kind: "update", diff }], undefined, undefined).label, "Edited 2 files (+2 -2)");
  assert.equal(codexFileChangeActivity([{ path: "a.ts", kind: "update" }], undefined, undefined).label, "Edited a.ts", "no diff, no counts");
});

test("a row says the CLI's words; a stored row with only the app's old word says its detail", () => {
  assert.deepEqual(sessionsActivityRow({ kind: "command", label: "Running sleep 8; echo one", detail: "sleep 8; echo one" }), { kind: "shell", text: "Running sleep 8; echo one" });
  assert.deepEqual(sessionsActivityRow({ kind: "command", label: "Running command", detail: "npm test" }), { kind: "shell", text: "npm test" });
  assert.deepEqual(sessionsActivityRow({ kind: "command", label: "Using Bash" }), { kind: "shell", text: "Using Bash" });
  assert.deepEqual(sessionsActivityRow({ kind: "tool", label: "Reading src/a.ts" }), { kind: "read", text: "Reading src/a.ts" });
  assert.deepEqual(sessionsActivityRow({ kind: "tool", label: "Read a.ts", detail: "cat a.ts" }), { kind: "read", text: "Read a.ts" });
  assert.deepEqual(sessionsActivityRow({ kind: "web", label: "Using web search", detail: "codex" }), { kind: "web", text: "codex" });
  assert.deepEqual(sessionsActivityRow({ kind: "file-edit", label: "Edited a.ts (+1 -1)", detail: "update: a.ts" }), { kind: "edit", text: "Edited a.ts (+1 -1)" });
  assert.deepEqual(sessionsActivityRow({ kind: "tool", label: "accord_agents - app_chat_get_context (MCP)", detail: "{}" }), { kind: "tool", text: "accord_agents - app_chat_get_context (MCP)" });
  const phone = phoneSessionsActivity([{ kind: "command", label: `Running ${"x".repeat(300)}`, detail: "x" }]);
  assert.ok((phone?.activity[0].text.length ?? 0) <= 120, "the phone's row stays short");
});

test("codex exec --json items become rows in the TUI's words, finished ones marked completed", async () => {
  const { emitCodexLiveOutput } = await import("./codexExec");
  const events: Array<{ text: string; activityKind?: string; activityStatus?: string; activityItemId?: string; activityDetail?: string }> = [];
  const emit = (line: unknown) => emitCodexLiveOutput(JSON.stringify(line), (event) => events.push(event as any));
  emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'sleep 1; echo hi'", status: "in_progress" } });
  emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc 'sleep 1; echo hi'", exit_code: 0, status: "completed" } });
  emit({ type: "item.completed", item: { id: "item_2", type: "mcp_tool_call", server: "accord_agents", tool: "app_chat_get_context", arguments: {}, status: "completed" } });
  emit({ type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "notes.md", kind: "update" }], status: "completed" } });
  emit({ type: "item.completed", item: { id: "item_4", type: "web_search", query: "codex cli" } });
  emit({ type: "item.completed", item: { id: "item_5", type: "agent_message", text: "done" } });
  assert.deepEqual(events.filter((event) => event.activityKind).map((event) => [event.activityItemId, event.text.trim(), event.activityStatus]), [
    ["item_1", "Running sleep 1; echo hi", "started"],
    ["item_1", "Ran sleep 1; echo hi", "completed"],
    ["item_2", "Called accord_agents.app_chat_get_context({})", "completed"],
    ["item_3", "Edited notes.md", "completed"],
    ["item_4", "Searched the web for codex cli", "completed"]
  ]);
  assert.equal(events[0].activityDetail, "bash -lc 'sleep 1; echo hi'");
});

test("a label with many newlines stays within its limit", () => {
  const command = Array.from({ length: 400 }, (_, index) => `echo ${index}`).join("\n");
  assert.ok(codexCommandActivity(command, undefined, true).label.length <= CLI_ACTIVITY_LABEL_MAX_CHARS);
  assert.ok(claudeToolActivity("Bash", { command, description: command }).label.length <= CLI_ACTIVITY_LABEL_MAX_CHARS);
});

test("a Codex step that failed or was declined never reads as done", () => {
  assert.equal(codexCommandActivity("rm -rf build", undefined, true, "declined").label, "Declined rm -rf build");
  assert.equal(codexCommandActivity("npm test", undefined, true, "failed").label, "Ran npm test", "a failing command still ran, as the TUI shows it");
  const diff = "@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(codexFileChangeActivity([{ path: "/repo/a.ts", kind: "update", diff }], "/repo", undefined, false).label, "Editing a.ts (+1 -1)", "proposed, not applied yet");
  assert.equal(codexFileChangeActivity([{ path: "/repo/a.ts", kind: "update", diff }], "/repo", undefined, true, "declined").label, "Declined a.ts (+1 -1)");
  assert.equal(codexFileChangeActivity([{ path: "/repo/a.ts", kind: "update", diff }], "/repo", undefined, true, "failed").label, "Editing a.ts (+1 -1)");
});

test("Codex diff counts: content lines that look like headers count, and a new file given as its content counts its lines", () => {
  const sql = "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n select 1;\n";
  assert.equal(codexFileChangeActivity([{ path: "q.sql", kind: "update", diff: sql }], undefined, undefined).label, "Edited q.sql (+1 -1)");
  assert.equal(codexFileChangeActivity([{ path: "n.md", kind: "add", diff: "# Title\n- one\n- two\n" }], undefined, undefined).label, "Added n.md (+3 -0)");
  assert.equal(codexFileChangeActivity([{ path: "n.md", kind: "add", diff: "+# Title\n+- one\n" }], undefined, undefined).label, "Added n.md (+2 -0)");
});
