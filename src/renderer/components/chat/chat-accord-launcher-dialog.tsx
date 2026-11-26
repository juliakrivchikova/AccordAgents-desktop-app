import React from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { CLI_PROVIDER_SETUP } from "../../../shared/cliReadiness";
import type { ChatParticipant, ChatProviderKind, EffectiveSubagentProvider } from "../../../shared/types";
import {
  type AccordLauncherPreferences,
  nextAccordSubjectHistory,
  preferredAccordFacilitator,
  reconcileAccordTargetIds
} from "../../../shared/accordLauncherPreferences";
import {
  persistAccordLauncherPreferences,
  readAccordLauncherPreferences
} from "../../app/storage";
import { AppSelect, FormRow } from "../primitives";
import { chatParticipantDisplayName, isChatAssistantParticipant } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { ChatMemberMark, ChatProviderMark, ChatSessionsPresentationContext } from "./chat-member-mark";
import { AccordMergeIcon } from "./accord-merge-icon";
import { providerLabel } from "./chat-conversation-data";
import { sessionsViewLabel, type SessionsViewNames } from "../../../shared/sessionsViewText";
import { Spinner } from "@/components/ui/spinner";
import { Delayed } from "@/components/ui/delayed";

export interface ChatAccordLauncherPayload {
  facilitatorParticipantId: string;
  targetParticipantIds: string[];
  targetProviderKinds: ChatProviderKind[];
  subject: string;
}

