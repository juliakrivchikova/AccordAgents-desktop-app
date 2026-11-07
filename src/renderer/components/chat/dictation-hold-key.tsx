import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, X } from "lucide-react";

import { isHoldKeyEvent, spacedDictation, type SpeechHoldKey } from "../../../shared/speechToText";
import { useSpeechToTextState } from "../../app/use-speech-to-text";
import { useDictation } from "./use-dictation";

/** Held this long alone, the key starts dictation; sooner, or with another
 *  key, it is the usual Option (a shortcut or a special character). */
export const HOLD_TO_DICTATE_MS = 300;
/** The window with text that had nowhere to go closes after this. */
const RESULT_VISIBLE_MS = 8_000;
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", ""]);

type Target =
  | { kind: "field"; element: HTMLTextAreaElement | HTMLInputElement; start: number; end: number }
  | { kind: "editable"; element: HTMLElement; range?: Range };

/**
 * Dictation by holding a key while the app is in front: the text goes where
 * the cursor was when she pressed it, or, when no field had the cursor, into
 * a small window she can copy it from.
 */
export function DictationHoldKey(): JSX.Element | null {
  const state = useSpeechToTextState();
  const holdKey: SpeechHoldKey = state?.status === "ready" ? state.holdKey : "off";
  const [result, setResult] = useState<string>();
  const targetRef = useRef<Target>();
  const dictation = useDictation({
    session: "hold-key",
    onText: (text) => {
      const target = targetRef.current;
      targetRef.current = undefined;
      let inserted = false;
      try {
        inserted = target ? insertInto(target, text) : false;
      } catch {
        inserted = false;
      }
      // Never lost: what could not be typed in waits to be copied.
      if (!inserted) setResult(text);
    }
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  useEffect(() => {
    if (holdKey === "off") return undefined;
    let timer: number | undefined;
    let holding = false;
    let released = false;
    const cancel = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const finish = (): void => {
      cancel();
      if (!holding) return;
      holding = false;
      released = true;
      void dictationRef.current.stop();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isHoldKeyEvent(holdKey, event)) {
        // Another key while waiting: a shortcut such as Option+arrow.
        cancel();
        return;
      }
      if (event.repeat || holding || timer !== undefined) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (dictationRef.current.phase !== "idle") return;
      const target = currentTarget();
      timer = window.setTimeout(() => {
        timer = undefined;
        holding = true;
        released = false;
        targetRef.current = target;
        setResult(undefined);
        void dictationRef.current.start().then(() => {
          // Let go while the microphone was still starting.
          if (released) void dictationRef.current.stop();
        });
      }, HOLD_TO_DICTATE_MS);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isHoldKeyEvent(holdKey, event)) finish();
    };
    // Switching away while holding never leaves the microphone on.
    const onBlur = (): void => finish();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      finish();
    };
  }, [holdKey]);

  const keyName = holdKey === "right-option" ? "right Option" : "Option";
  return (
    <>
      {/* This dictation is only ever started by the key. */}
      {dictation.phase !== "idle" || dictation.notice ? (
        <div className="dictation-hold-pill" role="status" data-testid="dictation-hold-status">
          {dictation.phase === "recording" ? (
            <>
              <span className="composer-dictation-dot" aria-hidden />
              <span className="dictation-hold-time">{formatElapsed(dictation.seconds)}</span>
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
      {result !== undefined ? <DictationResult text={result} onClose={() => setResult(undefined)} /> : null}
    </>
  );
}

/** Text that had no field to go into: copy it, or close; it closes by
 *  itself after a few seconds unless the pointer is on it. */
function DictationResult(props: { text: string; onClose: () => void }): JSX.Element {
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setTimeout(() => onCloseRef.current(), RESULT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, props.text]);
  return (
    <div
      className="dictation-result"
      role="dialog"
      aria-label="Dictated text"
      data-testid="dictation-result"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="dictation-result-head">
        <span>No text field was selected. Copy the text, or click a field before you dictate.</span>
        <button type="button" className="dictation-result-close" aria-label="Close" data-paused={paused || undefined} onClick={props.onClose}>
          <svg viewBox="0 0 24 24" aria-hidden className="dictation-result-ring">
            <circle cx="12" cy="12" r="10.5" key={paused ? "paused" : props.text} />
          </svg>
          <X size={12} aria-hidden />
        </button>
      </div>
      <p className="dictation-result-text" data-testid="dictation-result-text">{props.text}</p>
      <div className="dictation-result-actions">
        <button
          type="button"
          className="dictation-result-copy"
          data-testid="dictation-result-copy"
          onClick={() => {
            void navigator.clipboard.writeText(props.text).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          <Copy size={13} aria-hidden />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** The field that has the cursor now, if text can be typed into it. */
function currentTarget(): Target | undefined {
  const element = document.activeElement;
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type))) {
    if (element.readOnly || element.disabled) return undefined;
    return { kind: "field", element, start: element.selectionStart ?? element.value.length, end: element.selectionEnd ?? element.value.length };
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    const selection = window.getSelection();
    return { kind: "editable", element, range: selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined };
  }
  return undefined;
}

/**
 * Types the text where the cursor was, as if typed: the field's own input
 * handling runs, and Undo takes it out again. False when the field is gone.
 */
export function insertInto(target: Target, text: string): boolean {
  const { element } = target;
  if (!element.isConnected) return false;
  const wasFocused = document.activeElement === element;
  element.focus();
  if (target.kind === "field") {
    const field = target.element;
    const start = wasFocused ? field.selectionStart ?? target.start : Math.min(target.start, field.value.length);
    const end = wasFocused ? field.selectionEnd ?? target.end : Math.min(target.end, field.value.length);
    const insert = spacedDictation(field.value.slice(0, start), field.value.slice(end), text);
    if (!insert) return true;
    field.setSelectionRange(start, end);
    if (!typeText(insert)) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
      setter?.call(field, `${field.value.slice(0, start)}${insert}${field.value.slice(end)}`);
      field.setSelectionRange(start + insert.length, start + insert.length);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }
  if (!wasFocused && target.range) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(target.range);
  }
  return typeText(text.trim());
}

/** Typing through the browser keeps Undo and the field's own handling. */
function typeText(text: string): boolean {
  return typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
