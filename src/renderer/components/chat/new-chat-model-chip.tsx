import { useCallback, useState } from "react";

import type { MainSessionProviderOption } from "../../../shared/mainSessionProviders";
import type { ChatParticipant } from "../../../shared/types";
import { NEW_CHAT_MAIN_SESSION_PARTICIPANT_ID } from "./chat-main-session-draft";
import { ChatModelAccessPanel, type ChatModelAccessPatch } from "./chat-model-access-picker";
import type { ChatParticipantDraft } from "./chat-participant-drafts";
import { ChatMemberModelChipLabel } from "./chat-sessions-composer";
import { useCloseOnOutside, useNewChatMenuMaxHeight } from "./new-chat-menu-hooks";

/**
 * The New chat composer's model chip in the sessions view, as T3 Code's
 * composer has it (the User, 2026-11-21): the provider's glyph, the model and
 * the effort ("✳ Opus 5.5 High"); it opens the compact picker, where the
 * provider is chosen too. What is chosen is this chat's main session only;
 * Settings → General keeps its own provider.
 */
export function NewChatModelChip(props: {
  draft: ChatParticipantDraft;
  provider: MainSessionProviderOption;
  providers: readonly MainSessionProviderOption[];
  onProviderChange: (option: MainSessionProviderOption) => void;
  onChange: (patch: ChatModelAccessPatch) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const rootRef = useCloseOnOutside<HTMLDivElement>(open, close);
  const maxHeight = useNewChatMenuMaxHeight(rootRef, open);
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
    <div className="new-chat-model-picker" ref={rootRef}>
      <button
        type="button"
        className="chat-model-chip new-chat-model-trigger"
        data-testid="new-chat-model-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Model and settings"
        title="Model and settings"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <ChatMemberModelChipLabel participant={member} />
      </button>
      {open && (
        <div
          className="new-chat-menu new-chat-model-menu"
          role="menu"
          style={maxHeight === undefined ? undefined : { maxHeight }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <ChatModelAccessPanel
            value={member}
            providers={props.providers}
            onProviderChange={props.onProviderChange}
            onChange={props.onChange}
            runsOn={{}}
            testId="new-chat-model-picker"
          />
        </div>
      )}
    </div>
  );
}
