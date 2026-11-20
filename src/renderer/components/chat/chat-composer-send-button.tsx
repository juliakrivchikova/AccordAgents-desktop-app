import { ArrowUp, RefreshCw, Square } from "lucide-react";

/** What the composer's button stops instead of sending, while there is
 *  nothing to send: the sessions view's main session at work (T3 Code's and
 *  Claude's Stop). */
export interface ChatComposerStop {
  label: string;
  onStop: () => void;
}

/**
 * The composer's round button. It sends the draft; while `stop` is given and
 * the draft has nothing to send, it stops that run instead, as T3 Code's and
 * Claude's composers do. Typing turns it back into Send, so a message can
 * still go to a member at work (its CLI takes it as it would).
 */
export function ChatComposerSendButton(props: {
  canSend: boolean;
  isRunning: boolean;
  onSend: () => void;
  stop?: ChatComposerStop;
}): JSX.Element {
  if (props.stop && !props.canSend) {
    return (
      <button
        type="button"
        className="composer-send-button is-stop"
        title={props.stop.label}
        aria-label={props.stop.label}
        data-testid="chat-composer-stop"
        onClick={props.stop.onStop}
      >
        <Square size={12} fill="currentColor" strokeWidth={0} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="composer-send-button"
      title="Send"
      aria-label="Send message"
      disabled={!props.canSend}
      onClick={props.onSend}
    >
      {props.isRunning ? <RefreshCw size={17} className="spin" /> : <ArrowUp size={18} strokeWidth={2.4} />}
    </button>
  );
}
