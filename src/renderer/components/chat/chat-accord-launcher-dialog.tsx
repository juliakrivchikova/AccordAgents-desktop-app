import React from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { ChatParticipant } from "../../../shared/types";
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
import { Avatar } from "../avatar/avatar";
import { chatParticipantDisplayName, isChatAssistantParticipant } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";
import { providerLabel } from "./chat-conversation-data";

export interface ChatAccordLauncherPayload {
  facilitatorParticipantId: string;
  targetParticipantIds: string[];
  subject: string;
}

export function ChatAccordLauncherDialog(props: {
  open: boolean;
  participants: ChatParticipant[];
  disabled?: boolean;
  participantRoleLabel: (participant: ChatParticipant) => string;
  onOpenChange: (open: boolean) => void;
  onStart: (payload: ChatAccordLauncherPayload) => Promise<boolean>;
}): JSX.Element {
  const participants = React.useMemo(
    () => props.participants.filter((participant) => !isChatAssistantParticipant(participant)),
    [props.participants]
  );
  const [facilitatorId, setFacilitatorId] = React.useState("");
  const [targetIds, setTargetIds] = React.useState<string[]>([]);
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
    setSubject("");
  }, [participants, props.open]);

  const resolvedFacilitatorId = facilitatorId || preferredAccordFacilitator(participants, preferences)?.id || "";
  const targetOptions = participants.filter((participant) => participant.id !== resolvedFacilitatorId);
  const selectedTargetIds = targetOptions.filter((participant) => targetIds.includes(participant.id)).map((participant) => participant.id);
  const facilitator = participants.find((participant) => participant.id === resolvedFacilitatorId);
  const validation = validationMessage(resolvedFacilitatorId, selectedTargetIds, subject);
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

  const submit = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    setSaving(true);
    try {
      const started = await props.onStart({
        facilitatorParticipantId: resolvedFacilitatorId,
        targetParticipantIds: selectedTargetIds,
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
          <DialogTitle>Start Accord</DialogTitle>
          <DialogDescription>
            Pick the facilitator, the members to include, and the decision to resolve.
          </DialogDescription>
        </DialogHeader>

        <div className="chat-accord-form">
          <FormRow
            className="chat-accord-field"
            label="Facilitator"
            hint={`${facilitator ? chatParticipantDisplayName(facilitator) : "The facilitator"} can request selected members in this chat without another approval.`}
          >
            <AppSelect
              value={resolvedFacilitatorId}
              options={participants.map((participant) => ({
                value: participant.id,
                label: chatParticipantDisplayName(participant)
              }))}
              placeholder="Choose facilitator"
              ariaLabel="Accord facilitator"
              testId="chat-accord-facilitator"
              disabled={saving || props.disabled}
              onValueChange={setFacilitator}
            />
          </FormRow>

          <FormRow className="chat-accord-field" label="Members">
            <div className="chat-accord-target-list" data-testid="chat-accord-targets">
              {targetOptions.map((participant) => {
                const checked = targetIds.includes(participant.id);
                const displayName = chatParticipantDisplayName(participant);
                return (
                  <div className={`chat-accord-target${checked ? " is-selected" : ""}`} key={participant.id}>
                    <button
                      type="button"
                      className="chat-accord-target-main"
                      disabled={saving || props.disabled}
                      aria-pressed={checked}
                      onClick={() => toggleTarget(participant.id)}
                    >
                      <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant, displayName)} />
                      <span className="chat-accord-target-text">
                        <span className="chat-accord-target-title">
                          <strong>{displayName}</strong>
                          <span>- {providerLabel(participant.kind)}</span>
                        </span>
                        <small>{props.participantRoleLabel(participant)}</small>
                      </span>
                    </button>
                    <ChevronDown className="chat-accord-target-chevron" size={16} aria-hidden />
                    <input
                      className="chat-accord-target-checkbox"
                      type="checkbox"
                      checked={checked}
                      disabled={saving || props.disabled}
                      aria-label={`Select ${displayName}`}
                      onChange={() => toggleTarget(participant.id)}
                    />
                  </div>
                );
              })}
              {targetOptions.length === 0 && (
                <div className="chat-accord-empty">Add another member to start Accord.</div>
              )}
            </div>
          </FormRow>

          <FormRow className="chat-accord-field" label="Subject" htmlFor="chat-accord-subject">
            <Textarea
              id="chat-accord-subject"
              className="chat-accord-subject"
              value={subject}
              rows={4}
              style={{ minHeight: 112 }}
              placeholder="Decision or topic to resolve"
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
          {validation && <div className="chat-accord-validation">{validation}</div>}
        </div>

        <DialogFooter className="chat-accord-footer">
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} data-testid="chat-accord-start" onClick={() => void submit()}>
            {saving && <Loader2 className="chat-accord-spinner" aria-hidden />}
            Start Accord
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function validationMessage(facilitatorId: string, targetIds: string[], subject: string): string | undefined {
  if (!facilitatorId) {
    return "Choose a facilitator.";
  }
  if (targetIds.length === 0) {
    return "Choose at least one member.";
  }
  if (!subject.trim()) {
    return "Enter a subject.";
  }
  return undefined;
}
