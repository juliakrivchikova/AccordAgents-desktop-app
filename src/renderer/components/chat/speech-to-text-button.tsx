import { useEffect, useRef } from "react";
import { Loader2, Mic, Square } from "lucide-react";

import { IconButton } from "@/renderer/components/primitives";
import { insertDictatedText } from "../../../shared/speechToText";
import { useSpeechToTextState } from "../../app/use-speech-to-text";
import { useDictation } from "./use-dictation";

/**
 * The microphone in a message field, shown once speech to text is on and its
 * model is ready. Press to record, press again to put the recognized text
 * where the caret is; nothing is sent.
 */
export function SpeechToTextButton(props: {
  /** Another chat or thread: a recording in progress is dropped. */
  session?: string;
  /** The message field. Looked up when the text arrives: the chat
   *  composer's own ref to it is not attached (its Textarea drops refs). */
  getTextarea: () => HTMLTextAreaElement | null;
  draft: string;
  onDraftChange: (value: string) => void;
}): JSX.Element | null {
  const state = useSpeechToTextState();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const keepFocusRef = useRef(false);
  const dictation = useDictation({
    session: props.session,
    onText: (text) => {
      const textarea = props.getTextarea();
      // The field as it is now: she may have typed while it was recognized.
      // A field keeps its caret while the microphone has focus.
      const draft = textarea?.value ?? props.draft;
      const next = insertDictatedText(
        draft,
        textarea?.selectionStart ?? draft.length,
        textarea?.selectionEnd ?? draft.length,
        text
      );
      keepFocusRef.current = false;
      props.onDraftChange(next.value);
      requestAnimationFrame(() => {
        const field = props.getTextarea();
        if (!field) return;
        field.focus();
        const caret = Math.min(next.caret, field.value.length);
        field.setSelectionRange(caret, caret);
      });
    }
  });

  // The microphone and the stop button take turns in one place: keyboard
  // focus follows from one to the other.
  useEffect(() => {
    if (keepFocusRef.current) buttonRef.current?.focus();
  }, [dictation.phase]);

  if (state?.status !== "ready" && dictation.phase === "idle") {
    return null;
  }
  const remember = (): void => {
    keepFocusRef.current = document.activeElement === buttonRef.current;
  };
  const notice = dictation.notice ? (
    <button
      type="button"
      className={`composer-dictation-notice${dictation.notice.kind === "error" ? " is-error" : ""}`}
      role="status"
      title="Dismiss"
      data-testid="composer-dictation-notice"
      onClick={dictation.dismissNotice}
    >
      {dictation.notice.text}
    </button>
  ) : null;
  if (dictation.phase === "recording") {
    return (
      <>
        {notice}
        <button
          ref={buttonRef}
          type="button"
          className="composer-dictation-recording"
          aria-label="Stop dictation and insert text"
          title="Stop dictation and insert text"
          data-testid="composer-dictation-stop"
          onClick={() => {
            remember();
            void dictation.stop();
          }}
        >
          <span className="composer-dictation-dot" aria-hidden />
          <span className="composer-dictation-time">{formatElapsed(dictation.seconds)}</span>
          <Square size={11} strokeWidth={2.4} aria-hidden />
        </button>
      </>
    );
  }
  const busy = dictation.phase === "starting" || dictation.phase === "recognizing";
  return (
    <>
      {notice}
      <IconButton
        ref={buttonRef}
        label={dictation.phase === "recognizing" ? "Recognizing speech…" : "Dictate"}
        icon={busy ? Loader2 : Mic}
        iconClassName={busy ? "spin" : undefined}
        aria-disabled={busy || undefined}
        data-testid="composer-dictation-start"
        data-busy={busy || undefined}
        onClick={() => {
          if (busy) return;
          remember();
          void dictation.start();
        }}
      />
    </>
  );
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
