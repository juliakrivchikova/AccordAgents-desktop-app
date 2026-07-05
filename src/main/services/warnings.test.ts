import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeWarningList, sanitizeWarningText } from "../../shared/warnings";

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
