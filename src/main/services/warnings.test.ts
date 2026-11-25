import assert from "node:assert/strict";
import test from "node:test";
import { cliFailureNoticeText, sanitizeWarningList, sanitizeWarningText } from "../../shared/warnings";

test("sanitizeWarningText hides plain CLI auth diagnostics in warning notices", () => {
  const warning = [
    "@sam-codex-qa-lead: codex timed out after 1800000ms:",
    "2026-06-16T09:48:01.929525Z ERROR rmcp::transport::worker: worker quit with fatal:",
    "Transport channel closed, when AuthRequired(AuthRequiredError {",
    "www_authenticate_header: \"Bearer resource_metadata=\\\"https://mcp.slack.com/.well-known/oauth-protected-resource\\\"\" })",
    "2026-06-16T09:59:36.495248Z ERROR codex_core::tools::router: error=write_stdin failed"
  ].join(" ");

  const sanitized = sanitizeWarningText(warning);

  assert.equal(sanitized, "@sam-codex-qa-lead could not finish because the Slack MCP server needs authorization.");
  assert.doesNotMatch(sanitized, /AuthRequired|Transport channel closed|1800000ms|rmcp::transport/);
});

test("sanitizeWarningList drops obsolete confirmation-brevity retry warnings", () => {
  assert.deepEqual(sanitizeWarningList([
    "@drew-codex-engineer: rejected verbose affirmative confirmation; retried in the same chat session.",
    "@taylor-claude-engineer: still returned a verbose affirmative confirmation after retry.",
    "Other warning"
  ]), ["Other warning"]);
});

const notice = (diagnostic: string, label = "@gera"): string => cliFailureNoticeText(diagnostic, { label });

test("a failed reply says what the CLI said, as it said it", () => {
  // What Claude Code and Codex really answered on the User's Mac (debug logs
  // of 2026-09-17, 2026-09-19 and the Codex sessions of 2026-11-09).
  assert.equal(notice("You've hit your weekly limit · resets Sep 20 at 7pm (Asia/Nicosia)"), "@gera: You've hit your weekly limit · resets Sep 20 at 7pm (Asia/Nicosia)");
  assert.equal(
    notice("You've hit your monthly spend limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."),
    "@gera: You've hit your monthly spend limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."
  );
  assert.equal(
    notice("You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 17th, 2026 2:55 PM."),
    "@gera: You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 17th, 2026 2:55 PM."
  );
  assert.equal(
    notice(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'glm-5.3' model is not supported when using Codex with a ChatGPT account.", code: "model_not_found" } })),
    "@gera: The 'glm-5.3' model is not supported when using Codex with a ChatGPT account."
  );
  assert.equal(notice("API Error: 529 Overloaded"), "@gera: API Error: 529 Overloaded");
  assert.equal(notice("Claude session limit reached ∙ resets 3pm"), "@gera: Claude session limit reached ∙ resets 3pm");
  // Not the missing-program words for anything that was "not found".
  assert.equal(notice("The model `gpt-9` was not found."), "@gera: The model `gpt-9` was not found.");
  assert.equal(notice("spawn claude ENOENT"), "@gera could not start because the CLI executable is unavailable.");
  assert.equal(notice("sh: claude: command not found"), "@gera could not start because the CLI executable is unavailable.");
});

test("a CLI that ended says with what", () => {
  assert.equal(
    notice("claude warm process exited with code 1: No conversation found with session ID: 212b79a7-18e9-4b24-bc49-25dad8f6bb5e"),
    "@gera stopped before it returned a response: No conversation found with session ID: 212b79a7-18e9-4b24-bc49-25dad8f6bb5e"
  );
  assert.equal(notice("claude warm process exited with code 137"), "@gera stopped before it returned a response: Claude Code exited with code 137.");
  assert.equal(notice("codex app-server process exited after signal SIGKILL"), "@gera stopped before it returned a response: Codex was ended by SIGKILL.");
  assert.equal(notice("claude warm process exited"), "@gera stopped before it returned a response.");
  assert.equal(notice("claude warm process is not running"), "@gera stopped before it returned a response.");
  assert.equal(notice("write EPIPE"), "@gera stopped before it returned a response.");
  // Of many lines, the one that says what went wrong; never a stack.
  assert.equal(
    notice("claude warm process exited with code 1: (node:1) Warning: something\nError: Cannot load settings: bad JSON\n    at Object.load (/x/cli.js:1:2)\n    at main (/x/cli.js:9:9)"),
    "@gera stopped before it returned a response: Error: Cannot load settings: bad JSON"
  );
});

test("a turn that ended without words says so, without our internal names", () => {
  for (const diagnostic of ["Claude warm process completed without response content.", "Claude Code completed without response content."]) {
    assert.equal(notice(diagnostic), "@gera: Claude Code ended the turn without a reply.");
  }
  assert.equal(notice("claude warm process returned an error result"), "@gera: Claude Code reported an error without saying what it was.");
  assert.equal(notice("codex app-server reported an error"), "@gera: Codex reported an error without saying what it was.");
  assert.equal(notice("codex app-server turn failed"), "@gera: Codex reported an error without saying what it was.");
  assert.equal(notice("claude warm process emitted invalid JSON: {oops"), "@gera: Claude Code wrote output that could not be read.");
  assert.equal(notice(""), "@gera failed before it returned a response.");
});

test("a failure's words are one line, of bounded length, and never raw events", () => {
  const long = notice(`API Error: ${"x".repeat(5000)}`);
  assert.ok(long.length < 420, `${long.length}`);
  assert.doesNotMatch(notice("API Error: 500\n\nInternal server error\n"), /\n/);
  const raw = notice('codex failed: {"type":"thread.started","thread_id":"1"} {"type":"item.completed","aggregated_output":"secret"}');
  assert.doesNotMatch(raw, /thread_id|secret/);
});

test("a failure kept as a warning reads the same each time it is cleaned again", () => {
  for (const diagnostic of [
    "You've hit your weekly limit · resets Sep 20 at 7pm (Asia/Nicosia)",
    "Claude session limit reached ∙ resets 3pm",
    "claude warm process exited with code 1: No conversation found with session ID: 212b79a7",
    "spawn claude ENOENT",
    "quota exceeded for this account"
  ]) {
    const once = sanitizeWarningText(`@gera: ${diagnostic}`);
    assert.equal(sanitizeWarningText(once), once);
    assert.equal(once, notice(diagnostic));
  }
});
