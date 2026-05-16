# Desired Feature

## Exact Model Management for Chat Participants

Today, role-gated roster management can choose participant handles, roles, and CLI provider kinds (`codex-cli` or `claude-code`). The `model` field exists as an optional string, but it is not a fully managed capability.

Desired behavior:

- Administrators can choose the exact model for each participant when creating or changing the chat roster.
- Roster discovery exposes the actual model options available for each installed and enabled CLI provider.
- Roster change validation rejects unknown or unavailable model names before an approval card is shown.
- Approval cards display the selected model for each proposed participant.
- Applied participant records persist the chosen model and use it when launching future CLI turns.
- If a model is omitted, the app clearly falls back to the provider's configured default model.

This should be scoped per participant, not globally. A chat should be able to include multiple participants using the same CLI provider with different models.
