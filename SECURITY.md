# Security Policy

## Supported versions

AccordAgents is pre-1.0. Security fixes are applied to the latest release on the
`development` line only.

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public GitHub issue
for a vulnerability.

- Use GitHub's private vulnerability reporting:
  [Report a vulnerability](https://github.com/juliakrivchikova/AccordAgents-desktop-app/security/advisories/new).

Please include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version/commit and platform.

We aim to acknowledge reports within 7 days and will keep you updated on
remediation. Please give us reasonable time to release a fix before any public
disclosure.

## Scope and notes

- API keys are stored encrypted at rest with Electron `safeStorage` and are only
  sent to the AI provider you explicitly configure.
- Conversations and debug logs are stored locally and may contain sensitive
  prompts, diffs, and model responses. Handle exported data accordingly.
- Local CLI agents (`codex`, `claude`) run in a permission-scoped sandbox of the
  selected repository: read-only by default, with file/shell/web access granted
  only through explicit per-participant approval.
