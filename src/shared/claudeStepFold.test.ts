import assert from "node:assert/strict";
import test from "node:test";
import { claudeStepBlocks, claudeStepSummary } from "./claudeStepFold";
import type { ChatAgentActivityKind } from "./types";

const step = (kind: ChatAgentActivityKind, label: string, detail?: string) => ({ kind, label, ...(detail ? { detail } : {}) });
const shell = (label: string, command: string) => step("command", label, command);
const mcp = (tool: string) => step("tool", `accord_agents - ${tool} (MCP)`);

test("the User's own turn of 2026-11-25 reads as Claude Code shows it", () => {
  const events = [
    step("tool", "ToolSearch", "{\"query\":\"select:x\"}"), mcp("app_chat_set_title"), mcp("app_artifact_read"), mcp("app_artifact_read"), mcp("app_scripts_list"),
    shell("Look for the old chat's stored artifacts on disk", "node look.mjs"),
    shell("Listing artifact tables in the app database (read-only)", "sqlite3 -readonly app.db '.tables'"),
    step("tool", "Reading /tmp/ex3190/known-issues-v21.md"),
    shell("Checking the Pythia prod pods now", "kubectl get pods"),
    step("tool", "Reading /tmp/ex3190/known-issues-v21.md"), step("tool", "Reading /tmp/ex3190/known-issues-new.md")
  ];
  const blocks = claudeStepBlocks(events);
  assert.equal(blocks.length, 1);
  assert.equal(claudeStepSummary(events), "Read 2 files, called accord_agents 4 times, ran 3 shell commands");
});

test("an edit, a new file, a web search, a fetch and a subagent are lines of their own and end the fold", () => {
  const events = [
    shell("Running tests", "npm test"), step("file-edit", "Update(src/a.ts)"), step("file-edit", "Write(src/b.ts)"),
    step("tool", "Reading src/a.ts"), step("web", "Web Search(\"pears\")"), step("web", "Fetch(https://a.example)"), step("tool", "Agent(Check the docs)"),
    step("status", "Running in the background: Run the soak"), shell("Running lint", "npm run lint")
  ];
  assert.deepEqual(claudeStepBlocks(events).map((block) => block.fold ? claudeStepSummary(block.events) : block.event.label), [
    "Ran 1 shell command", "Update(src/a.ts)", "Write(src/b.ts)", "Read 1 file", "Web Search(\"pears\")", "Fetch(https://a.example)", "Agent(Check the docs)",
    "Running in the background: Run the soak", "Ran 1 shell command"
  ]);
});

test("a shell command counts as a read, a search or a listing by the CLI's own rule", () => {
  const says = (command: string) => claudeStepSummary([shell("Doing it", command)]);
  assert.equal(says("cat a.txt | head -20"), "Read 1 file");
  assert.equal(says("ls -la src && echo done"), "Listed 1 directory");
  assert.equal(says("rg -n foo src | sort | uniq -c"), "Searched for 1 pattern");
  assert.equal(says("grep -rn x . 2>/dev/null | wc -l"), "Searched for 1 pattern");
  assert.equal(says("cat > out.txt <<'E'\nhello\nE"), "Ran 1 shell command");
  assert.equal(says("echo hi > out.txt"), "Ran 1 shell command");
  assert.equal(says("sort -o out.txt in.txt"), "Ran 1 shell command");
  assert.equal(says("find . -name '*.tmp' -delete"), "Ran 1 shell command");
  assert.equal(says("grep 'a > b' notes.md"), "Searched for 1 pattern");
  assert.equal(says("git status"), "Ran 1 shell command");
  assert.equal(says("echo hi"), "Ran 1 shell command");
  assert.equal(claudeStepSummary([step("command", "Running command")]), "Ran 1 shell command", "a step kept without its command");
});

test("several servers are named once each, and steps the CLI does not count say nothing", () => {
  assert.equal(claudeStepSummary([mcp("app_memory_read"), step("tool", "claude.ai Linear - list_issues (MCP)"), step("tool", "claude.ai Linear - get_issue (MCP)")]),
    "Called accord_agents, claude.ai Linear 3 times");
  assert.equal(claudeStepSummary([mcp("app_memory_read")]), "Called accord_agents");
  assert.equal(claudeStepSummary([step("tool", "ToolSearch"), step("tool", "Thinking")]), "");
  assert.equal(claudeStepSummary([step("tool", "Searching for foo"), step("tool", "Finding **/*.ts"), step("tool", "Reading a.ts")]), "Searched for 2 patterns, read 1 file");
});
