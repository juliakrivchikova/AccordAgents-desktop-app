import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ChatParticipant } from "../../../shared/types";
import { AppSelect } from "../primitives";
import { Avatar } from "../avatar/avatar";
import { chatParticipantDisplayName } from "../conversation/conversation-display";
import { avatarForChatParticipant } from "./chat-avatars";

export interface ChatAccordLauncherPayload {
  facilitatorParticipantId: string;
  targetParticipantIds: string[];
  subject: string;
}

export function ChatAccordLauncherDialog(props: {
  open: boolean;
  participants: ChatParticipant[];
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (payload: ChatAccordLauncherPayload) => Promise<boolean>;
}): JSX.Element {
  const [facilitatorId, setFacilitatorId] = React.useState("");
  const [targetIds, setTargetIds] = React.useState<string[]>([]);
  const [subject, setSubject] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!props.open) {
      return;
    }
    const first = props.participants[0]?.id ?? "";
    setFacilitatorId(first);
    setTargetIds(props.participants.filter((participant) => participant.id !== first).map((participant) => participant.id));
    setSubject("");
  }, [props.open, props.participants]);

  const targetOptions = props.participants.filter((participant) => participant.id !== facilitatorId);
  const facilitator = props.participants.find((participant) => participant.id === facilitatorId);
  const validation = validationMessage(facilitatorId, targetIds, subject);
  const canSubmit = !saving && !props.disabled && !validation;

  const setFacilitator = (value: string): void => {
    setFacilitatorId(value);
    setTargetIds((current) => current.filter((id) => id !== value));
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
        facilitatorParticipantId: facilitatorId,
        targetParticipantIds: targetIds,
        subject: subject.trim()
      });
      if (started) {
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
        style={{ width: "min(560px, calc(100vw - 32px))", maxWidth: "min(560px, calc(100vw - 32px))" }}
      >
        <DialogHeader>
          <DialogTitle>Start Accord</DialogTitle>
        </DialogHeader>

        <div className="chat-accord-form">
          <div className="chat-accord-field">
            <Label htmlFor="chat-accord-facilitator">Facilitator</Label>
            <AppSelect
              value={facilitatorId}
              options={props.participants.map((participant) => ({
                value: participant.id,
                label: chatParticipantDisplayName(participant)
              }))}
              placeholder="Choose facilitator"
              ariaLabel="Accord facilitator"
              testId="chat-accord-facilitator"
              disabled={saving || props.disabled}
              onValueChange={setFacilitator}
            />
          </div>

          <div className="chat-accord-field">
            <Label>Participants</Label>
            <div className="chat-accord-target-list" data-testid="chat-accord-targets">
              {targetOptions.map((participant) => {
                const checked = targetIds.includes(participant.id);
                return (
                  <label className="chat-accord-target" key={participant.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving || props.disabled}
                      onChange={() => toggleTarget(participant.id)}
                    />
                    <Avatar className="mini-avatar" spec={avatarForChatParticipant(participant, chatParticipantDisplayName(participant))} />
                    <span>{chatParticipantDisplayName(participant)}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="chat-accord-field">
            <Label htmlFor="chat-accord-subject">Subject</Label>
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
          </div>

          <div className="chat-accord-grant-note">
            {facilitator ? chatParticipantDisplayName(facilitator) : "Facilitator"} will be allowed to request participants in this chat without approval until you change it in participant controls.
          </div>
          {validation && <div className="chat-accord-validation">{validation}</div>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} data-testid="chat-accord-start" onClick={() => void submit()}>
            {saving && <Loader2 className="chat-accord-spinner" aria-hidden />}
            Start
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
    return "Choose at least one participant.";
  }
  if (!subject.trim()) {
    return "Enter a subject.";
  }
  return undefined;
}
