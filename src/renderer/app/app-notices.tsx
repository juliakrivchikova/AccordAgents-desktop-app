import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, Notice } from "../components/primitives";
import { displayNoticeText, errorText } from "../components/review/review-conversation-data";
import type { WarningNoticeEntry } from "./warnings";
import type { DismissedWarningMap } from "./storage";
import { addDismissedWarningKeys } from "./warnings";
import { persistDismissedWarnings } from "./storage";

export function AppNotices(props: {
  error?: string;
  warnings: WarningNoticeEntry[];
  warningScope: string;
  conversationId?: string;
  setError: (value: string | undefined) => void;
  setWarnings: React.Dispatch<React.SetStateAction<string[]>>;
  setDismissedWarningKeysByScope: React.Dispatch<React.SetStateAction<DismissedWarningMap>>;
}): JSX.Element {
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

  return (
    <>
      {props.error && (
        <div className="mx-3 mt-2">
          <Notice tone="error">{displayNoticeText(props.error)}</Notice>
        </div>
      )}
      {props.warnings.length > 0 && (
        <div className="mx-3 mt-2 space-y-2">
          {props.warnings.length > 1 && (
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="xs" onClick={() => dismissWarnings(props.warnings.map((warning) => warning.key))}>
                Dismiss all
              </Button>
            </div>
          )}
          {props.warnings.map((warning) => (
            <Notice
              tone="warning"
              key={warning.key}
              action={
                <IconButton
                  label="Dismiss warning"
                  icon={X}
                  size="xs"
                  tooltip="Dismiss warning"
                  onClick={() => dismissWarnings([warning.key])}
                />
              }
            >
              {warning.text}
            </Notice>
          ))}
        </div>
      )}
    </>
  );
}
