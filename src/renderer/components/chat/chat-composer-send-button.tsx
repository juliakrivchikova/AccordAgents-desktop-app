import { ArrowUpIcon, SquareIcon } from "@phosphor-icons/react";
import { Spinner } from "@/components/ui/spinner";

/** What the composer's button stops instead of sending, while there is
 *  nothing to send: the sessions view's main session at work (T3 Code's and
 *  Claude's Stop). */
export interface ChatComposerStop {
  label: string;
  onStop: () => void;
}

/**
 * The composer's round button. It sends the draft; while `stop` is given and
 * the draft is empty (no text, no picture, none still loading), it stops that
 * run instead, as T3 Code's and Claude's composers do. With something typed
 * the run can still be stopped, as a CLI interrupts whatever is in its
 * prompt: Stop stands next to Send, and Send (or Enter) still sends the
 * message to the member at work (its CLI takes it as it would).
 */
export function ChatComposerSendButton(props: {
  canSend: boolean;
  /** Nothing in the draft at all: no text, no pictures (loading included). */
  draftEmpty: boolean;
  isRunning: boolean;
  onSend: () => void;
  stop?: ChatComposerStop;
}): JSX.Element {
  const stopButton = props.stop ? (
    <button
      type="button"
      className={props.draftEmpty ? "composer-send-button is-stop" : "composer-send-button is-stop is-beside-send"}
      aria-label={props.stop.label}
      data-testid="chat-composer-stop"
      onClick={props.stop.onStop}
    >
      <SquareIcon size={props.draftEmpty ? 10 : 14} weight="fill" />
    </button>
  ) : null;
  if (stopButton && props.draftEmpty) {
    return stopButton;
  }
  const sendButton = (
    <button
      type="button"
      className="composer-send-button"
      aria-label="Send message"
      disabled={!props.canSend}
      onClick={props.onSend}
    >
      {props.isRunning ? <Spinner size={14} /> : <ArrowUpIcon size={14} weight="bold" />}
    </button>
  );
  return stopButton ? <>{stopButton}{sendButton}</> : sendButton;
}
