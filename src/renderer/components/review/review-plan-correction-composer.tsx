import React from "react";
import { RefreshCw, SendHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResizableTextarea } from "../primitives";

export function PlanCorrectionComposer(props: {
  draft: string;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  status?: React.ReactNode;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}): JSX.Element {
  const { draft, busy, disabled = false, placeholder = "Ask for follow-up changes", status, onDraftChange, onSubmit } = props;
  const canSubmit = !busy && !disabled && Boolean(draft.trim());
  const disabledTitle = disabled && !busy ? placeholder : "Send correction";
  return (
    <div className={`plan-correction-composer ${busy ? "is-running" : ""}`} data-testid="plan-followup-composer">
      {status && <div className="plan-correction-status">{status}</div>}
      <div className="plan-correction-input-row">
        <ResizableTextarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSubmit) {
                onSubmit();
              }
            }
          }}
          rows={2}
          maxHeight={220}
          placeholder={placeholder}
          disabled={busy || disabled}
        />
        <Button
          variant="outline"
          size="icon-lg"
          className="plan-correction-submit"
          title={disabledTitle}
          aria-label={disabledTitle}
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          {busy ? <RefreshCw size={18} className="spin" /> : <SendHorizontal size={18} />}
        </Button>
      </div>
    </div>
  );
}
