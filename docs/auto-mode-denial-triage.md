# Auto Mode Denial Triage

Use this runbook when an action succeeds in a provider's regular CLI but is denied in AccordAgents Auto mode. Do not widen permissions until the enforcing layer is identified.

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

Use the AccordAgents `cli.claude.launch` event to compare the redacted argv, cwd, session kind, add directories, and tool inventory hashes. Use `cli.claude.permission-denial` to identify native permission/classifier denials.

## Attribute the result

- **App launch/argv:** only AccordAgents passes a hard deny, different cwd, inline setting, add directory, or stale resumed configuration.
- **Provider permission/classifier:** the provider records a permission denial before the tool runs.
- **Provider sandbox or OS:** the command starts but filesystem or network isolation rejects it.
- **App server:** a first-party app tool reaches AccordAgents and server policy rejects it.
- **Unknown:** evidence is incomplete. Record exactly what is missing and keep the issue open.

If regular CLI permits the action and AccordAgents denies it, remove the smallest app-introduced delta and add that exact case as a regression test. If both behave the same, document the native setting or prompt change required; do not add an AccordAgents bypass.

## Prohibited shortcuts

Do not globally disable the sandbox, add broad home-directory write access, inject classifier allow rules, expose bearer tokens in logs, or pre-authorize provider-native tools. Those changes invalidate the parity comparison and weaken the native Auto boundary.
