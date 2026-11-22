import type { MainSessionProviderOption } from "../../../shared/mainSessionProviders";
import type { ChatParticipant } from "../../../shared/types";
import { NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID } from "./chat-main-session-draft";
import { ChatMemberComposerControls, type ChatModelAccessPatch } from "./chat-model-access-picker";
import type { ChatParticipantDraft } from "./chat-participant-drafts";

/**
 * The New chat composer's controls in the sessions view, as the main
 * composer has them (the User, 2026-11-21): the model (with the provider:
 * every ready CLI, each with its glyph), the effort, the permission mode in
 * the CLI's own terms (Codex's Plan mode beside it) and, once a machine
 * exists, where it runs; each opens its own small menu. What is chosen is
 * this chat's main session only; Settings → General keeps its own provider.
 */
export function NewChatModelChip(props: {
  draft: ChatParticipantDraft;
  provider: MainSessionProviderOption;
  providers: readonly MainSessionProviderOption[];
  onProviderChange: (option: MainSessionProviderOption) => void;
  onChange: (patch: ChatModelAccessPatch) => void;
}): JSX.Element {
  const { draft, provider } = props;
  const member: ChatParticipant = {
    id: NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID,
    handle: draft.handle,
    roleConfigId: draft.roleConfigId,
    kind: provider.kind,
    hostId: provider.hostId,
    hostLabel: provider.hostLabel,
    hostVendor: provider.hostVendor,
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    agentMode: draft.agentMode,
    permissions: draft.permissions,
    homeMachineId: draft.homeMachineId,
    cloudRun: draft.cloudRun
  };
  return (
    <div className="new-chat-model-picker">
      <ChatMemberComposerControls
        value={member}
        providers={props.providers}
        onProviderChange={props.onProviderChange}
        onChange={props.onChange}
        runsOn={{}}
        testId="new-chat-controls"
      />
    </div>
  );
}
