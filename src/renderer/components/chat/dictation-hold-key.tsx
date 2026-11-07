import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, X } from "lucide-react";

import { writeClipboardText } from "../../../shared/clipboard";
import {
  SPEECH_HOLD_KEY_LABELS,
  formatSpeechElapsed,
  isHoldKeyEvent,
  type SpeechHoldKey
} from "../../../shared/speechToText";
import { useSpeechToTextState } from "../../app/use-speech-to-text";
import { currentDictationTarget, insertDictation, type DictationTarget } from "./dictation-target";
import { useDictation } from "./use-dictation";

/** Held this long alone, the key starts dictation; sooner, or with another
 *  key or a click, it is the usual Option (a shortcut or a special character). */
export const HOLD_TO_DICTATE_MS = 300;
/** The window with text that had nowhere to go closes after this. */
const RESULT_VISIBLE_MS = 8_000;

/** Why the text is in the window instead of in a field. */
type ResultReason = "no-field" | "field-gone" | "interrupted";

const RESULT_REASONS: Record<ResultReason, string> = {
  "no-field": "No text field was selected. Copy the text, or click a field before you dictate.",
  "field-gone": "The text could not go back where you dictated it. Copy it from here.",
  interrupted: "Dictation was interrupted, so the text was not typed in. Copy it from here."
};

/** Where the text of the current dictation goes. */
interface Delivery {
  target?: DictationTarget;
  /** It ended without her letting go of the key here: the text is offered
   *  to copy, never typed into her message. */
  interrupted?: boolean;
}

/**
 * Dictation by holding a key while the app is in front: the text goes where
 * the cursor was when she pressed it, or, when that field is not there to take
 * it, into a small window she can copy it from.
 */
