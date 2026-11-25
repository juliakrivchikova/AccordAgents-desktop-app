import type { KeyboardEvent, ReactNode } from "react";

import { Textarea } from "@/components/ui/textarea";
import { ChatComposerSendButton } from "./chat-composer-send-button";

interface ChatCardFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  submitting: boolean;
  canSend: boolean;
  onSend: () => void;
  /** Quiet actions beside the round button (Cancel). */
  children?: ReactNode;
}

/** A card's own answer, written as in the composer: one field with the
 *  composer's round button in it (the User, 2026-11-25); Enter sends it. */
export const ChatCardField = ({ value, onChange, label, placeholder, submitting, canSend, onSend, children }: ChatCardFieldProps): JSX.Element => {
  const sendOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) onSend();
  };
  return (
    <div className="chat-card-field">
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={sendOnEnter}
        className="max-h-60 min-h-5 resize-none rounded-none border-0 bg-transparent p-0 leading-5 focus-visible:border-0 focus-visible:ring-0"
        aria-label={label}
        placeholder={placeholder}
        rows={1}
        disabled={submitting}
      />
      <div className="chat-card-field-actions">
        {children}
        <ChatComposerSendButton label="Submit" canSend={canSend} draftEmpty={false} isRunning={submitting} onSend={onSend} />
      </div>
    </div>
  );
};
