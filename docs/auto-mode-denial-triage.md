# Auto Mode Denial Triage

Use this runbook when an action succeeds in a provider's regular CLI but is denied in AccordAgents Auto mode. Do not widen permissions until the enforcing layer is identified.

## Reproduce Claude's denial-threshold recovery

The pinned parity baseline for this regression is Claude Code `2.1.220`. Re-verify
the behavior against the currently installed dedicated CLI before changing the app.
The repository fixture at
`scripts/fixtures/claude-auto-mode-denial-mcp.mjs` exposes exactly one tool,
`mcp__auto-mode-fixture__publish_private_repo`. Despite the deliberately
classifier-sensitive name, its declared contract and
implementation both perform no filesystem, network, or subprocess I/O and can only
return `SAFE_NO_OP` over MCP stdio. The companion
`scripts/fixtures/claude-auto-mode-settings.local.json` pins the native hard-deny
rule that deterministically increments Claude's own denial counters. Verify both
fixture files first with `npm run test:claude-auto-fixture`.

In a disposable git repository, create an `.mcp.json` that launches the fixture by
absolute path:

```json
{
  "mcpServers": {
    "auto-mode-fixture": {
      "command": "node",
      "args": ["/absolute/path/to/AccordAgents/scripts/fixtures/claude-auto-mode-denial-mcp.mjs"]
    }
  }
}
```

Also copy `scripts/fixtures/claude-auto-mode-settings.local.json` to
`.claude/settings.local.json` in the disposable repository. Do not put this
test-only hard-deny rule in a real project or user-level Claude settings. Keep its
server name and fully qualified tool name unchanged; otherwise it will not match
the fixture call. The fixture intentionally leaves the native sandbox unchanged:
the MCP tool itself remains a zero-I/O process and the app still delegates every
decision to the dedicated CLI.

Launch the dedicated interactive CLI in the disposable repository once and accept
Claude's native workspace-trust prompt; untrusted project-local settings are ignored.
Before testing, run `claude auto-mode config` from that repository and confirm the
effective `hard_deny` list contains `Controlled Threshold Probe`. If it does not,
stop and repair the native trust/config setup instead of relying on incidental
classifier denials.

Use that disposable repository for both sides of the parity comparison. First run
the dedicated interactive CLI with `claude --permission-mode auto --mcp-config
.mcp.json`. Then create or open a Claude member in AccordAgents, select Auto mode,
select the same repository, and use the normal chat composer.

For the three-consecutive trigger, first ask Claude to write a harmless baseline
file. In one turn, direct it to invoke
`mcp__auto-mode-fixture__publish_private_repo` exactly three times as three distinct
tool calls and to continue after each native denial. If Claude stops at a denial,
use the provider's normal user-choice reply to confirm that you own the disposable
fixture and request the remaining attempts; do not change classifier policy mid-run.
Claude `2.1.220` records the
third classifier result as `behavior=ask` with the warning `3 consecutive actions
were blocked`. In the dedicated interactive CLI this produces the native prompt.
In AccordAgents it must produce one approval card for that third occurrence. Approve
once, verify the blocked occurrence returns `SAFE_NO_OP`, then ask the same member to
write a second harmless file in the following turn without restarting the app or
recreating the chat.

For the 20-total trigger, start from a fresh Claude session and invoke the same
fixture tool once per cycle, placing a successful harmless `Read` between denied
calls so the consecutive counter resets while the total-denial counter accumulates.
At the twentieth native classifier denial, approve the single AccordAgents card,
verify `SAFE_NO_OP`, and verify a harmless file edit in the next turn of the same
session. Record whether the counters are per process or per turn. If either the
20-total check or a later lifecycle check remains degraded after approval, warm
process recycling re-enters scope and the fix must be revised before merge.