export function DictationHoldKey(): JSX.Element | null {
  const state = useSpeechToTextState();
  const holdKey: SpeechHoldKey = state?.status === "ready" ? state.holdKey : "off";
  const keyName = SPEECH_HOLD_KEY_LABELS[holdKey];
  const [result, setResult] = useState<{ id: number; text: string; reason: ResultReason }>();
  const deliveryRef = useRef<Delivery>({});
  const dictation = useDictation({
    session: "hold-key",
    onText: (text) => {
      const { target, interrupted } = deliveryRef.current;
      deliveryRef.current = {};
      let inserted = false;
      try {
        inserted = target && !interrupted ? insertDictation(target, text) : false;
      } catch {
        inserted = false;
      }
      if (inserted) return;
      // What could not be typed in waits to be copied.
      const reason: ResultReason = interrupted ? "interrupted" : target ? "field-gone" : "no-field";
      setResult((previous) => ({ id: (previous?.id ?? 0) + 1, text, reason }));
    }
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  useEffect(() => {
    if (holdKey === "off") return undefined;
    let timer: number | undefined;
    /** The key is down and dictation has begun. */
    let holding = false;
    /** The microphone is on and recording. */
    let live = false;
    /** Which hold a starting microphone belongs to: a quick second hold
     *  must not take the first one's start for its own. */
    let holds = 0;
    const cancelWait = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const end = (how: "release" | "interrupted" | "shortcut"): void => {
      cancelWait();
      if (!holding) return;
      holding = false;
      // The key was part of a shortcut (Option+arrow, Option+click), or it
      // went up before the microphone was on: nothing she said was recorded
      // yet, or what was is not hers to keep.
      if (how === "shortcut" || !live) {
        deliveryRef.current = {};
        dictationRef.current.cancel();
        if (how === "release" && !live) dictationRef.current.hint(`Hold ${keyName} until it says Listening.`);
        return;
      }
      live = false;
      if (how === "interrupted") deliveryRef.current = { ...deliveryRef.current, interrupted: true };
      void dictationRef.current.stop();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isHoldKeyEvent(holdKey, event)) {
        end("shortcut");
        return;
      }
      if (event.repeat || holding || timer !== undefined) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      const target = currentDictationTarget();
      timer = window.setTimeout(() => {
        timer = undefined;
        if (dictationRef.current.phase !== "idle") {
          // Shows why nothing records (still recognizing the last one).
          void dictationRef.current.start();
          return;
        }
        holding = true;
        live = false;
        const hold = ++holds;
        deliveryRef.current = { target };
        void dictationRef.current.start().then(() => {
          if (holding && hold === holds) live = true;
        });
      }, HOLD_TO_DICTATE_MS);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isHoldKeyEvent(holdKey, event)) end("release");
    };
    const onPointerDown = (): void => end("shortcut");
    // A release the page never heard (a menu or another app took it): the
    // next pointer move without Option ends the recording.
    const onPointerMove = (event: PointerEvent): void => {
      if (holding && !event.altKey) end("interrupted");
    };
    // Switching away while holding never leaves the microphone on.
    const onBlur = (): void => end("interrupted");
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("blur", onBlur);
      end("shortcut");
    };
  }, [holdKey, keyName]);

  const status = dictation.phase !== "idle" || dictation.notice;
  if (!status && !result) return null;
  return (
    <div className="dictation-hold-layer">
      {/* This dictation is only ever started by the key. */}
      {status ? (
        <div className="dictation-hold-pill" role="status" data-testid="dictation-hold-status">
          {dictation.phase === "recording" ? (
            <>
              <span className="composer-dictation-dot" aria-hidden />
              <span className="dictation-hold-time" aria-hidden>{formatSpeechElapsed(dictation.seconds)}</span>
              <span>Listening. Release {keyName} to insert.</span>
            </>
          ) : dictation.phase === "starting" || dictation.phase === "recognizing" ? (
            <>
              <Loader2 size={13} className="spin" aria-hidden />
              <span>{dictation.phase === "starting" ? "Starting the microphone…" : "Recognizing…"}</span>
            </>
          ) : dictation.notice ? (
            <>
              <span className={dictation.notice.kind === "error" ? "dictation-hold-error" : undefined}>{dictation.notice.text}</span>
              <button type="button" className="dictation-hold-close" aria-label="Dismiss" onClick={dictation.dismissNotice}>
                <X size={13} aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <DictationResult key={result.id} text={result.text} reason={result.reason} onClose={() => setResult(undefined)} />
      ) : null}
    </div>
  );
}

/** Text that had no field to go into: copy it, or close; it closes by
 *  itself after a few seconds unless the pointer or the keyboard is on it. */
function DictationResult(props: { text: string; reason: ResultReason; onClose: () => void }): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  // A failed copy keeps the window open: the text is still only here.
  const paused = hovered || focused || copy === "failed";
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setTimeout(() => onCloseRef.current(), RESULT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused]);
  return (
    <div
      className="dictation-result"
      role="dialog"
      aria-label="Dictated text"
      data-testid="dictation-result"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // A click on Copy focuses it too; only keyboard focus keeps it open.
      onFocus={(event) => setFocused(keyboardFocus(event.target))}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <div className="dictation-result-head">
        <span aria-live="polite">{RESULT_REASONS[props.reason]}</span>
        <button type="button" className="dictation-result-close" aria-label="Close" data-paused={paused || undefined} onClick={props.onClose}>
          <svg viewBox="0 0 24 24" aria-hidden className="dictation-result-ring">
            {/* The ring empties in the same time the window takes to close. */}
            <circle cx="12" cy="12" r="10.5" key={paused ? "paused" : "counting"} style={{ animationDuration: `${RESULT_VISIBLE_MS}ms` }} />
          </svg>
          <X size={12} aria-hidden />
        </button>
      </div>
      <p className="dictation-result-text" data-testid="dictation-result-text">{props.text}</p>
      <div className="dictation-result-actions">
        {copy === "failed" ? <span className="dictation-hold-error">Copy failed. Select the text and copy it.</span> : null}
        <button
          type="button"
          className="dictation-result-copy"
          data-testid="dictation-result-copy"
          onClick={() => {
            void writeClipboardText(props.text, (value) => navigator.clipboard.writeText(value)).then(setCopy);
          }}
        >
          <Copy size={13} aria-hidden />
          {copy === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function keyboardFocus(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}