export function ChatAccordLauncherDialog(props: {
  open: boolean;
  participants: ChatParticipant[];
  /** A chat with a main session: its Agents-list CLIs with no member yet,
   *  each made a member when the Accord starts (accordCandidates). */
  providers?: readonly EffectiveSubagentProvider[];
  disabled?: boolean;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onOpenChange: (open: boolean) => void;
  onStart: (payload: ChatAccordLauncherPayload) => Promise<boolean>;
  /** Opened from a chat shown in the sessions view: members by provider logo. */
  sessions?: boolean;
  /** The sessions view's names (no handles there): a member by its task, the
   *  main session by its CLI alone. */
  sessionsNames?: SessionsViewNames;
}): JSX.Element {
  const participants = React.useMemo(
    () => props.participants.filter((participant) => !isChatAssistantParticipant(participant)),
    [props.participants]
  );
  const names = props.sessionsNames;
  const nameOf = (participant: ChatParticipant): string =>
    names ? sessionsViewLabel(participant.handle, names) : chatParticipantDisplayName(participant);
  const [facilitatorId, setFacilitatorId] = React.useState("");
  const [targetIds, setTargetIds] = React.useState<string[]>([]);
  const providers = props.providers ?? NO_PROVIDERS;
  const [providerKinds, setProviderKinds] = React.useState<ChatProviderKind[]>([]);
  // The CLIs offered, as a key: the list is worked out again on every update
  // of the chat, and only a change in it starts the selection over.
  const providersKey = providers.map((provider) => provider.kind).join(" ");
  const [subject, setSubject] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [preferences, setPreferences] = React.useState<AccordLauncherPreferences>(() => readAccordLauncherPreferences());

  const updatePreferences = React.useCallback((updater: (current: AccordLauncherPreferences) => AccordLauncherPreferences): void => {
    setPreferences((current) => {
      const next = updater(current);
      persistAccordLauncherPreferences(next);
      return next;
    });
  }, []);

  React.useEffect(() => {
    if (!props.open) {
      return;
    }
    const stored = readAccordLauncherPreferences();
    const facilitator = preferredAccordFacilitator(participants, stored);
    const facilitatorParticipantId = facilitator?.id ?? "";
    setPreferences(stored);
    setFacilitatorId(facilitatorParticipantId);
    setTargetIds(participants.filter((participant) => participant.id !== facilitatorParticipantId).map((participant) => participant.id));
    setProviderKinds(providersKey ? providersKey.split(" ") as ChatProviderKind[] : []);
    setSubject("");
  }, [participants, providersKey, props.open]);

  const resolvedFacilitatorId = facilitatorId || preferredAccordFacilitator(participants, preferences)?.id || "";
  const targetOptions = participants.filter((participant) => participant.id !== resolvedFacilitatorId);
  const selectedTargetIds = targetOptions.filter((participant) => targetIds.includes(participant.id)).map((participant) => participant.id);
  const facilitator = participants.find((participant) => participant.id === resolvedFacilitatorId);
  const selectedProviderKinds = providers.filter((provider) => providerKinds.includes(provider.kind)).map((provider) => provider.kind);
  const validation = validationMessage(resolvedFacilitatorId, selectedTargetIds.length + selectedProviderKinds.length, subject);
  const canSubmit = !saving && !props.disabled && !validation;

  const setFacilitator = (value: string): void => {
    setFacilitatorId(value);
    setTargetIds((current) => reconcileAccordTargetIds(current, value, participants));
    const selected = participants.find((participant) => participant.id === value);
    if (selected) {
      updatePreferences((current) => ({
        ...current,
        lastFacilitatorParticipantId: selected.id,
        lastFacilitatorHandle: selected.handle
      }));
    }
  };

  const toggleTarget = (participantId: string): void => {
    setTargetIds((current) =>
      current.includes(participantId)
        ? current.filter((id) => id !== participantId)
        : [...current, participantId]
    );
  };

  const toggleProvider = (kind: ChatProviderKind): void => {
    setProviderKinds((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind]);
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    setSaving(true);
    try {
      const started = await props.onStart({
        facilitatorParticipantId: resolvedFacilitatorId,
        targetParticipantIds: selectedTargetIds,
        targetProviderKinds: selectedProviderKinds,
        subject: subject.trim()
      });
      if (started) {
        updatePreferences((current) => ({
          ...current,
          ...(facilitator ? {
            lastFacilitatorParticipantId: facilitator.id,
            lastFacilitatorHandle: facilitator.handle
          } : {}),
          subjects: nextAccordSubjectHistory(current.subjects, subject)
        }));
        props.onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <ChatSessionsPresentationContext.Provider value={props.sessions === true}>
    <Dialog open={props.open} onOpenChange={(open) => {
      if (!saving) {
        props.onOpenChange(open);
      }
    }}>
      <DialogContent
        className="chat-accord-dialog"
        data-testid="chat-accord-dialog"
      >
        <DialogHeader className="chat-accord-header">
          <DialogTitle className="chat-accord-title">
            <AccordMergeIcon className="chat-accord-title-icon" />
            Start Accord
          </DialogTitle>
          <DialogDescription className="sr-only">
            Write the subject, choose who leads, and pick the members who will reach one decision together.
          </DialogDescription>
        </DialogHeader>

        <div className="chat-accord-form">
          <FormRow className="chat-accord-field" label="Subject" htmlFor="chat-accord-subject">
            <p className="chat-accord-hint" id="chat-accord-subject-hint">
              What should the members agree on? Each one answers on its own first, then they settle on one resolution that everyone signs.
            </p>
            <Textarea
              id="chat-accord-subject"
              className="chat-accord-subject"
              value={subject}
              rows={3}
              placeholder="Decision or topic to resolve"
              aria-describedby="chat-accord-subject-hint"
              disabled={saving || props.disabled}
              data-testid="chat-accord-subject"
              onChange={(event) => setSubject(event.currentTarget.value)}
            />
            {preferences.subjects.length > 0 && (
              <div className="chat-accord-subject-history" data-testid="chat-accord-subject-history">
                {preferences.subjects.map((recentSubject) => (
                  <button
                    type="button"
                    className="chat-accord-subject-chip"
                    disabled={saving || props.disabled}
                    title={recentSubject}
                    key={recentSubject}
                    onClick={() => setSubject(recentSubject)}
                  >
                    {recentSubject}
                  </button>
                ))}
              </div>
            )}
          </FormRow>

          <FormRow className="chat-accord-field" label="Led by">
            <p className="chat-accord-hint">
              Collects the drafts, writes the resolution and asks everyone to sign. It can ask the chosen members without your approval.
            </p>
            <AppSelect
              value={resolvedFacilitatorId}
              options={participants.map((participant) => {
                const displayName = nameOf(participant) || providerLabel(participant.kind);
                return {
                  value: participant.id,
                  label: displayName,
                  icon: <ChatMemberMark className="chat-accord-select-avatar" markClassName="is-mini" avatar={avatarForChatParticipant(participant, displayName)} member={participant} tooltip={null} />
                };
              })}
              placeholder="Choose who leads"
              ariaLabel="Accord lead"
              testId="chat-accord-facilitator"
              disabled={saving || props.disabled}
              onValueChange={setFacilitator}
            />
          </FormRow>

          <FormRow className="chat-accord-field" label={props.sessions === true ? "Sessions" : "Members"}>
            <div className="chat-accord-target-list" data-testid="chat-accord-targets">
              {targetOptions.map((participant) => {
                const checked = targetIds.includes(participant.id);
                const named = nameOf(participant);
                const displayName = named || providerLabel(participant.kind);
                return (
                  <label className={`chat-accord-target${checked ? " is-selected" : ""}`} key={participant.id}>
                    <input
                      className="chat-accord-target-checkbox"
                      type="checkbox"
                      checked={checked}
                      disabled={saving || props.disabled}
                      aria-label={`Select ${displayName}`}
                      onChange={() => toggleTarget(participant.id)}
                    />
                    <span className="chat-accord-target-check" aria-hidden="true">
                      <CheckIcon size={12} />
                    </span>
                    <ChatMemberMark className="chat-accord-target-avatar" markClassName="is-mini" avatar={avatarForChatParticipant(participant, displayName)} member={participant} tooltip={null} />
                    <span className="chat-accord-target-title" title={props.participantRoleLabel(participant)}>
                      <strong>{displayName}</strong>
                      {named && <span>- {providerLabel(participant.kind)}</span>}
                    </span>
                  </label>
                );
              })}
              {providers.map((provider) => {
                const checked = providerKinds.includes(provider.kind);
                const label = CLI_PROVIDER_SETUP[provider.kind].label;
                return (
                  <label className={`chat-accord-target${checked ? " is-selected" : ""}`} key={provider.kind} data-testid="chat-accord-new-agent">
                    <input
                      className="chat-accord-target-checkbox"
                      type="checkbox"
                      checked={checked}
                      disabled={saving || props.disabled}
                      aria-label={`Select ${label}`}
                      onChange={() => toggleProvider(provider.kind)}
                    />
                    <span className="chat-accord-target-check" aria-hidden="true">
                      <CheckIcon size={12} />
                    </span>
                    <ChatProviderMark member={{ kind: provider.kind }} className="is-mini" tile={props.sessions !== true} />
                    <span className="chat-accord-target-title" title="From the side panel's Agents list: joins the chat when the Accord starts.">
                      <strong>{label}</strong>
                      <span>- New agent</span>
                    </span>
                  </label>
                );
              })}
              {targetOptions.length === 0 && providers.length === 0 && (
                <div className="chat-accord-empty">Add another member to start Accord.</div>
              )}
            </div>
          </FormRow>
          {/* An empty subject only keeps Start Accord disabled; the hint above already says what goes there. */}
          {validation && validation !== SUBJECT_REQUIRED && <div className="chat-accord-validation">{validation}</div>}
        </div>

        <DialogFooter className="chat-accord-footer">
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} data-testid="chat-accord-start" onClick={() => void submit()}>
            {saving && <Delayed><Spinner size={14} /></Delayed>}
            Start Accord
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </ChatSessionsPresentationContext.Provider>
  );
}

const SUBJECT_REQUIRED = "Enter a subject.";

const NO_PROVIDERS: readonly EffectiveSubagentProvider[] = [];

function validationMessage(facilitatorId: string, targetCount: number, subject: string): string | undefined {
  if (!facilitatorId) {
    return "Choose who leads.";
  }
  if (targetCount === 0) {
    return "Choose at least one member.";
  }
  if (!subject.trim()) {
    return SUBJECT_REQUIRED;
  }
  return undefined;
}
