import { Server, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMachineInactivityQuestions } from "./use-machine-inactivity";
import { IconButton, Notice } from "../components/primitives";
import { displayNoticeText, errorText } from "../components/review/review-conversation-data";
import type { WarningNoticeEntry } from "./warnings";
import type { DismissedWarningMap } from "./storage";
import { addDismissedWarningKeys } from "./warnings";
import { persistDismissedWarnings } from "./storage";

// Errors and warnings stack in the bottom-right corner and stay until the User
// dismisses them: a CLI warning must not slip away on a timer.
export function AppNotices(props: {
  error?: string;
  warnings: WarningNoticeEntry[];
  warningScope: string;
  conversationId?: string;
  setError: (value: string | undefined) => void;
  setWarnings: React.Dispatch<React.SetStateAction<string[]>>;
  setDismissedWarningKeysByScope: React.Dispatch<React.SetStateAction<DismissedWarningMap>>;
}): JSX.Element | null {
  // Machines that stopped being used: these wait for an answer, so they have
  // no dismiss button and "Dismiss all" leaves them.
  const { setError } = props;
  const machineInactivity = useMachineInactivityQuestions(setError);
  function dismissWarnings(keys: string[]): void {
    const dismissed = keys.filter(Boolean);
    if (dismissed.length === 0) return;
    const dismissedSet = new Set(dismissed);
    props.setDismissedWarningKeysByScope((current) => {
      const next = addDismissedWarningKeys(current, props.warningScope, dismissed);
      if (next !== current) {
        persistDismissedWarnings(next);
      }
      return next;
    });
    props.setWarnings((current) => current.filter((warning) => !dismissedSet.has(displayNoticeText(warning))));
    if (props.conversationId) {
      void window.consensus.dismissConversationWarnings({
        conversationId: props.conversationId,
        warnings: dismissed
      }).catch((caught) => props.setError(errorText(caught)));
    }
  }

  const machineQuestions = machineInactivity.questions;
  if (!props.error && props.warnings.length === 0 && machineQuestions.length === 0) {
    return null;
  }

  return (
    <div className="app-notice-stack" role="region" aria-label="Notifications" data-testid="app-notice-stack">
      {props.warnings.length + (props.error ? 1 : 0) > 1 && (
        <button
          type="button"
          className="app-notice-dismiss-all"
          onClick={() => {
            dismissWarnings(props.warnings.map((warning) => warning.key));
            props.setError(undefined);
          }}
        >
          Dismiss all
        </button>
      )}
      {/* Each tinted notice sits on an opaque card, so the chat under the
          corner never shows through it. The error comes first: in a
          long stack it must not be the card scrolled out of view. */}
      {props.error && (
        <div className="app-notice-card">
          <Notice
            tone="error"
            role="alert"
            action={<IconButton label="Dismiss error" icon={X} size="xs" onClick={() => props.setError(undefined)} />}
          >
            {displayNoticeText(props.error)}
          </Notice>
        </div>
      )}
      {machineQuestions.map((question) => (
        <div className="app-notice-card" key={`machine-inactive:${question.machineId}`} data-testid="machine-inactivity-question">
          <Notice
            tone="info"
            icon={Server}
            title={`Is ${question.name} still in use?`}
          >
            <p>
              It has not been active for {question.inactiveDays} days. While it is kept, this computer keeps every chat
              change for it until it comes back. Removing it takes it out of AccordAgents; a cloud instance is not deleted.
            </p>
            <div className="app-notice-actions">
              <Button type="button" variant="outline" size="sm" data-testid="machine-inactivity-keep"
                onClick={() => machineInactivity.answer(question.machineId, "keep")}>
                Keep
              </Button>
              <Button type="button" variant="outline" size="sm" data-testid="machine-inactivity-remove"
                onClick={() => machineInactivity.answer(question.machineId, "remove")}>
                Remove
              </Button>
            </div>
          </Notice>
        </div>
      ))}
      {props.warnings.map((warning) => (
        <div className="app-notice-card" key={warning.key}>
          <Notice
            tone="warning"
            action={
              <IconButton
                label="Dismiss warning"
                icon={X}
                size="xs"
                onClick={() => dismissWarnings([warning.key])}
              />
            }
          >
            {warning.text}
          </Notice>
        </div>
      ))}
    </div>
  );
}