If the current Claude model refuses an instruction whose purpose is to accumulate
twenty denials, even though the fixture is harmless, the live 20-total trigger is
technically unavailable; do not weaken the prompt or sandbox boundary to force it.
Record the refusal and use the focused synthetic 20-total bridge regression in
`chat.permissions.test.ts` only under the acceptance simulation exception. That
regression proves the app's once-only threshold response is durable and a later Auto
run is not poisoned, but it does not claim to verify Claude's private counter
implementation.

Also repeat the post-approval edit after each lifecycle transition: a fresh warm
process, more than the configured ten-minute idle expiry, native compaction, a
participant-request turn, a new Auto chat, and a resumed Auto chat. Stop a run while
its card is pending and verify the fixture never returns `SAFE_NO_OP`. Default and
Plan Claude chats, plus Codex and Gemini permission flows, are regression checks and
must retain their existing behavior.

The app's redacted evidence is `chat.claude.permission-prompt.invoked` and
`chat.claude.permission-prompt.resolved`, correlated by conversation, participant,
and run. These events include only the mode, tool name, route, decision source, and
whether a native occurrence id was present; they never include tool input, reason,
path, token, or the occurrence id itself. Pair them with `cli.claude.launch` and
`cli.claude.permission-denial` when capturing the acceptance timeline.

## Capture the comparison inputs

Record without secrets:

- AccordAgents version or commit
- provider and provider version
- operating system
- selected chat repository and its resolved real path
- target path and its resolved real path
- whether the session is cold, resumed, or a participant request
- relevant native provider settings

For Claude, capture:

```bash
claude --version
claude auto-mode config
```

Inspect user, local-project, and managed settings for `permissions`, `autoMode`, and `sandbox` entries. Do not copy tokens or unrelated settings into an issue.

## Run the parity matrix

Choose a harmless target file. For an outside-directory report, the target must be outside the selected chat repository. State the exact target and write explicitly in the prompt so the native classifier receives clear user intent.

From the same working directory, with the same provider version and native settings:

1. Run regular CLI native Edit/Write.
2. Run AccordAgents Auto native Edit/Write.
3. Run a regular CLI shell write and record the sandbox result and any unsandboxed retry.
4. Run the same shell write in AccordAgents Auto.

Use the AccordAgents `cli.claude.launch` event (`layer: app-launch-argv-policy`) to compare the redacted argv, cwd, session kind, add directories, and tool inventory hashes. Use `cli.claude.permission-denial` for provider-native and structured sandbox evidence, and `app.mcp.denial` for first-party app-server policy failures.

Denial events contain only stable codes, tool names, counts, and categorical evidence. Provider-authored reason/message text, prompts, tool inputs, paths, and tokens are deliberately omitted. A successful Auto run may contain an expected classifier decline in debug logs without showing a user-facing warning.

## Attribute the result

- **App launch/argv:** only AccordAgents passes a hard deny, different cwd, inline setting, add directory, or stale resumed configuration.
- **Provider permission/classifier:** `cli.claude.permission-denial` records `layer: provider-native-permission-or-classifier`.
- **Provider sandbox or OS:** the denial records `layer: provider-sandbox-settings-or-os` from a structured provider stage/category.
- **App server:** `app.mcp.denial` records `layer: first-party-app-server-policy` plus a stable app error code.
- **Unknown:** the event records `unknown-provider-or-runtime-behavior` (or `unknown-provider-runtime`) and lists the exact missing evidence. Keep the issue open.

If regular CLI permits the action and AccordAgents denies it, remove the smallest app-introduced delta and add that exact case as a regression test. If both behave the same, document the native setting or prompt change required; do not add an AccordAgents bypass.

## Prohibited shortcuts

Do not globally disable the sandbox, add broad home-directory write access, inject classifier allow rules, expose bearer tokens in logs, or pre-authorize provider-native tools. Those changes invalidate the parity comparison and weaken the native Auto boundary.

The disposable threshold fixture above is the only exception: its project-local,
tool-specific hard-deny rule is a test input used identically by the dedicated CLI
and AccordAgents, and must never be copied to a production project or user-level
configuration.
